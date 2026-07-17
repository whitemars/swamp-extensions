import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  staleHours: z.number().default(24).describe(
    "Hours after which a node is considered stale",
  ),
  criticalHours: z.number().default(168).describe(
    "Hours after which a node is considered critical (no check-in within this window)",
  ),
  knifeConfigPath: z.string().optional().describe(
    "Path to knife.rb config file",
  ),
  knifeBinary: z.string().optional().describe(
    "knife executable to invoke (e.g. knife or cinc-knife). Auto-detected when unset: prefers cinc-knife, falls back to knife.",
  ),
});

const NodeHealthSchema = z.object({
  name: z.string(),
  environment: z.string().optional(),
  ip: z.string().optional(),
  platform: z.string().optional(),
  platformVersion: z.string().optional(),
  ohaiTime: z.number().nullable().optional(),
  healthStatus: z.string(),
  lastCheckin: z.string().nullable().optional(),
  policyName: z.string().nullable().optional(),
  policyGroup: z.string().nullable().optional(),
});

const SummarySchema = z.object({
  total: z.number(),
  ok: z.number(),
  stale: z.number(),
  critical: z.number(),
  neverConverged: z.number(),
});

const NodeDetailSchema = z.object({
  name: z.string(),
  chefEnvironment: z.string().optional(),
  policyName: z.string().nullable().optional(),
  policyGroup: z.string().nullable().optional(),
  runList: z.array(z.string()).optional(),
  platform: z.string().optional(),
  platformVersion: z.string().optional(),
  ip: z.string().optional(),
  ohaiTime: z.number().nullable().optional(),
  lastCheckin: z.string().nullable().optional(),
  healthStatus: z.string(),
  tags: z.array(z.string()).optional(),
});

const OutputSchema = z.object({
  nodes: z.array(NodeHealthSchema),
  summary: SummarySchema,
  timestamp: z.string(),
  filter: z.string().optional(),
});

const PackageEntrySchema = z.object({
  name: z.string(),
  version: z.string(),
  arch: z.string().optional(),
  status: z.string().optional(),
  foundVersion: z.string().optional(),
});

const PackageCheckSchema = z.object({
  packageName: z.string(),
  group: z.string().optional(),
  minVersion: z.string().optional(),
  timestamp: z.string(),
  installed: z.array(PackageEntrySchema),
  current: z.array(PackageEntrySchema).optional(),
  outdated: z.array(PackageEntrySchema).optional(),
  missing: z.array(z.object({ name: z.string() })),
  summary: z.object({
    total: z.number(),
    installed: z.number(),
    current: z.number().optional(),
    outdated: z.number().optional(),
    missing: z.number(),
  }),
});

const SearchResultSchema = z.object({
  query: z.string(),
  index: z.string(),
  attributes: z.array(z.string()).optional(),
  timestamp: z.string(),
  total: z.number(),
  rows: z.array(z.object({
    name: z.string(),
    attributes: z.record(z.string(), z.unknown()),
  })),
});

const GroupInfoSchema = z.object({
  action: z.string(),
  timestamp: z.string(),
  groups: z.array(z.string()).optional(),
  group: z.string().optional(),
  members: z.object({
    actors: z.array(z.string()).optional(),
    users: z.array(z.string()).optional(),
    clients: z.array(z.string()).optional(),
    groups: z.array(z.string()).optional(),
  }).optional(),
});

const AclPermSchema = z.object({
  actors: z.array(z.string()).optional(),
  users: z.array(z.string()).optional(),
  clients: z.array(z.string()).optional(),
  groups: z.array(z.string()).optional(),
});

const AclInfoSchema = z.object({
  objectType: z.string(),
  objectName: z.string(),
  timestamp: z.string(),
  perms: z.object({
    create: AclPermSchema.optional(),
    read: AclPermSchema.optional(),
    update: AclPermSchema.optional(),
    delete: AclPermSchema.optional(),
    grant: AclPermSchema.optional(),
  }),
});

/** Global arguments for the CINC model: staleness thresholds and knife configuration. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** A single node's classified health record, as produced by fetchNodeHealth. */
type NodeHealth = z.infer<typeof NodeHealthSchema>;

