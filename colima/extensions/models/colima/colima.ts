/**
 * Model: @whitemars/colima
 *
 * Manage the lifecycle of a Colima VM (https://github.com/abiosoft/colima) by
 * wrapping the `colima` CLI. One model instance targets one Colima profile via
 * `globalArguments.profile` (default "default"); create additional instances for
 * additional profiles.
 *
 * Methods:
 *   - start   : start / provision the VM (cpus, memory, disk, arch, runtime, vmType)
 *   - stop    : stop the VM (optional --force)
 *   - restart : restart the VM (optional --force)
 *   - delete  : delete and tear down the VM (destructive; always -f)
 *   - sync    : refresh stored VM state from `colima list` / `colima status`
 *   - exec    : run a shell command inside the VM (`colima ssh -- ...`)
 *
 * The `start`/`stop`/`restart`/`sync` methods write a "status" resource; `exec`
 * writes an "exec" resource. `delete` removes the "status" resource and returns
 * no data.
 *
 * @module
 */
import { z } from "npm:zod@4.4.3";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  profile: z.string().default("default").describe(
    "Colima profile this instance manages (colima -p). Default: default.",
  ),
  cpus: z.number().int().positive().optional().describe(
    "Number of CPUs to provision on start (colima --cpu).",
  ),
  memory: z.number().positive().optional().describe(
    "Memory in GiB to provision on start (colima --memory).",
  ),
  disk: z.number().int().positive().optional().describe(
    "Disk size in GiB to provision on start (colima --disk).",
  ),
  arch: z.enum(["x86_64", "aarch64"]).optional().describe(
    "VM architecture (colima --arch).",
  ),
  runtime: z.enum(["docker", "containerd", "incus"]).optional().describe(
    "Container runtime (colima --runtime).",
  ),
  vmType: z.enum(["qemu", "vz"]).optional().describe(
    "Virtual machine type (colima --vm-type).",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const StatusSchema = z.object({
  profile: z.string(),
  status: z.string().describe("Running | Stopped | Broken | not_found"),
  arch: z.string().optional(),
  cpus: z.number().optional(),
  memory: z.number().optional().describe(
    "Memory in bytes, as reported by colima",
  ),
  disk: z.number().optional().describe("Disk in bytes, as reported by colima"),
  runtime: z.string().optional(),
  driver: z.string().optional(),
  ipAddress: z.string().optional(),
  dockerSocket: z.string().optional(),
  kubernetes: z.boolean().optional(),
  mountType: z.string().optional(),
  displayName: z.string().optional(),
  syncedAt: z.string(),
});

type StatusData = z.infer<typeof StatusSchema>;

const ExecSchema = z.object({
  profile: z.string(),
  command: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  success: z.boolean(),
  ranAt: z.string(),
});

// ---------------------------------------------------------------------------
// colima CLI helpers
// ---------------------------------------------------------------------------

interface ColimaResult {
  code: number;
  stdout: string;
  stderr: string;
  success: boolean;
}

type Log = (msg: string) => void;

/** Invoke the `colima` binary and capture stdout/stderr. */
async function runColima(args: string[], log?: Log): Promise<ColimaResult> {
  log?.(`colima ${args.join(" ")}`);
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command("colima", {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (e) {
    throw new Error(
      `Failed to invoke 'colima' — is Colima installed and on PATH? ` +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
  }
  // Derive success from the exit code rather than output.success so the same
  // logic holds under the test command mock (which supplies only code).
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    success: output.code === 0,
  };
}

/** Throw a descriptive error if a colima invocation failed. */
function assertOk(result: ColimaResult, action: string): void {
  if (!result.success) {
    const detail = result.stderr.trim() || result.stdout.trim() ||
      "no output";
    throw new Error(`${action} failed (exit ${result.code}): ${detail}`);
  }
}

/** Parse the first line of `text` that is a JSON object, or null. */
function firstJsonObject(text: string): Record<string, unknown> | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not JSON, keep scanning
    }
  }
  return null;
}

/**
 * Gather the current state of `profile` from `colima list --json` (NDJSON, one
 * object per profile), enriched with `colima status --json` details when the VM
 * is running. Returns a `not_found` marker when the profile does not exist.
 */
