import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { type GlobalArgs, type MethodContext, model } from "./cert.ts";

function ctx(context: unknown): MethodContext {
  return context as MethodContext;
}

const BASE: GlobalArgs = {
  caUrl: "https://localhost:9000",
  rootFingerprint: "abc123fingerprint",
  provisionerName: "admin",
  provisionerPassword: "test-password",
  stepImage: "smallstep/step-cli",
  network: "container:step-ca",
  dockerBinary: "docker",
};

const CERTPEM = "-----BEGIN CERTIFICATE-----\nNEW\n-----END CERTIFICATE-----\n";
const KEYPEM =
  "-----BEGIN EC PRIVATE KEY-----\nNEW\n-----END EC PRIVATE KEY-----\n";
const INSPECT_JSON = JSON.stringify({
  serial_number: "111222333",
  validity: { start: "2026-07-13T00:00:00Z", end: "2027-07-13T00:00:00Z" },
  subject: { common_name: ["test.example.com"] },
  names: ["test.example.com", "alt.example.com"],
  fingerprint_sha256: "deadbeef",
  issuer_dn: "CN=Whitemars CA",
});
const ISSUE_OUT =
  `<<<CERT>>>\n${CERTPEM}<<<KEY>>>\n${KEYPEM}<<<INSPECT>>>\n${INSPECT_JSON}`;
const RENEW_OUT = `<<<CERT>>>\n${CERTPEM}<<<INSPECT>>>\n${INSPECT_JSON}`;

const STORED = {
  subject: "test.example.com",
  sans: ["test.example.com"],
  serial: "OLDSERIAL",
  notBefore: "2026-07-01T00:00:00Z",
  notAfter: "2027-07-01T00:00:00Z",
  fingerprint: "oldfp",
  provisioner: "admin",
  caUrl: "https://localhost:9000",
  status: "active",
  certificatePem:
    "-----BEGIN CERTIFICATE-----\nOLD\n-----END CERTIFICATE-----\n",
  keyPem: "-----BEGIN EC PRIVATE KEY-----\nOLD\n-----END EC PRIVATE KEY-----\n",
  timestamp: "2026-07-01T00:00:00Z",
};

// Mock of the ephemeral step-cli container runs. The step script is the last
// docker arg; we dispatch on the subcommand it contains.
function dockerMock(daemonUp = true) {
  return (_cmd: string, args: string[]) => {
    if (args.includes("version")) {
      return daemonUp ? { stdout: "27.0.0\n", code: 0 } : {
        stdout: "",
        stderr: "Cannot connect to the Docker daemon",
        code: 1,
      };
    }
    const script = args[args.length - 1] ?? "";
    if (script.includes("ca revoke")) return { stdout: "REVOKED\n", code: 0 };
    if (script.includes("ca renew")) return { stdout: RENEW_OUT, code: 0 };
    if (script.includes("ca certificate")) {
      return { stdout: ISSUE_OUT, code: 0 };
    }
    if (script.includes("certificate inspect")) {
      return { stdout: INSPECT_JSON, code: 0 };
    }
    return {
      stdout: "",
      stderr: `unexpected docker ${args.join(" ")}`,
      code: 1,
    };
  };
}

Deno.test("issue writes a cert and its key under the subject", async () => {
  await withMockedCommand(dockerMock(), async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: BASE,
    });
    await model.methods.issue.execute(
      { subject: "test.example.com", notAfter: "24h" },
      ctx(context),
    );

    const written = getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(written[0].specName, "cert");
    const d = written[0].data;
    assertEquals(d.subject, "test.example.com");
    assertEquals(d.serial, "111222333");
    assertEquals(d.notAfter, "2027-07-13T00:00:00Z");
    assertEquals(d.status, "active");
    assertEquals(d.certificatePem, CERTPEM);
    assertEquals(d.keyPem, KEYPEM);
    assertEquals(d.sans, ["test.example.com", "alt.example.com"]);
  });
});

Deno.test("issue throws when the docker daemon is unavailable", async () => {
  await withMockedCommand(dockerMock(false), async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: BASE,
    });
    await assertRejects(
      () =>
        model.methods.issue.execute({ subject: "x.example.com" }, ctx(context)),
      Error,
      "Docker daemon not available",
    );
    assertEquals(getWrittenResources().length, 0);
  });
});

Deno.test("issue requires a root fingerprint", async () => {
  await withMockedCommand(dockerMock(), async () => {
    const { context } = createModelTestContext({
      globalArgs: { ...BASE, rootFingerprint: "" },
    });
    await assertRejects(
      () =>
        model.methods.issue.execute({ subject: "x.example.com" }, ctx(context)),
      Error,
      "rootFingerprint is required",
    );
  });
});

Deno.test("issue requires a provisioner password", async () => {
  await withMockedCommand(dockerMock(), async () => {
    const { context } = createModelTestContext({
      globalArgs: { ...BASE, provisionerPassword: "" },
    });
    await assertRejects(
      () =>
        model.methods.issue.execute({ subject: "x.example.com" }, ctx(context)),
      Error,
      "provisionerPassword is required",
    );
  });
});

Deno.test("renew keeps the key and updates the serial", async () => {
  await withMockedCommand(dockerMock(), async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: BASE,
      storedResources: { "cert-test.example.com": STORED },
    });
    await model.methods.renew.execute(
      { subject: "test.example.com" },
      ctx(context),
    );

    const d = getWrittenResources()[0].data;
    assertEquals(d.serial, "111222333"); // from the renewed cert's inspect
    assertEquals(d.certificatePem, CERTPEM); // freshly read back
    assertEquals(d.keyPem, STORED.keyPem); // same key preserved
    assertEquals(d.status, "active");
  });
});

Deno.test("revoke marks the stored record revoked", async () => {
  await withMockedCommand(dockerMock(), async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: BASE,
      storedResources: { "cert-test.example.com": STORED },
    });
    await model.methods.revoke.execute(
      { subject: "test.example.com", reason: "keyCompromise" },
      ctx(context),
    );

    const d = getWrittenResources()[0].data;
    assertEquals(d.status, "revoked");
    assertEquals(d.serial, "OLDSERIAL"); // unchanged
    assertEquals(d.certificatePem, STORED.certificatePem);
  });
});

Deno.test("inspect reports validity and expiry", async () => {
  await withMockedCommand(dockerMock(), async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: BASE,
      storedResources: { "cert-test.example.com": STORED },
    });
    await model.methods.inspect.execute(
      { subject: "test.example.com" },
      ctx(context),
    );

    const written = getWrittenResources();
    assertEquals(written[0].specName, "inspection");
    const d = written[0].data as Record<string, unknown>;
    assertEquals(d.serial, "111222333");
    assertEquals(d.issuer, "CN=Whitemars CA");
    assertEquals(d.expired, false);
    assertEquals((d.secondsUntilExpiry as number) > 0, true);
  });
});

Deno.test("renew throws when no certificate is stored", async () => {
  await withMockedCommand(dockerMock(), async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: BASE,
    });
    await assertRejects(
      () =>
        model.methods.renew.execute(
          { subject: "absent.example.com" },
          ctx(context),
        ),
      Error,
      "No stored certificate",
    );
    assertEquals(getWrittenResources().length, 0);
  });
});