/** Execution context passed to each method: global args, logger, and resource writer. */
export interface MethodContext {
  globalArgs: GlobalArgs;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

function parseVersion(v: string): number[] {
  return v.split(".").map((s) => {
    const n = parseInt(s, 10);
    return isNaN(n) ? 0 : n;
  });
}

function compareVersions(a: number[], b: number[]): number {
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    const an = a[i] ?? 0;
    const bn = b[i] ?? 0;
    if (an > bn) return 1;
    if (an < bn) return -1;
  }
  return 0;
}

function extractVersion(pkgName: string): string | null {
  const match = pkgName.match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
  return match ? match[1] : null;
}

// Resolves the knife executable once per process. Honors an explicit
// knifeBinary global arg, otherwise prefers the CINC build (cinc-knife) and
// falls back to plain knife, so the model works on both distributions.
let cachedKnife: string | null = null;
async function resolveKnife(globalArgs: GlobalArgs): Promise<string> {
  if (globalArgs.knifeBinary) return globalArgs.knifeBinary;
  if (cachedKnife) return cachedKnife;
  for (const candidate of ["cinc-knife", "knife"]) {
    try {
      const probe = await new Deno.Command(candidate, {
        args: ["--version"],
        stdout: "null",
        stderr: "null",
      }).output();
      if (probe.success) {
        cachedKnife = candidate;
        return candidate;
      }
    } catch (_e) {
      // not on PATH — try the next candidate
    }
  }
  // Nothing detected; default to knife so the resulting error is descriptive.
  cachedKnife = "knife";
  return cachedKnife;
}

// Builds the argv for a knife invocation, appending `-c <config>` when the
// knifeConfigPath global arg is set.
function knifeArgs(globalArgs: GlobalArgs, args: string[]): string[] {
  const out = [...args];
  if (globalArgs.knifeConfigPath) {
    out.push("-c", globalArgs.knifeConfigPath);
  }
  return out;
}

