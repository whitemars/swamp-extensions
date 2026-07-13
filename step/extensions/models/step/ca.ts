/**
 * step-ca online Certificate Authority, run as a local Docker container.
 *
 * Wraps the `docker` CLI to manage the lifecycle of a `smallstep/step-ca`
 * container: `up` creates and boots the CA (auto-initializing a fresh CA into
 * an empty volume on first run), `status` reports container/CA health, and
 * `down` stops and removes the container while preserving the volume so the CA
 * material survives.
 *
 * @module
 */
import { z } from "npm:zod@4";

/**
 * Global arguments describing a single step-ca instance. One model instance
 * models one CA. Secrets (the provisioner password) should be supplied via a
 * `${{ vault.get(...) }}` expression rather than a literal.
 */
export const GlobalArgsSchema = z.object({
  caName: z.string().describe(
    "Human-readable CA name; becomes the issuer/subject of the root. Sets DOCKER_STEPCA_INIT_NAME.",
  ),
  dnsNames: z.array(z.string()).min(1).describe(
    "DNS names / IPs the CA answers on (SANs on the CA cert). The first entry is used to build the client-facing CA URL. Sets DOCKER_STEPCA_INIT_DNS_NAMES.",
  ),
  provisionerPassword: z.string().meta({ sensitive: true }).describe(
    "Password protecting the provisioner and CA keys. Required for a non-interactive detached boot; persisted into the volume on first init. Supply via ${{ vault.get(...) }}. Sets DOCKER_STEPCA_INIT_PASSWORD.",
  ),
  provisionerName: z.string().default("admin").describe(
    "Name of the initial JWK provisioner. Sets DOCKER_STEPCA_INIT_PROVISIONER_NAME.",
  ),
  port: z.number().int().min(1).max(65535).default(9000).describe(
    "Host port published to the container's internal 9000.",
  ),
  address: z.string().default(":9000").describe(
    "Address step-ca listens on inside the container. Sets DOCKER_STEPCA_INIT_ADDRESS.",
  ),
  image: z.string().default("smallstep/step-ca").describe(
    "Docker image, optionally tag-pinned (e.g. smallstep/step-ca:0.28.1).",
  ),
  containerName: z.string().default("step-ca").describe(
    "Name of the docker container.",
  ),
  volume: z.string().default("step").describe(
    "Docker named volume mounted at /home/step (holds CA config, keys, and certs).",
  ),
  remoteManagement: z.boolean().default(false).describe(
    "Enable step-ca's admin/remote provisioner management API on init. Sets DOCKER_STEPCA_INIT_REMOTE_MANAGEMENT.",
  ),
  acme: z.boolean().default(false).describe(
    "Add an ACME provisioner on init. Sets DOCKER_STEPCA_INIT_ACME.",
  ),
  ssh: z.boolean().default(false).describe(
    "Enable the SSH CA on init. Sets DOCKER_STEPCA_INIT_SSH.",
  ),
  dockerBinary: z.string().default("docker").describe(
    "Docker CLI executable to invoke.",
  ),
});

/** Global arguments for the step-ca model. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Resource describing a running (or just-booted) CA and how to reach it. */
export const CaSchema = z.object({
  caName: z.string(),
  caUrl: z.string(),
  dnsNames: z.array(z.string()),
  provisionerName: z.string(),
  address: z.string(),
  image: z.string(),
  containerName: z.string(),
  containerId: z.string(),
  volume: z.string(),
  port: z.number(),
  rootFingerprint: z.string(),
  remoteManagement: z.boolean(),
  acme: z.boolean(),
  ssh: z.boolean(),
  initializedNow: z.boolean(),
  running: z.boolean(),
  timestamp: z.string(),
});

/** Resource describing the observed state of the CA container. */
export const StatusSchema = z.object({
  containerName: z.string(),
  exists: z.boolean(),
  running: z.boolean(),
  state: z.string(),
  startedAt: z.string().nullable(),
  caUrl: z.string(),
  rootFingerprint: z.string().nullable(),
  healthy: z.boolean(),
  health: z.string(),
  timestamp: z.string(),
});

