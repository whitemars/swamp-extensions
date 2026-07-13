/**
 * Certificate lifecycle against a step-ca instance — CA-location agnostic.
 *
 * step/cert is a **CA client**: it reaches the CA over the network at `caUrl`,
 * bootstrapping trust from the CA's root fingerprint, and runs the `step` CLI in
 * an ephemeral `smallstep/step-cli` container. The CA can be the local
 * `@whitemars/step/ca` container or a remote step-ca — this model does not exec
 * into the CA or read its filesystem. Methods: `issue`, `renew`, `revoke`,
 * `inspect`.
 *
 * @module
 */
import { z } from "npm:zod@4";

/**
 * Global arguments describing how to reach the CA and authorize issuance.
 *
 * Wire `rootFingerprint` from the CA model's output, e.g.
 * `${{ data.latest("step-ca", "ca").attributes.rootFingerprint }}`, and supply
 * `provisionerPassword` via `${{ vault.get(...) }}`.
 */
export const GlobalArgsSchema = z.object({
  caUrl: z.string().default("https://localhost:9000").describe(
    "CA URL as reachable from the ephemeral step-cli container. For the local @whitemars/step/ca container, keep the default and share its network via `network`.",
  ),
  rootFingerprint: z.string().default("").describe(
    'Root CA fingerprint used to bootstrap trust (required for issue/renew/revoke). Wire from data.latest("<ca-model>", "ca").attributes.rootFingerprint.',
  ),
  provisionerName: z.string().default("admin").describe(
    "JWK provisioner used to authorize issuance.",
  ),
  provisionerPassword: z.string().default("").meta({ sensitive: true })
    .describe(
      "Provisioner password (required for issue). Supply via ${{ vault.get(...) }}.",
    ),
  stepImage: z.string().default("smallstep/step-cli").describe(
    "Docker image providing the `step` CLI (optionally tag-pinned).",
  ),
  network: z.string().default("container:step-ca").describe(
    "Docker `--network` for CA-contacting runs. `container:<name>` shares the local CA container's network so `localhost` resolves and TLS SANs match. Set empty for a remote CA reachable on the default bridge.",
  ),
  dockerBinary: z.string().default("docker").describe(
    "Docker CLI executable to invoke.",
  ),
});

/** Global arguments for the step-ca certificate model. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** An issued leaf certificate and its (vaulted) private key. */
export const CertSchema = z.object({
  subject: z.string(),
  sans: z.array(z.string()),
  serial: z.string(),
  notBefore: z.string(),
  notAfter: z.string(),
  fingerprint: z.string(),
  provisioner: z.string(),
  caUrl: z.string(),
  status: z.string(),
  certificatePem: z.string(),
  keyPem: z.string().meta({ sensitive: true }),
  timestamp: z.string(),
});

/** Result of inspecting a stored certificate. */
export const InspectionSchema = z.object({
  subject: z.string(),
  serial: z.string(),
  notBefore: z.string(),
  notAfter: z.string(),
  expired: z.boolean(),
  secondsUntilExpiry: z.number(),
  fingerprint: z.string(),
  issuer: z.string(),
  timestamp: z.string(),
});

/**
 * Execution context passed to each method: validated global args, an optional
 * cancellation signal, a logger, and the resource read/write helpers.
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
  readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
}

/** Result of a raw docker invocation. */
interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the docker CLI. `env` values are added to the child environment (merged
 * with the parent, so PATH survives); stdin is null so `docker run -i` sees a
 * non-interactive, EOF stdin and `step` never tries to open /dev/tty.
 */