async function gatherStatus(profile: string, log?: Log): Promise<StatusData> {
  const syncedAt = new Date().toISOString();
  const list = await runColima(["list", "--json"], log);

  let entry: Record<string, unknown> | null = null;
  if (list.success) {
    for (const line of list.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        if (obj.name === profile) {
          entry = obj;
          break;
        }
      } catch {
        // skip malformed line
      }
    }
  }

  if (!entry) {
    return { profile, status: "not_found", syncedAt };
  }

  const result: StatusData = {
    profile,
    status: typeof entry.status === "string" ? entry.status : "unknown",
    arch: typeof entry.arch === "string" ? entry.arch : undefined,
    cpus: typeof entry.cpus === "number" ? entry.cpus : undefined,
    memory: typeof entry.memory === "number" ? entry.memory : undefined,
    disk: typeof entry.disk === "number" ? entry.disk : undefined,
    runtime: typeof entry.runtime === "string" ? entry.runtime : undefined,
    syncedAt,
  };

  if (result.status.toLowerCase() === "running") {
    const status = await runColima(
      ["status", "-p", profile, "-e", "--json"],
      log,
    );
    // colima writes the JSON to stdout; fall back to stderr defensively.
    const detail = firstJsonObject(status.stdout) ??
      firstJsonObject(status.stderr);
    if (detail) {
      if (typeof detail.driver === "string") result.driver = detail.driver;
      if (typeof detail.ip_address === "string") {
        result.ipAddress = detail.ip_address;
      }
      if (typeof detail.docker_socket === "string") {
        result.dockerSocket = detail.docker_socket;
      }
      if (typeof detail.kubernetes === "boolean") {
        result.kubernetes = detail.kubernetes;
      }
      if (typeof detail.mount_type === "string") {
        result.mountType = detail.mount_type;
      }
      if (typeof detail.display_name === "string") {
        result.displayName = detail.display_name;
      }
    }
  }

  return result;
}

/** Build the `colima start` argument list from provisioning global args. */
function startArgs(g: GlobalArgs): string[] {
  const args = ["start", "-p", g.profile];
  if (g.cpus !== undefined) args.push("--cpu", String(g.cpus));
  if (g.memory !== undefined) args.push("--memory", String(g.memory));
  if (g.disk !== undefined) args.push("--disk", String(g.disk));
  if (g.arch !== undefined) args.push("--arch", g.arch);
  if (g.runtime !== undefined) args.push("--runtime", g.runtime);
  if (g.vmType !== undefined) args.push("--vm-type", g.vmType);
  return args;
}

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

