/**
 * Model: @whitemars/incus
 *
 * Container (and VM) lifecycle for an Incus daemon, driven through the local
 * `incus` CLI. One model instance targets one daemon/project pair; each method
 * maps to an `incus` subcommand:
 *
 *   - launch   -> incus launch <image> <name>   (create + start)
 *   - start    -> incus start <name>
 *   - stop     -> incus stop <name> [--force]
 *   - restart  -> incus restart <name> [--force]
 *   - delete   -> incus delete <name> [--force]
 *   - sync     -> incus list --format json       (factory: one resource/instance)
 *
 * Mutating methods re-query the single instance afterwards and write its fresh
 * state to the `container` resource, so downstream CEL can read live data
 * without a separate sync. `sync` is a factory: it writes one `container`
 * resource per discovered instance plus a `summary` roll-up.
 *
 * Commands run via Deno.Command with argv arrays (never a shell), so shell
 * metacharacters carry no meaning. Instance/remote/project/profile names are
 * still validated against Incus's allowed character set — this rejects values
 * beginning with "-" that could otherwise be mistaken for flags.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Incus instance names follow DNS-label rules: start with a letter, then
// letters/digits/hyphens, max 63 chars. This also blocks leading "-" (flag
// injection) and any whitespace.
const INSTANCE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]{0,62}$/;
// Remote, project, and profile names: start alphanumeric, then a limited set.
const IDENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

function assertInstanceName(name: string): void {
  if (!INSTANCE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid instance name "${name}": must start with a letter and contain ` +
        `only letters, digits, and hyphens (max 63 chars).`,
    );
  }
}

function assertIdent(kind: string, value: string): void {
  if (!IDENT_RE.test(value)) {
    throw new Error(
      `Invalid ${kind} "${value}": must start with an alphanumeric and contain ` +
        `only letters, digits, dots, hyphens, and underscores.`,
    );
  }
}

// ---------------------------------------------------------------------------
// CLI helper
// ---------------------------------------------------------------------------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

type Log = (msg: string) => void;

// Run the incus CLI with an argv array. No shell is involved, so arguments are
// passed verbatim to the process and shell metacharacters are inert.
async function runIncus(args: string[], log?: Log): Promise<RunResult> {
  log?.(`incus ${args.join(" ")}`);
  const command = new Deno.Command("incus", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const decoder = new TextDecoder();
  return {
    code,
    stdout: decoder.decode(stdout),
    stderr: decoder.decode(stderr),
  };
}

// Run incus and throw a descriptive error on a non-zero exit code.
async function runIncusChecked(args: string[], log?: Log): Promise<RunResult> {
  const result = await runIncus(args, log);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      `incus ${args.join(" ")} failed (exit ${result.code}): ${detail}`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Target / project helpers
// ---------------------------------------------------------------------------

interface Conn {
  remote: string; // "" means the local daemon
  project: string;
}

// Build the "[remote:]name" positional argument.
function target(conn: Conn, name: string): string {
  return conn.remote ? `${conn.remote}:${name}` : name;
}

// Project flag, applied per-subcommand.
function projectArgs(conn: Conn): string[] {
  return ["--project", conn.project];
}

// ---------------------------------------------------------------------------
// Instance normalization
// ---------------------------------------------------------------------------

// The subset of `incus list --format json` we depend on. The CLI emits far more
// than this; unknown fields are ignored.
interface RawInstance {
  name: string;
  type?: string;
  status?: string;
  status_code?: number;
  architecture?: string;
  ephemeral?: boolean;
  created_at?: string;
  last_used_at?: string;
  location?: string;
  profiles?: string[];
  config?: Record<string, string>;
  state?: {
    network?:
      | Record<
        string,
        {
          addresses?: Array<
            { family?: string; address?: string; scope?: string }
          >;
        }
      >
      | null;
  } | null;
}

interface NormalizedInstance {
  name: string;
  type: string;
  status: string;
  statusCode: number | null;
  architecture: string | null;
  ephemeral: boolean;
  project: string;
  remote: string;
  profiles: string[];
  ipv4: string[];
  ipv6: string[];
  image: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  location: string | null;
  syncedAt: string;
}

// Pull global (non-loopback) v4/v6 addresses out of the per-interface state.
function extractAddresses(
  raw: RawInstance,
): { ipv4: string[]; ipv6: string[] } {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  const network = raw.state?.network ?? {};
  for (const iface of Object.values(network)) {
    for (const addr of iface?.addresses ?? []) {
      if (!addr.address || addr.scope !== "global") continue;
      if (addr.family === "inet") ipv4.push(addr.address);
      else if (addr.family === "inet6") ipv6.push(addr.address);
    }
  }
  return { ipv4, ipv6 };
}

function normalize(
  raw: RawInstance,
  conn: Conn,
  syncedAt: string,
): NormalizedInstance {
  const { ipv4, ipv6 } = extractAddresses(raw);
  const config = raw.config ?? {};
  return {
    name: raw.name,
    type: raw.type ?? "unknown",
    status: raw.status ?? "Unknown",
    statusCode: raw.status_code ?? null,
    architecture: raw.architecture ?? null,
    ephemeral: raw.ephemeral ?? false,
    project: conn.project,
    remote: conn.remote,
    profiles: raw.profiles ?? [],
    ipv4,
    ipv6,
    image: config["image.description"] ?? config["image.os"] ?? null,
    createdAt: raw.created_at ?? null,
    lastUsedAt: raw.last_used_at ?? null,
    location: raw.location ?? null,
    syncedAt,
  };
}

// List instances, optionally filtered to a single name. Returns [] if a
// name filter matches nothing (incus exits 0 with an empty array).
async function listInstances(
  conn: Conn,
  name: string | null,
  log?: Log,
): Promise<RawInstance[]> {
  const positional: string[] = [];
  if (conn.remote) positional.push(`${conn.remote}:`);
  if (name) positional.push(name);
  const result = await runIncusChecked(
    ["list", ...positional, ...projectArgs(conn), "--format", "json"],
    log,
  );
  const parsed = JSON.parse(result.stdout || "[]");
  if (!Array.isArray(parsed)) return [];
  return parsed as RawInstance[];
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  remote: z
    .string()
    .default("")
    .describe(
      'Incus remote name (empty targets the local daemon, e.g. "prod")',
    ),
  project: z
    .string()
    .default("default")
    .describe("Incus project the instances live in"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ContainerSchema = z.object({
  name: z.string(),
  type: z.string(),
  status: z.string(),
  statusCode: z.number().nullable(),
  architecture: z.string().nullable(),
  ephemeral: z.boolean(),
  project: z.string(),
  remote: z.string(),
  profiles: z.array(z.string()),
  ipv4: z.array(z.string()),
  ipv6: z.array(z.string()),
  image: z.string().nullable(),
  createdAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  location: z.string().nullable(),
  syncedAt: z.string(),
});

const SummarySchema = z.object({
  remote: z.string(),
  project: z.string(),
  total: z.number(),
  running: z.number(),
  stopped: z.number(),
  frozen: z.number(),
  other: z.number(),
  instances: z.array(z.string()),
  syncedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Execute context
// ---------------------------------------------------------------------------

interface ExecContext {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  logger?: { info: (msg: string) => void };
}

type ExecResult = { dataHandles: Array<{ name: string }> };

function connOf(context: ExecContext): Conn {
  const remote = context.globalArgs.remote ?? "";
  const project = context.globalArgs.project ?? "default";
  if (remote) assertIdent("remote", remote);
  assertIdent("project", project);
  return { remote, project };
}

// Re-query one instance after a mutation and persist its fresh state.
async function writeInstanceState(
  conn: Conn,
  name: string,
  context: ExecContext,
  log: Log,
): Promise<ExecResult> {
  const syncedAt = new Date().toISOString();
  const found = (await listInstances(conn, name, log)).find((i) =>
    i.name === name
  );
  if (!found) {
    log(`Instance "${name}" not found after operation; no state written.`);
    return { dataHandles: [] };
  }
  const handle = await context.writeResource(
    "container",
    name,
    normalize(found, conn, syncedAt) as unknown as Record<string, unknown>,
  );
  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Incus container/VM lifecycle model backed by the `incus` CLI. */