async function docker(
  bin: string,
  args: string[],
  signal?: AbortSignal,
  env?: Record<string, string>,
): Promise<DockerResult> {
  const proc = await new Deno.Command(bin, {
    args,
    stdin: "null",
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

/**
 * Runs `step` inside an ephemeral step-cli container. All dynamic values are
 * passed as named environment variables (never argv), so nothing is injectable
 * and no secret appears in the process table. `network` is attached only when
 * the operation contacts the CA.
 */
async function runStep(
  g: GlobalArgs,
  opts: { script: string; env: Record<string, string>; network: boolean },
  signal?: AbortSignal,
): Promise<string> {
  const args = ["run", "--rm", "-i"];
  if (opts.network && g.network.trim()) args.push("--network", g.network);
  for (const key of Object.keys(opts.env)) args.push("-e", key);
  args.push(g.stepImage, "sh", "-c", opts.script);
  const r = await docker(g.dockerBinary, args, signal, opts.env);
  if (r.code !== 0) {
    throw new Error(
      `step failed: ${r.stderr.trim() || r.stdout.trim() || "unknown error"}`,
    );
  }
  return r.stdout;
}

/** Shape of the fields read from `step certificate inspect --format json`. */
interface InspectJson {
  serial_number: string;
  validity: { start: string; end: string };
  subject: { common_name?: string[] };
  names?: string[];
  fingerprint_sha256?: string;
  issuer_dn?: string;
}

/**
 * Extracts marker-delimited sections from step-cli stdout. Each marker line
 * (e.g. `<<<CERT>>>`) introduces a section that runs until the next marker.
 */
function extractSections(
  out: string,
  markers: string[],
): Record<string, string> {
  const res: Record<string, string> = {};
  for (let i = 0; i < markers.length; i++) {
    const tag = `${markers[i]}\n`;
    const si = out.indexOf(tag);
    if (si < 0) {
      throw new Error(`expected section ${markers[i]} in step output`);
    }
    const contentStart = si + tag.length;
    const next = i + 1 < markers.length
      ? out.indexOf(markers[i + 1], contentStart)
      : out.length;
    res[markers[i]] = out.slice(contentStart, next < 0 ? out.length : next);
  }
  return res;
}

/** Maps an arbitrary subject to a filesystem/instance-safe key. */
function instanceKey(subject: string): string {
  return subject.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// Instance names must be unique across specs on disk, so each spec gets its own
// prefix even though both are keyed by subject.
/** Instance name for the `cert` spec. */
function certInstance(subject: string): string {
  return `cert-${instanceKey(subject)}`;
}

/** Instance name for the `inspection` spec. */
function inspectInstance(subject: string): string {
  return `inspect-${instanceKey(subject)}`;
}

/** Throws unless a root fingerprint is configured (needed to trust the CA). */
function requireFingerprint(g: GlobalArgs): string {
  if (!g.rootFingerprint.trim()) {
    throw new Error(
      'rootFingerprint is required for this operation — wire it from the CA model, e.g. ${{ data.latest("step-ca", "ca").attributes.rootFingerprint }}',
    );
  }
  return g.rootFingerprint;
}

// Fetches the CA root using the fingerprint, then generates a leaf cert. Extra
// flags (SANs, validity, key type) are built from env vars so nothing is
// interpolated into the shell.
const ISSUE_SCRIPT = `set -e
step ca root /tmp/r.crt --ca-url "$U" --fingerprint "$FP" -f >/dev/null
printf %s "$PW" > /tmp/pw
set -- "$SUBJ" /tmp/c.crt /tmp/c.key --ca-url "$U" --root /tmp/r.crt --provisioner "$PROV" --provisioner-password-file /tmp/pw -f
[ -n "$NA" ] && set -- "$@" --not-after "$NA"
[ -n "$NB" ] && set -- "$@" --not-before "$NB"
[ -n "$KTY" ] && set -- "$@" --kty "$KTY"
if [ -n "$SANS" ]; then OIFS=$IFS; IFS='
'; for s in $SANS; do set -- "$@" --san "$s"; done; IFS=$OIFS; fi
step ca certificate "$@" >/dev/null
printf '<<<CERT>>>\\n'; cat /tmp/c.crt
printf '<<<KEY>>>\\n'; cat /tmp/c.key
printf '<<<INSPECT>>>\\n'; step certificate inspect /tmp/c.crt --format json`;

const RENEW_SCRIPT = `set -e
step ca root /tmp/r.crt --ca-url "$U" --fingerprint "$FP" -f >/dev/null
printf %s "$CERT" > /tmp/c.crt
printf %s "$KEY" > /tmp/c.key
step ca renew /tmp/c.crt /tmp/c.key --ca-url "$U" --root /tmp/r.crt -f >/dev/null
printf '<<<CERT>>>\\n'; cat /tmp/c.crt
printf '<<<INSPECT>>>\\n'; step certificate inspect /tmp/c.crt --format json`;

const REVOKE_SCRIPT = `set -e
step ca root /tmp/r.crt --ca-url "$U" --fingerprint "$FP" -f >/dev/null
printf %s "$CERT" > /tmp/c.crt
printf %s "$KEY" > /tmp/c.key
set -- --cert /tmp/c.crt --key /tmp/c.key --ca-url "$U" --root /tmp/r.crt
[ -n "$REASON" ] && set -- "$@" --reason "$REASON"
step ca revoke "$@" >/dev/null
printf 'REVOKED\\n'`;

const INSPECT_SCRIPT = `set -e
printf %s "$CERT" > /tmp/c.crt
step certificate inspect /tmp/c.crt --format json`;

/** Arguments shared by every method: the certificate subject. */
const SubjectArgs = z.object({
  subject: z.string().describe("Certificate subject (common name)."),
});

/**
 * Certificate lifecycle model. Issues, renews, revokes, and inspects leaf
 * certificates as a network client of a step-ca instance — local or remote.
 */
export const model = {
  type: "@whitemars/step/cert",
  version: "2026.07.13.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "cert": {
      description: "An issued leaf certificate and its private key",
      schema: CertSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "inspection": {
      description: "Inspection result for a stored certificate",
      schema: InspectionSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    issue: {
      description:
        "Issue a new leaf certificate from the CA over the network. The subject is added as a SAN when extra SANs are given. Stores the certificate and its (vaulted) private key under the subject.",
      arguments: SubjectArgs.extend({
        sans: z.array(z.string()).optional().describe(
          "Additional Subject Alternative Names (DNS/IP/email/URI).",
        ),
        notAfter: z.string().optional().describe(
          "Certificate expiry as a duration (e.g. 24h) or RFC3339 time.",
        ),
        notBefore: z.string().optional().describe(
          "Certificate start as a duration or RFC3339 time.",
        ),
        keyType: z.string().optional().describe(
          "Key type passed to --kty (e.g. EC, RSA, OKP).",
        ),
      }),
      execute: async (
        args: {
          subject: string;
          sans?: string[];
          notAfter?: string;
          notBefore?: string;
          keyType?: string;
        },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = context.globalArgs;
        await assertDocker(g.dockerBinary, context.signal);
        requireFingerprint(g);
        if (!g.provisionerPassword.trim()) {
          throw new Error(
            "provisionerPassword is required to issue — supply it via ${{ vault.get(...) }}",
          );
        }

        const sanList = args.sans && args.sans.length > 0
          ? Array.from(new Set([args.subject, ...args.sans]))
          : [];

        context.logger.info("Issuing certificate for {subject}", {
          subject: args.subject,
        });
        const out = await runStep(g, {
          script: ISSUE_SCRIPT,
          network: true,
          env: {
            U: g.caUrl,
            FP: g.rootFingerprint,
            PROV: g.provisionerName,
            PW: g.provisionerPassword,
            SUBJ: args.subject,
            NA: args.notAfter ?? "",
            NB: args.notBefore ?? "",
            KTY: args.keyType ?? "",
            SANS: sanList.join("\n"),
          },
        }, context.signal);

        const s = extractSections(out, [
          "<<<CERT>>>",
          "<<<KEY>>>",
          "<<<INSPECT>>>",
        ]);
        const info = JSON.parse(s["<<<INSPECT>>>"].trim()) as InspectJson;

        const handle = await context.writeResource(
          "cert",
          certInstance(args.subject),
          {
            subject: args.subject,
            sans: info.names ?? [args.subject],
            serial: info.serial_number,
            notBefore: info.validity.start,
            notAfter: info.validity.end,
            fingerprint: info.fingerprint_sha256 ?? "",
            provisioner: g.provisionerName,
            caUrl: g.caUrl,
            status: "active",
            certificatePem: s["<<<CERT>>>"],
            keyPem: s["<<<KEY>>>"],
            timestamp: new Date().toISOString(),
          },
        );
        context.logger.info("Issued certificate {serial} for {subject}", {
          serial: info.serial_number,
          subject: args.subject,
        });
        return { dataHandles: [handle] };
      },
    },
    renew: {
      description:
        "Renew a previously issued certificate (same key, extended validity) via mTLS. Reads the stored cert/key, renews against the CA, and updates the stored record.",
      arguments: SubjectArgs,
      execute: async (
        args: { subject: string },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = context.globalArgs;
        await assertDocker(g.dockerBinary, context.signal);
        requireFingerprint(g);
        const stored = await readStoredCert(context, args.subject);

        context.logger.info("Renewing certificate for {subject}", {
          subject: args.subject,
        });
        const out = await runStep(g, {
          script: RENEW_SCRIPT,
          network: true,
          env: {
            U: g.caUrl,
            FP: g.rootFingerprint,
            CERT: stored.certificatePem,
            KEY: stored.keyPem,
          },
        }, context.signal);

        const s = extractSections(out, ["<<<CERT>>>", "<<<INSPECT>>>"]);
        const info = JSON.parse(s["<<<INSPECT>>>"].trim()) as InspectJson;

        const handle = await context.writeResource(
          "cert",
          certInstance(args.subject),
          {
            subject: stored.subject,
            sans: info.names ?? stored.sans,
            serial: info.serial_number,
            notBefore: info.validity.start,
            notAfter: info.validity.end,
            fingerprint: info.fingerprint_sha256 ?? "",
            provisioner: stored.provisioner,
            caUrl: g.caUrl,
            status: "active",
            certificatePem: s["<<<CERT>>>"],
            keyPem: stored.keyPem,
            timestamp: new Date().toISOString(),
          },
        );
        context.logger.info(
          "Renewed certificate for {subject}: new serial {serial}",
          {
            subject: args.subject,
            serial: info.serial_number,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    revoke: {
      description:
        "Revoke a previously issued certificate via mTLS. Marks the stored record revoked; the certificate can no longer be renewed.",
      arguments: SubjectArgs.extend({
        reason: z.string().optional().describe(
          "Human-readable revocation reason (--reason).",
        ),
      }),
      execute: async (
        args: { subject: string; reason?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = context.globalArgs;
        await assertDocker(g.dockerBinary, context.signal);
        requireFingerprint(g);
        const stored = await readStoredCert(context, args.subject);

        context.logger.info("Revoking certificate for {subject}", {
          subject: args.subject,
        });
        await runStep(g, {
          script: REVOKE_SCRIPT,
          network: true,
          env: {
            U: g.caUrl,
            FP: g.rootFingerprint,
            CERT: stored.certificatePem,
            KEY: stored.keyPem,
            REASON: args.reason ?? "",
          },
        }, context.signal);

        const handle = await context.writeResource(
          "cert",
          certInstance(args.subject),
          {
            subject: stored.subject,
            sans: stored.sans,
            serial: stored.serial,
            notBefore: stored.notBefore,
            notAfter: stored.notAfter,
            fingerprint: stored.fingerprint,
            provisioner: stored.provisioner,
            caUrl: g.caUrl,
            status: "revoked",
            certificatePem: stored.certificatePem,
            keyPem: stored.keyPem,
            timestamp: new Date().toISOString(),
          },
        );
        context.logger.info("Revoked certificate {serial} for {subject}", {
          serial: stored.serial,
          subject: args.subject,
        });
        return { dataHandles: [handle] };
      },
    },
    inspect: {
      description:
        "Inspect a stored certificate: validity window, expiry countdown, serial, and fingerprint. Purely local — does not contact the CA.",
      arguments: SubjectArgs,
      execute: async (
        args: { subject: string },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = context.globalArgs;
        await assertDocker(g.dockerBinary, context.signal);
        const stored = await readStoredCert(context, args.subject);

        context.logger.info("Inspecting certificate for {subject}", {
          subject: args.subject,
        });
        const out = await runStep(g, {
          script: INSPECT_SCRIPT,
          network: false,
          env: { CERT: stored.certificatePem },
        }, context.signal);

        const info = JSON.parse(out.trim()) as InspectJson;
        const now = Date.now();
        const endMs = Date.parse(info.validity.end);

        const handle = await context.writeResource(
          "inspection",
          inspectInstance(args.subject),
          {
            subject: args.subject,
            serial: info.serial_number,
            notBefore: info.validity.start,
            notAfter: info.validity.end,
            expired: now > endMs,
            secondsUntilExpiry: Math.floor((endMs - now) / 1000),
            fingerprint: info.fingerprint_sha256 ?? "",
            issuer: info.issuer_dn ?? "",
            timestamp: new Date().toISOString(),
          },
        );
        context.logger.info("Inspected certificate for {subject}", {
          subject: args.subject,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

/** Stored certificate record, typed from CertSchema. */
type StoredCert = z.infer<typeof CertSchema>;

/** Reads a stored certificate by subject, throwing a clear error if absent. */
async function readStoredCert(
  context: MethodContext,
  subject: string,
): Promise<StoredCert> {
  if (!context.readResource) {
    throw new Error("readResource is not available in this context");
  }
  const data = await context.readResource(certInstance(subject));
  if (!data) {
    throw new Error(
      `No stored certificate for subject '${subject}' — issue it first`,
    );
  }
  return data as StoredCert;
}