type WriteResource = (
  spec: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;

interface WriteContext {
  globalArgs: GlobalArgs;
  logger?: { info: (msg: string) => void };
  writeResource: WriteResource;
  deleteResource?: (name: string) => Promise<void>;
}

interface MethodResult {
  dataHandles: Array<{ name: string }>;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Model definition for managing a Colima VM profile via the `colima` CLI. */
export const model = {
  type: "@whitemars/colima",
  version: "2026.07.24.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    status: {
      description: "Current state of the Colima VM for this profile.",
      schema: StatusSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    exec: {
      description:
        "Result of the last command run inside the VM via colima ssh.",
      schema: ExecSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  checks: {
    "colima-installed": {
      description: "Ensure the `colima` binary is available on PATH.",
      labels: ["dependency"],
      execute: async (): Promise<{ pass: boolean; errors?: string[] }> => {
        try {
          const result = await new Deno.Command("colima", {
            args: ["version"],
            stdout: "piped",
            stderr: "piped",
          }).output();
          if (!result.success) {
            return {
              pass: false,
              errors: [
                "`colima version` returned non-zero — is Colima installed?",
              ],
            };
          }
          return { pass: true };
        } catch (e) {
          return {
            pass: false,
            errors: [
              `colima binary not found on PATH: ` +
              `${e instanceof Error ? e.message : String(e)}`,
            ],
          };
        }
      },
    },
  },
  methods: {
    start: {
      description:
        "Start (and provision) the Colima VM for this profile, then record its status.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: WriteContext,
      ): Promise<MethodResult> => {
        const g = context.globalArgs;
        const log: Log = (m) => context.logger?.info(m);
        log(`Starting Colima profile '${g.profile}'`);
        assertOk(
          await runColima(startArgs(g), log),
          `colima start (${g.profile})`,
        );
        const status = await gatherStatus(g.profile, log);
        const handle = await context.writeResource("status", "status", status);
        log(`Colima profile '${g.profile}' is ${status.status}`);
        return { dataHandles: [handle] };
      },
    },
    stop: {
      description:
        "Stop the Colima VM for this profile, then record its status.",
      arguments: z.object({
        force: z.boolean().default(false).describe(
          "Stop without graceful shutdown (colima stop --force).",
        ),
      }),
      execute: async (
        args: { force: boolean },
        context: WriteContext,
      ): Promise<MethodResult> => {
        const profile = context.globalArgs.profile;
        const log: Log = (m) => context.logger?.info(m);
        log(`Stopping Colima profile '${profile}'`);
        // Idempotent: only issue `colima stop` when the VM is actually running.
        // Stopping an already-stopped or absent profile is a no-op success.
        const current = await gatherStatus(profile, log);
        if (current.status.toLowerCase() !== "running") {
          log(`Colima profile '${profile}' already ${current.status} — no-op`);
          const handle = await context.writeResource(
            "status",
            "status",
            current,
          );
          return { dataHandles: [handle] };
        }
        const cargs = ["stop", "-p", profile];
        if (args.force) cargs.push("-f");
        assertOk(await runColima(cargs, log), `colima stop (${profile})`);
        const status = await gatherStatus(profile, log);
        const handle = await context.writeResource("status", "status", status);
        log(`Colima profile '${profile}' is ${status.status}`);
        return { dataHandles: [handle] };
      },
    },
    restart: {
      description:
        "Restart the Colima VM for this profile, then record its status.",
      arguments: z.object({
        force: z.boolean().default(false).describe(
          "During restart, stop without graceful shutdown (colima restart --force).",
        ),
      }),
      execute: async (
        args: { force: boolean },
        context: WriteContext,
      ): Promise<MethodResult> => {
        const profile = context.globalArgs.profile;
        const log: Log = (m) => context.logger?.info(m);
        log(`Restarting Colima profile '${profile}'`);
        const cargs = ["restart", "-p", profile];
        if (args.force) cargs.push("-f");
        assertOk(await runColima(cargs, log), `colima restart (${profile})`);
        const status = await gatherStatus(profile, log);
        const handle = await context.writeResource("status", "status", status);
        log(`Colima profile '${profile}' is ${status.status}`);
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description:
        "Delete and tear down the Colima VM for this profile (destructive).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: WriteContext,
      ): Promise<MethodResult> => {
        const profile = context.globalArgs.profile;
        const log: Log = (m) => context.logger?.info(m);
        log(`Deleting Colima profile '${profile}'`);
        // Idempotent: if the profile is already gone, skip `colima delete`
        // (which errors on an unknown profile) and treat it as success.
        const current = await gatherStatus(profile, log);
        if (current.status === "not_found") {
          log(`Colima profile '${profile}' already absent — no-op`);
        } else {
          assertOk(
            await runColima(["delete", "-p", profile, "-f"], log),
            `colima delete (${profile})`,
          );
        }
        // The VM is gone — drop the stored status so it doesn't read stale.
        if (context.deleteResource) await context.deleteResource("status");
        log(`Colima profile '${profile}' deleted`);
        return { dataHandles: [] };
      },
    },
    sync: {
      description:
        "Refresh stored VM state from `colima list` / `colima status`.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: WriteContext,
      ): Promise<MethodResult> => {
        const profile = context.globalArgs.profile;
        const log: Log = (m) => context.logger?.info(m);
        log(`Syncing state for Colima profile '${profile}'`);
        const status = await gatherStatus(profile, log);
        const handle = await context.writeResource("status", "status", status);
        log(`Colima profile '${profile}' is ${status.status}`);
        return { dataHandles: [handle] };
      },
    },
    exec: {
      description:
        "Run a shell command inside the Colima VM (colima ssh -- sh -c <command>). " +
        "Captures stdout, stderr, and the exit code — a non-zero exit is recorded, not thrown.",
      arguments: z.object({
        command: z.string().describe(
          "Shell command to run inside the VM, e.g. 'docker ps' or 'uname -a'.",
        ),
      }),
      execute: async (
        args: { command: string },
        context: WriteContext,
      ): Promise<MethodResult> => {
        const profile = context.globalArgs.profile;
        const log: Log = (m) => context.logger?.info(m);
        log(`Running command in Colima profile '${profile}': ${args.command}`);
        const result = await runColima([
          "ssh",
          "-p",
          profile,
          "--",
          "sh",
          "-c",
          args.command,
        ], log);
        log(`Command in '${profile}' exited ${result.code}`);
        const handle = await context.writeResource("exec", "exec", {
          profile,
          command: args.command,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.code,
          success: result.success,
          ranAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