// Runs knife and returns stdout, throwing with stderr on non-zero exit.
async function runKnife(
  globalArgs: GlobalArgs,
  args: string[],
  errorLabel: string,
): Promise<string> {
  const bin = await resolveKnife(globalArgs);
  const proc = await new Deno.Command(bin, {
    args: knifeArgs(globalArgs, args),
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (!proc.success) {
    const stderr = new TextDecoder().decode(proc.stderr);
    throw new Error(`${errorLabel} failed: ${stderr}`);
  }
  return new TextDecoder().decode(proc.stdout);
}

function classifyHealth(
  ohaiTime: number | null | undefined,
  staleThreshold: number,
  criticalThreshold: number,
): string {
  if (ohaiTime === null || ohaiTime === undefined) return "never_converged";
  if (ohaiTime >= staleThreshold) return "ok";
  if (ohaiTime >= criticalThreshold) return "stale";
  return "critical";
}

/**
 * Fetches health for every node in a SINGLE `knife search node "*:*"` call.
 *
 * `knife status` is itself a search over the node index whose "last check-in"
 * is the node's `ohai_time` automatic attribute, so requesting `ohai_time`
 * here returns the identical value. Pulling the platform and policy attributes
 * in the same query means the whole fleet's health comes back in ONE server
 * round-trip, replacing the previous two calls (`knife status` plus a separate
 * policy `knife search`). With `-a`, knife returns rows keyed by node name,
 * each holding only the requested attributes — so every display field must be
 * requested explicitly.
 */
async function fetchNodeHealth(globalArgs: GlobalArgs): Promise<NodeHealth[]> {
  const now = Math.floor(Date.now() / 1000);
  const staleThreshold = now - (globalArgs.staleHours ?? 24) * 3600;
  const criticalThreshold = now - (globalArgs.criticalHours ?? 168) * 3600;

  const stdout = await runKnife(
    globalArgs,
    [
      "search",
      "node",
      "*:*",
      "-a",
      "ohai_time",
      "-a",
      "chef_environment",
      "-a",
      "ipaddress",
      "-a",
      "platform",
      "-a",
      "platform_version",
      "-a",
      "policy_name",
      "-a",
      "policy_group",
      "-F",
      "json",
    ],
    "knife search",
  );
  const data = JSON.parse(stdout);

  const health: NodeHealth[] = [];
  for (const row of data.rows ?? []) {
    for (
      const [name, attrs] of Object.entries(row as Record<string, unknown>)
    ) {
      const a = (attrs ?? {}) as Record<string, unknown>;
      const ohaiTime = (a.ohai_time as number | null | undefined) ?? null;
      health.push({
        name,
        environment: a.chef_environment as string | undefined,
        ip: a.ipaddress as string | undefined,
        platform: a.platform as string | undefined,
        platformVersion: a.platform_version as string | undefined,
        ohaiTime,
        healthStatus: classifyHealth(
          ohaiTime,
          staleThreshold,
          criticalThreshold,
        ),
        lastCheckin: ohaiTime != null
          ? new Date(ohaiTime * 1000).toISOString()
          : null,
        policyName: a.policy_name as string | null | undefined,
        policyGroup: a.policy_group as string | null | undefined,
      });
    }
  }
  return health;
}

/**
 * CINC/Chef node model. Wraps `knife` to report node health, inspect nodes,
 * run searches, check package installations, and read groups and ACLs.
 */
export const model = {
  type: "@whitemars/cinc",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.17.1",
      description:
        "status/filter now fetch node health in a single knife search; no globalArguments change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    "nodeHealth": {
      description: "Chef/CINC node health report",
      schema: OutputSchema,
      lifetime: "1d",
      garbageCollection: 10,
    },
    "nodeDetail": {
      description: "Detailed info for a specific node",
      schema: NodeDetailSchema,
      lifetime: "1d",
      garbageCollection: 10,
    },
    "packageCheck": {
      description: "Package installation check across nodes",
      schema: PackageCheckSchema,
      lifetime: "1d",
      garbageCollection: 10,
    },
    "searchResult": {
      description: "Results of a knife search query",
      schema: SearchResultSchema,
      lifetime: "1d",
      garbageCollection: 10,
    },
    "groupInfo": {
      description: "Chef/CINC server group listing or membership",
      schema: GroupInfoSchema,
      lifetime: "1d",
      garbageCollection: 10,
    },
    "aclInfo": {
      description: "Access control list for a Chef/CINC server object",
      schema: AclInfoSchema,
      lifetime: "1d",
      garbageCollection: 10,
    },
  },
  methods: {
    status: {
      description:
        "Query the Chef/CINC server and return health for every node in a single knife search",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        context.logger.info("Querying node health via knife search");
        const nodeHealth = await fetchNodeHealth(context.globalArgs);

        const summary = {
          total: nodeHealth.length,
          ok: nodeHealth.filter((n) => n.healthStatus === "ok").length,
          stale: nodeHealth.filter((n) => n.healthStatus === "stale").length,
          critical:
            nodeHealth.filter((n) => n.healthStatus === "critical").length,
          neverConverged:
            nodeHealth.filter((n) => n.healthStatus === "never_converged")
              .length,
        };

        const output = {
          nodes: nodeHealth,
          summary,
          timestamp: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "nodeHealth",
          "current",
          output as unknown as Record<string, unknown>,
        );
        context.logger.info("Node health report written: {*}", summary);
        return { dataHandles: [handle] };
      },
    },
    show: {
      description:
        "Show detailed info for a specific node via `knife node show`",
      arguments: z.object({
        nodeName: z.string().describe("Name of the node to inspect"),
      }),
      execute: async (args: { nodeName: string }, context: MethodContext) => {
        context.logger.info("Showing node detail for {nodeName}", {
          nodeName: args.nodeName,
        });
        const stdout = await runKnife(
          context.globalArgs,
          ["node", "show", args.nodeName, "-F", "json"],
          `knife node show for ${args.nodeName}`,
        );
        const data = JSON.parse(stdout);

        const ohaiTime = data.ohai_time ?? null;
        const normal = data.normal ?? {};

        const now = Math.floor(Date.now() / 1000);
        const staleThreshold = now -
          (context.globalArgs.staleHours ?? 24) * 3600;
        const criticalThreshold = now -
          (context.globalArgs.criticalHours ?? 168) * 3600;
        const healthStatus = classifyHealth(
          ohaiTime,
          staleThreshold,
          criticalThreshold,
        );

        const detail = {
          name: data.name,
          chefEnvironment: data.chef_environment,
          policyName: data.policy_name,
          policyGroup: data.policy_group,
          runList: data.run_list ?? [],
          platform: data.platform ?? normal.platform,
          platformVersion: data.platform_version ?? normal.platform_version,
          ip: data.ip,
          ohaiTime,
          lastCheckin: ohaiTime != null
            ? new Date(ohaiTime * 1000).toISOString()
            : null,
          healthStatus,
          tags: normal.tags ?? [],
        };

        const instanceName = `detail-${args.nodeName}`;
        const handle = await context.writeResource(
          "nodeDetail",
          instanceName,
          detail as unknown as Record<string, unknown>,
        );
        context.logger.info("Node detail written for {nodeName}: {*}", {
          nodeName: args.nodeName,
          healthStatus,
        });
        return { dataHandles: [handle] };
      },
    },
    search: {
      description:
        "Run a `knife search` query against an index (default: node) and return matching rows",
      arguments: z.object({
        query: z.string().describe(
          "Search query, e.g. 'name:web*' or 'policy_group:union'",
        ),
        index: z.string().default("node").describe(
          "Search index (node, role, environment, client, or a data bag name)",
        ),
        attributes: z.array(z.string()).optional().describe(
          "Attributes to return for each match (e.g. platform, ipaddress)",
        ),
      }),
      execute: async (
        args: { query: string; index: string; attributes?: string[] },
        context: MethodContext,
      ) => {
        context.logger.info("Running knife search {*}", {
          index: args.index,
          query: args.query,
        });
        const knifeCmd = ["search", args.index, args.query, "-F", "json"];
        for (const attr of args.attributes ?? []) {
          knifeCmd.push("-a", attr);
        }

        const stdout = await runKnife(
          context.globalArgs,
          knifeCmd,
          "knife search",
        );
        const data = JSON.parse(stdout);

        const rows: Array<
          { name: string; attributes: Record<string, unknown> }
        > = [];
        for (const row of data.rows ?? []) {
          if (args.attributes && args.attributes.length > 0) {
            // With -a, knife returns { nodeName: { attr: value, ... } }
            for (
              const [name, attrs] of Object.entries(
                row as Record<string, unknown>,
              )
            ) {
              rows.push({
                name,
                attributes: (attrs as Record<string, unknown>) ?? {},
              });
            }
          } else {
            // Without -a, each row is the full object; surface its name + body
            const obj = row as Record<string, unknown>;
            const name = (obj.name as string) ?? (obj.id as string) ?? "";
            rows.push({ name, attributes: obj });
          }
        }

        const output = {
          query: args.query,
          index: args.index,
          attributes: args.attributes,
          timestamp: new Date().toISOString(),
          total: typeof data.total === "number" ? data.total : rows.length,
          rows,
        };

        const safeQuery = args.query.replace(/[^a-zA-Z0-9_-]/g, "_").slice(
          0,
          60,
        );
        const instanceName = `search-${args.index}-${safeQuery}`;
        const handle = await context.writeResource(
          "searchResult",
          instanceName,
          output as unknown as Record<string, unknown>,
        );
        context.logger.info("Search returned {total} row(s)", {
          total: output.total,
        });
        return { dataHandles: [handle] };
      },
    },
    group: {
      description:
        "List server groups or show a group's members via `knife group` (knife-acl plugin)",
      arguments: z.object({
        action: z.enum(["list", "show"]).default("list").describe(
          "'list' all groups or 'show' one group's members",
        ),
        group: z.string().optional().describe(
          "Group name (required when action=show)",
        ),
      }),
      execute: async (
        args: { action: "list" | "show"; group?: string },
        context: MethodContext,
      ) => {
        context.logger.info("Running knife group {*}", {
          action: args.action,
          group: args.group,
        });
        if (args.action === "show") {
          if (!args.group) {
            throw new Error("group is required when action=show");
          }
          const stdout = await runKnife(
            context.globalArgs,
            ["group", "show", args.group, "-F", "json"],
            `knife group show for ${args.group}`,
          );
          const data = JSON.parse(stdout);
          const members = (data.members ?? data) as Record<string, unknown>;
          const output = {
            action: "show",
            timestamp: new Date().toISOString(),
            group: args.group,
            members: {
              actors: members.actors as string[] | undefined,
              users: members.users as string[] | undefined,
              clients: members.clients as string[] | undefined,
              groups: members.groups as string[] | undefined,
            },
          };
          const handle = await context.writeResource(
            "groupInfo",
            `group-${args.group}`,
            output as unknown as Record<string, unknown>,
          );
          context.logger.info("Group membership written for {group}", {
            group: args.group,
          });
          return { dataHandles: [handle] };
        }

        const stdout = await runKnife(context.globalArgs, [
          "group",
          "list",
          "-F",
          "json",
        ], "knife group list");
        const parsed = JSON.parse(stdout);
        const groups = Array.isArray(parsed)
          ? parsed
          : (parsed.groups ?? Object.keys(parsed));
        const output = {
          action: "list",
          timestamp: new Date().toISOString(),
          groups: groups as string[],
        };
        const handle = await context.writeResource(
          "groupInfo",
          "group-list",
          output as unknown as Record<string, unknown>,
        );
        context.logger.info("Group list written: {count} group(s)", {
          count: groups.length,
        });
        return { dataHandles: [handle] };
      },
    },
    acl: {
      description:
        "Show the ACL for a server object via `knife acl show` (knife-acl plugin)",
      arguments: z.object({
        objectType: z.enum([
          "nodes",
          "groups",
          "clients",
          "roles",
          "environments",
          "cookbooks",
          "data",
          "containers",
        ]).describe("Type of object to inspect"),
        objectName: z.string().describe(
          "Name of the object (e.g. a node name or group name)",
        ),
      }),
      execute: async (
        args: { objectType: string; objectName: string },
        context: MethodContext,
      ) => {
        context.logger.info("Showing ACL for {objectType} {objectName}", {
          objectType: args.objectType,
          objectName: args.objectName,
        });
        const stdout = await runKnife(
          context.globalArgs,
          ["acl", "show", args.objectType, args.objectName, "-F", "json"],
          `knife acl show for ${args.objectType} ${args.objectName}`,
        );
        const data = JSON.parse(stdout) as Record<string, unknown>;

        const pickPerm = (key: string) => {
          const p = data[key] as Record<string, unknown> | undefined;
          if (!p) return undefined;
          return {
            actors: p.actors as string[] | undefined,
            users: p.users as string[] | undefined,
            clients: p.clients as string[] | undefined,
            groups: p.groups as string[] | undefined,
          };
        };

        const output = {
          objectType: args.objectType,
          objectName: args.objectName,
          timestamp: new Date().toISOString(),
          perms: {
            create: pickPerm("create"),
            read: pickPerm("read"),
            update: pickPerm("update"),
            delete: pickPerm("delete"),
            grant: pickPerm("grant"),
          },
        };

        const safeName = args.objectName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(
          0,
          60,
        );
        const instanceName = `acl-${args.objectType}-${safeName}`;
        const handle = await context.writeResource(
          "aclInfo",
          instanceName,
          output as unknown as Record<string, unknown>,
        );
        context.logger.info("ACL written for {objectType} {objectName}", {
          objectType: args.objectType,
          objectName: args.objectName,
        });
        return { dataHandles: [handle] };
      },
    },
    filter: {
      description:
        "Filter nodes by health status (ok, stale, critical, never_converged)",
      arguments: z.object({
        status: z.string().default("critical").describe(
          "Health status to filter by",
        ),
      }),
      execute: async (args: { status: string }, context: MethodContext) => {
        context.logger.info("Filtering nodes by status {status}", {
          status: args.status,
        });
        const mapped = await fetchNodeHealth(context.globalArgs);
        const filtered = mapped.filter((n) => n.healthStatus === args.status);

        const output = {
          nodes: filtered,
          summary: {
            total: filtered.length,
            ok: args.status === "ok" ? filtered.length : 0,
            stale: args.status === "stale" ? filtered.length : 0,
            critical: args.status === "critical" ? filtered.length : 0,
            neverConverged: args.status === "never_converged"
              ? filtered.length
              : 0,
          },
          timestamp: new Date().toISOString(),
          filter: args.status,
        };

        const instanceName = `filtered-${args.status}`;
        const handle = await context.writeResource(
          "nodeHealth",
          instanceName,
          output as unknown as Record<string, unknown>,
        );
        context.logger.info("Filter matched {count} node(s)", {
          count: filtered.length,
        });
        return { dataHandles: [handle] };
      },
    },
    checkPackage: {
      description:
        "Check if a package is installed on nodes, optionally with version check and group filter",
      arguments: z.object({
        packageName: z.string().describe(
          "Package name prefix to search (e.g. openssl, Microsoft .NET Runtime - 10.0)",
        ),
        group: z.string().optional().describe(
          "Filter by policy group (e.g. deliver, union)",
        ),
        showMissing: z.boolean().default(false).describe(
          "Also list nodes missing the package",
        ),
        minVersion: z.string().optional().describe(
          "Minimum required version (e.g. 10.0.9). Nodes below this are 'outdated'",
        ),
      }),
      execute: async (
        args: {
          packageName: string;
          group?: string;
          showMissing: boolean;
          minVersion?: string;
        },
        context: MethodContext,
      ) => {
        context.logger.info("Checking package {packageName} {*}", {
          packageName: args.packageName,
          group: args.group,
          minVersion: args.minVersion,
        });
        const quotedName = args.packageName.includes(" ")
          ? `"${args.packageName}*"`
          : `${args.packageName}*`;
        const searchQuery = args.group
          ? `policy_group:${args.group} AND packages:${quotedName}`
          : `packages:${quotedName}`;

        const installedOut = await runKnife(
          context.globalArgs,
          ["search", "node", searchQuery, "-a", "packages", "-F", "json"],
          "knife search",
        );
        const installedData = JSON.parse(installedOut);
        const installedRows = installedData.rows ?? [];

        const prefix = args.packageName.toLowerCase();
        const minVer = args.minVersion ? parseVersion(args.minVersion) : null;

        const allEntries: Array<
          {
            name: string;
            version: string;
            arch: string;
            status: string;
            foundVersion: string;
          }
        > = [];

        for (const row of installedRows) {
          for (
            const [nodeName, attrs] of Object.entries(
              row as Record<string, unknown>,
            )
          ) {
            const pkgs = (attrs as Record<string, unknown>).packages as Record<
              string,
              unknown
            > ?? {};
            const matchingKeys = Object.keys(pkgs).filter((k) =>
              k.toLowerCase().startsWith(prefix)
            );
            for (const key of matchingKeys) {
              const pkg = pkgs[key] as Record<string, string>;
              const extracted = extractVersion(key) ?? "unknown";
              allEntries.push({
                name: nodeName,
                version: pkg.version ?? "unknown",
                arch: pkg.arch ?? "",
                status: pkg.status ?? "",
                foundVersion: extracted,
              });
            }
          }
        }

        const seen = new Map<
          string,
          {
            name: string;
            version: string;
            arch: string;
            status: string;
            foundVersion: string;
          }
        >();
        for (const entry of allEntries) {
          const existing = seen.get(entry.name);
          if (
            !existing ||
            compareVersions(
                parseVersion(entry.foundVersion),
                parseVersion(existing.foundVersion),
              ) > 0
          ) {
            seen.set(entry.name, entry);
          }
        }

        const installed = Array.from(seen.values());

        const missing: Array<{ name: string }> = [];
        if (args.showMissing) {
          const groupQuery = args.group ? `policy_group:${args.group}` : "*:*";
          try {
            const allOut = await runKnife(
              context.globalArgs,
              ["search", "node", groupQuery, "-a", "name", "-F", "json"],
              "knife search",
            );
            const allData = JSON.parse(allOut);
            const allRows = allData.rows ?? [];
            const allNames = new Set<string>();
            for (const row of allRows) {
              for (
                const nodeName of Object.keys(row as Record<string, unknown>)
              ) {
                allNames.add(nodeName);
              }
            }
            const installedNames = new Set(installed.map((n) => n.name));
            for (const name of allNames) {
              if (!installedNames.has(name)) {
                missing.push({ name });
              }
            }
          } catch (_e) {
            // missing-node enrichment is best-effort
          }
        }

        const current: Array<
          {
            name: string;
            version: string;
            arch?: string;
            status?: string;
            foundVersion?: string;
          }
        > = [];
        const outdated: Array<
          {
            name: string;
            version: string;
            arch?: string;
            status?: string;
            foundVersion?: string;
          }
        > = [];

        if (minVer) {
          for (const entry of installed) {
            const entryVer = parseVersion(entry.foundVersion);
            if (compareVersions(entryVer, minVer) >= 0) {
              current.push(entry);
            } else {
              outdated.push(entry);
            }
          }
        }

        const output = {
          packageName: args.packageName,
          group: args.group,
          minVersion: args.minVersion,
          timestamp: new Date().toISOString(),
          installed: minVer ? [] : installed,
          current: minVer ? current : undefined,
          outdated: minVer ? outdated : undefined,
          missing,
          summary: {
            total: installed.length + missing.length,
            installed: installed.length,
            current: current.length,
            outdated: outdated.length,
            missing: missing.length,
          },
        };

        const safeName = args.packageName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(
          0,
          60,
        );
        const instanceName = `pkg-${safeName}${
          args.group ? `-${args.group}` : ""
        }`;
        const handle = await context.writeResource(
          "packageCheck",
          instanceName,
          output as unknown as Record<string, unknown>,
        );
        context.logger.info("Package check written: {*}", output.summary);
        return { dataHandles: [handle] };
      },
    },
  },
};