/**
 * Execution context passed to each method: validated global args, an optional
 * cancellation signal, a logger, and the resource writer.
 */
export interface MethodContext {
  globalArgs: GlobalArgs;
  signal?: AbortSignal;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning?: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Result of a raw docker invocation. */
interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the docker CLI and captures its exit code, stdout, and stderr. */
async function docker(
  bin: string,
  args: string[],
  signal?: AbortSignal,
  env?: Record<string, string>,
): Promise<DockerResult> {
  const proc = await new Deno.Command(bin, {
    args,
    stdout: "piped",
    stderr: "piped",
    signal,
    env,
  }).output();
  return {
    code: proc.code,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

/** Runs docker and returns stdout, throwing with stderr on a non-zero exit. */
async function dockerOrThrow(
  bin: string,
  args: string[],
  label: string,
  signal?: AbortSignal,
  env?: Record<string, string>,
): Promise<string> {
  const r = await docker(bin, args, signal, env);
  if (r.code !== 0) {
    throw new Error(`${label} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout;
}

/** Throws a descriptive error if the docker daemon is unreachable. */
async function assertDocker(
  bin: string,
  signal?: AbortSignal,
): Promise<void> {
  let r: DockerResult;
  try {
    r = await docker(
      bin,
      ["version", "--format", "{{.Server.Version}}"],
      signal,
    );
  } catch (e) {
    throw new Error(
      `Docker CLI '${bin}' could not be executed: ${(e as Error).message}`,
    );
  }
  if (r.code !== 0) {
    throw new Error(
      `Docker daemon not available via '${bin}': ${
        r.stderr.trim() || "is it running?"
      }`,
    );
  }
}

/** Container state fields extracted from `docker inspect`. */
interface ContainerState {
  id: string;
  status: string;
  running: boolean;
  startedAt: string | null;
}

/** Inspects a container, returning null when it does not exist. */
async function inspectState(
  bin: string,
  name: string,
  signal?: AbortSignal,
): Promise<ContainerState | null> {
  const r = await docker(
    bin,
    [
      "inspect",
      "--format",
      "{{.Id}}|{{.State.Status}}|{{.State.Running}}|{{.State.StartedAt}}",
      name,
    ],
    signal,
  );
  if (r.code !== 0) return null;
  const [id, status, running, startedAt] = r.stdout.trim().split("|");
  return {
    id: id ?? "",
    status: status ?? "unknown",
    running: running === "true",
    startedAt: startedAt && startedAt !== "0001-01-01T00:00:00Z"
      ? startedAt
      : null,
  };
}

/** Sleeps for `ms`, rejecting early if the abort signal fires. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

/**
 * Reads the root CA fingerprint from the volume by running a throwaway
 * container. Works whether or not the server container is running, since named
 * volumes can be mounted concurrently. Returns null if the CA is not yet
 * initialized.
 */
async function fingerprintFromVolume(
  g: GlobalArgs,
  signal?: AbortSignal,
): Promise<string | null> {
  const r = await docker(
    g.dockerBinary,
    [
      "run",
      "--rm",
      "-v",
      `${g.volume}:/home/step`,
      g.image,
      "step",
      "certificate",
      "fingerprint",
      "/home/step/certs/root_ca.crt",
    ],
    signal,
  );
  if (r.code !== 0) return null;
  const fp = r.stdout.trim();
  return fp || null;
}

/** Polls for the root fingerprint until it appears or attempts are exhausted. */
async function waitForFingerprint(
  g: GlobalArgs,
  signal?: AbortSignal,
  attempts = 30,
): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    const fp = await fingerprintFromVolume(g, signal);
    if (fp) return fp;
    await delay(1000, signal);
  }
  return null;
}

/** Derives the container-internal CA URL from the listen address. */
function internalCaUrl(address: string): string {
  const port = address.includes(":") ? address.split(":").pop() : address;
  return `https://localhost:${port || "9000"}`;
}

/** Client-facing CA URL, built from the first DNS name and published port. */
function clientCaUrl(g: GlobalArgs): string {
  const host = g.dnsNames[0] ?? "localhost";
  return `https://${host}:${g.port}`;
}

/** Health of the CA, probed via `step ca health` inside the container. */
async function checkHealth(
  g: GlobalArgs,
  signal?: AbortSignal,
): Promise<{ healthy: boolean; health: string }> {
  const r = await docker(
    g.dockerBinary,
    [
      "exec",
      g.containerName,
      "step",
      "ca",
      "health",
      "--ca-url",
      internalCaUrl(g.address),
      "--root",
      "/home/step/certs/root_ca.crt",
    ],
    signal,
  );
  const out = (r.stdout + r.stderr).trim();
  return {
    healthy: r.code === 0 && /ok/i.test(out),
    health: out || (r.code === 0 ? "ok" : "unknown"),
  };
}

/**
 * Builds the `-e DOCKER_STEPCA_INIT_*` args that auto-initialize a fresh CA.
 * The password is emitted name-only (`-e DOCKER_STEPCA_INIT_PASSWORD`) so docker
 * reads its value from the process environment rather than argv — see
 * `passwordEnv`. Keeping it out of argv avoids exposure in the host process
 * table.
 */
function initEnvArgs(g: GlobalArgs): string[] {
  const env: string[] = [];
  const add = (k: string, v: string): void => {
    env.push("-e", `${k}=${v}`);
  };
  add("DOCKER_STEPCA_INIT_NAME", g.caName);
  add("DOCKER_STEPCA_INIT_DNS_NAMES", g.dnsNames.join(","));
  add("DOCKER_STEPCA_INIT_PROVISIONER_NAME", g.provisionerName);
  env.push("-e", "DOCKER_STEPCA_INIT_PASSWORD"); // value passed via env, not argv
  add("DOCKER_STEPCA_INIT_ADDRESS", g.address);
  if (g.remoteManagement) add("DOCKER_STEPCA_INIT_REMOTE_MANAGEMENT", "true");
  if (g.acme) add("DOCKER_STEPCA_INIT_ACME", "true");
  if (g.ssh) add("DOCKER_STEPCA_INIT_SSH", "true");
  return env;
}

/** Environment passed to the `docker run` child so the password stays out of argv. */
function passwordEnv(g: GlobalArgs): Record<string, string> {
  return { DOCKER_STEPCA_INIT_PASSWORD: g.provisionerPassword };
}

/**
 * step-ca online CA model. Wraps `docker` to run a `smallstep/step-ca`
 * container, capturing the root fingerprint clients need to establish trust.
 */
export const model = {
  type: "@whitemars/step/ca",
  version: "2026.07.13.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    "ca": {
      description: "The running step-ca instance and its root fingerprint",
      schema: CaSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "status": {
      description: "Observed state of the step-ca container",
      schema: StatusSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    up: {
      description:
        "Ensure the step-ca container is running. Creates and auto-initializes a fresh CA on first run (empty volume), starts a stopped container otherwise. Idempotent.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = context.globalArgs;
        await assertDocker(g.dockerBinary, context.signal);

        const state = await inspectState(
          g.dockerBinary,
          g.containerName,
          context.signal,
        );

        let containerId: string;
        let initializedNow = false;

        if (!state) {
          // Fresh container. If the volume has no CA yet, the image will
          // bootstrap one on first boot from the DOCKER_STEPCA_INIT_* env.
          const existing = await fingerprintFromVolume(g, context.signal);
          initializedNow = existing === null;
          context.logger.info(
            initializedNow
              ? "Initializing a new step-ca in container {name}"
              : "Starting step-ca from existing volume in container {name}",
            { name: g.containerName },
          );
          const out = await dockerOrThrow(
            g.dockerBinary,
            [
              "run",
              "-d",
              "--name",
              g.containerName,
              "-v",
              `${g.volume}:/home/step`,
              "-p",
              `${g.port}:9000`,
              ...initEnvArgs(g),
              g.image,
            ],
            "docker run",
            context.signal,
            passwordEnv(g),
          );
          containerId = out.trim();
        } else if (!state.running) {
          context.logger.info("Starting stopped container {name}", {
            name: g.containerName,
          });
          await dockerOrThrow(
            g.dockerBinary,
            ["start", g.containerName],
            "docker start",
            context.signal,
          );
          containerId = state.id;
        } else {
          context.logger.info("Container {name} already running", {
            name: g.containerName,
          });
          containerId = state.id;
        }

        const fingerprint = await waitForFingerprint(g, context.signal);
        if (!fingerprint) {
          throw new Error(
            `step-ca did not become ready: root_ca.crt not found in volume '${g.volume}' within timeout`,
          );
        }

        const output = {
          caName: g.caName,
          caUrl: clientCaUrl(g),
          dnsNames: g.dnsNames,
          provisionerName: g.provisionerName,
          address: g.address,
          image: g.image,
          containerName: g.containerName,
          containerId,
          volume: g.volume,
          port: g.port,
          rootFingerprint: fingerprint,
          remoteManagement: g.remoteManagement,
          acme: g.acme,
          ssh: g.ssh,
          initializedNow,
          running: true,
          timestamp: new Date().toISOString(),
        };
        const handle = await context.writeResource("ca", "ca", output);
        context.logger.info("step-ca up: {name} (fingerprint {fp})", {
          name: g.containerName,
          fp: fingerprint,
        });
        return { dataHandles: [handle] };
      },
    },
    status: {
      description:
        "Report the state of the step-ca container and CA health (existence, running state, root fingerprint, /health).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = context.globalArgs;
        await assertDocker(g.dockerBinary, context.signal);

        const state = await inspectState(
          g.dockerBinary,
          g.containerName,
          context.signal,
        );
        const fingerprint = await fingerprintFromVolume(g, context.signal);

        let running = false;
        let stateStr = "absent";
        let startedAt: string | null = null;
        let health = { healthy: false, health: "no such container" };

        if (state) {
          running = state.running;
          stateStr = state.status;
          startedAt = state.startedAt;
          health = running
            ? await checkHealth(g, context.signal)
            : { healthy: false, health: "container not running" };
        }

        const output = {
          containerName: g.containerName,
          exists: state !== null,
          running,
          state: stateStr,
          startedAt,
          caUrl: clientCaUrl(g),
          rootFingerprint: fingerprint,
          healthy: health.healthy,
          health: health.health,
          timestamp: new Date().toISOString(),
        };
        const handle = await context.writeResource("status", "status", output);
        context.logger.info(
          "step-ca status: {name} running={running} healthy={healthy}",
          {
            name: g.containerName,
            running,
            healthy: health.healthy,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    down: {
      description:
        "Stop and remove the step-ca container. The named volume (CA config, keys, certs) is preserved so a later `up` resumes the same CA.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = context.globalArgs;
        await assertDocker(g.dockerBinary, context.signal);

        const state = await inspectState(
          g.dockerBinary,
          g.containerName,
          context.signal,
        );
        if (state) {
          context.logger.info("Removing container {name}", {
            name: g.containerName,
          });
          await dockerOrThrow(
            g.dockerBinary,
            ["rm", "-f", g.containerName],
            "docker rm -f",
            context.signal,
          );
        } else {
          context.logger.info(
            "Container {name} does not exist; nothing to remove",
            {
              name: g.containerName,
            },
          );
        }

        const fingerprint = await fingerprintFromVolume(g, context.signal);
        const output = {
          containerName: g.containerName,
          exists: false,
          running: false,
          state: state ? "removed" : "absent",
          startedAt: null,
          caUrl: clientCaUrl(g),
          rootFingerprint: fingerprint,
          healthy: false,
          health: state ? "removed" : "absent",
          timestamp: new Date().toISOString(),
        };
        const handle = await context.writeResource("status", "status", output);
        context.logger.info("step-ca down: {name}", { name: g.containerName });
        return { dataHandles: [handle] };
      },
    },
  },
};