export const model = {
  type: "@whitemars/incus",
  version: "2026.07.23.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    container: {
      description:
        "State of a single Incus instance (container or VM): status, type, " +
        "addresses, profiles, and metadata.",
      schema: ContainerSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    summary: {
      description:
        "Roll-up of all instances in the targeted remote/project: counts by " +
        "status and the list of instance names.",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    launch: {
      description:
        "Create and start an instance from an image (incus launch). Idempotent " +
        "start is via the start method; launch fails if the name already exists.",
      arguments: z.object({
        name: z.string().describe("Instance name to create"),
        image: z
          .string()
          .describe(
            'Image to launch, e.g. "images:debian/12" or "ubuntu:24.04"',
          ),
        vm: z
          .boolean()
          .default(false)
          .describe("Launch as a virtual machine instead of a container"),
        ephemeral: z
          .boolean()
          .default(false)
          .describe("Ephemeral instance (deleted when stopped)"),
        profiles: z
          .array(z.string())
          .default([])
          .describe("Profiles to apply (--profile), in order"),
        config: z
          .array(z.string())
          .default([])
          .describe(
            'Config overrides as "key=value" (-c), e.g. "limits.cpu=2"',
          ),
      }),
      execute: async (
        args: {
          name: string;
          image: string;
          vm: boolean;
          ephemeral: boolean;
          profiles: string[];
          config: string[];
        },
        context: ExecContext,
      ): Promise<ExecResult> => {
        const conn = connOf(context);
        const log: Log = (m) => context.logger?.info(m);
        assertInstanceName(args.name);

        if (
          /\s/.test(args.image) || args.image.startsWith("-") || !args.image
        ) {
          throw new Error(`Invalid image "${args.image}".`);
        }
        for (const p of args.profiles) assertIdent("profile", p);
        for (const c of args.config) {
          if (!/^[\w.-]+=.*/.test(c) || /[\n\r]/.test(c)) {
            throw new Error(
              `Invalid config entry "${c}"; expected "key=value".`,
            );
          }
        }

        const cliArgs = [
          "launch",
          args.image,
          target(conn, args.name),
          ...projectArgs(conn),
        ];
        for (const p of args.profiles) cliArgs.push("--profile", p);
        for (const c of args.config) cliArgs.push("-c", c);
        if (args.vm) cliArgs.push("--vm");
        if (args.ephemeral) cliArgs.push("--ephemeral");

        await runIncusChecked(cliArgs, log);
        log(`Launched "${args.name}" from ${args.image}.`);
        return writeInstanceState(conn, args.name, context, log);
      },
    },

    start: {
      description: "Start a stopped instance (incus start).",
      arguments: z.object({
        name: z.string().describe("Instance name to start"),
      }),
      execute: async (
        args: { name: string },
        context: ExecContext,
      ): Promise<ExecResult> => {
        const conn = connOf(context);
        const log: Log = (m) => context.logger?.info(m);
        assertInstanceName(args.name);
        await runIncusChecked([
          "start",
          target(conn, args.name),
          ...projectArgs(conn),
        ], log);
        log(`Started "${args.name}".`);
        return writeInstanceState(conn, args.name, context, log);
      },
    },

    stop: {
      description: "Stop a running instance (incus stop).",
      arguments: z.object({
        name: z.string().describe("Instance name to stop"),
        force: z
          .boolean()
          .default(false)
          .describe("Force-stop without a clean shutdown (--force)"),
      }),
      execute: async (
        args: { name: string; force: boolean },
        context: ExecContext,
      ): Promise<ExecResult> => {
        const conn = connOf(context);
        const log: Log = (m) => context.logger?.info(m);
        assertInstanceName(args.name);
        const cliArgs = ["stop", target(conn, args.name), ...projectArgs(conn)];
        if (args.force) cliArgs.push("--force");
        await runIncusChecked(cliArgs, log);
        log(`Stopped "${args.name}"${args.force ? " (forced)" : ""}.`);
        return writeInstanceState(conn, args.name, context, log);
      },
    },

    restart: {
      description: "Restart an instance (incus restart).",
      arguments: z.object({
        name: z.string().describe("Instance name to restart"),
        force: z
          .boolean()
          .default(false)
          .describe("Force-restart without a clean shutdown (--force)"),
      }),
      execute: async (
        args: { name: string; force: boolean },
        context: ExecContext,
      ): Promise<ExecResult> => {
        const conn = connOf(context);
        const log: Log = (m) => context.logger?.info(m);
        assertInstanceName(args.name);
        const cliArgs = [
          "restart",
          target(conn, args.name),
          ...projectArgs(conn),
        ];
        if (args.force) cliArgs.push("--force");
        await runIncusChecked(cliArgs, log);
        log(`Restarted "${args.name}"${args.force ? " (forced)" : ""}.`);
        return writeInstanceState(conn, args.name, context, log);
      },
    },

    delete: {
      description:
        "Delete an instance (incus delete). Idempotent: a missing instance is a " +
        "no-op. A running instance requires force; otherwise a clear error is raised.",
      arguments: z.object({
        name: z.string().describe("Instance name to delete"),
        force: z
          .boolean()
          .default(false)
          .describe("Delete even if running (--force)"),
      }),
      execute: async (
        args: { name: string; force: boolean },
        context: ExecContext,
      ): Promise<ExecResult> => {
        const conn = connOf(context);
        const log: Log = (m) => context.logger?.info(m);
        assertInstanceName(args.name);

        const existing = (await listInstances(conn, args.name, log)).find(
          (i) => i.name === args.name,
        );
        if (!existing) {
          log(`Instance "${args.name}" does not exist; nothing to delete.`);
          return { dataHandles: [] };
        }
        const running = (existing.status ?? "").toLowerCase() === "running";
        if (running && !args.force) {
          throw new Error(
            `Instance "${args.name}" is running. Pass force=true to delete it, ` +
              `or stop it first.`,
          );
        }
        const cliArgs = [
          "delete",
          target(conn, args.name),
          ...projectArgs(conn),
        ];
        if (args.force) cliArgs.push("--force");
        await runIncusChecked(cliArgs, log);
        log(`Deleted "${args.name}".`);
        return { dataHandles: [] };
      },
    },

    sync: {
      description:
        "List every instance in the targeted remote/project (incus list). " +
        "Factory: writes one `container` resource per instance plus a `summary`.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecContext,
      ): Promise<ExecResult> => {
        const conn = connOf(context);
        const log: Log = (m) => context.logger?.info(m);
        const syncedAt = new Date().toISOString();

        const raw = await listInstances(conn, null, log);
        const instances = raw.map((r) => normalize(r, conn, syncedAt));

        const handles: Array<{ name: string }> = [];
        for (const inst of instances) {
          handles.push(
            await context.writeResource(
              "container",
              inst.name,
              inst as unknown as Record<string, unknown>,
            ),
          );
        }

        const byStatus = (s: string) =>
          instances.filter((i) => i.status.toLowerCase() === s).length;
        const summary = {
          remote: conn.remote,
          project: conn.project,
          total: instances.length,
          running: byStatus("running"),
          stopped: byStatus("stopped"),
          frozen: byStatus("frozen"),
          other: instances.length - byStatus("running") - byStatus("stopped") -
            byStatus("frozen"),
          instances: instances.map((i) => i.name),
          syncedAt,
        };
        handles.push(
          await context.writeResource("summary", "summary", summary),
        );
        log(
          `Synced ${instances.length} instance(s) from project "${conn.project}".`,
        );
        return { dataHandles: handles };
      },
    },
  },
};
