import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { model } from "./colima.ts";

// The model types each execute's `context` param with an internal (unexported)
// interface. Recover that type from the method signature so the test can cast
// createModelTestContext's loosely-typed context without touching the source.
type Ctx = Parameters<typeof model.methods.sync.execute>[1];
function ctx(context: unknown): Ctx {
  return context as Ctx;
}

const GLOBAL = { profile: "default" };

// A `colima list --json` row (NDJSON: one JSON object per line).
const RUNNING_ROW = {
  name: "default",
  status: "Running",
  arch: "aarch64",
  cpus: 4,
  memory: 8589934592,
  disk: 64424509440,
  runtime: "docker",
};

const STOPPED_ROW = {
  name: "default",
  status: "Stopped",
  arch: "aarch64",
  cpus: 4,
  memory: 8589934592,
  disk: 64424509440,
  runtime: "docker",
};

// A `colima status -p default -e --json` detail object for a running VM.
const STATUS_DETAIL = {
  driver: "vz",
  ip_address: "192.0.2.5",
  docker_socket: "unix:///Users/example/.colima/default/docker.sock",
  kubernetes: false,
  mount_type: "virtiofs",
  display_name: "colima [profile=default]",
};

Deno.test("sync records a running VM enriched with status detail", async () => {
  const calls: string[][] = [];
  await withMockedCommand((_cmd, args) => {
    calls.push(args);
    if (args[0] === "list") {
      return { stdout: JSON.stringify(RUNNING_ROW), code: 0 };
    }
    if (args[0] === "status") {
      return { stdout: JSON.stringify(STATUS_DETAIL), code: 0 };
    }
    return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, code: 1 };
  }, async () => {
    const { context, getWrittenResources, getLogsByLevel } =
      createModelTestContext({ globalArgs: GLOBAL });

    await model.methods.sync.execute({}, ctx(context));

    const written = getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(written[0].specName, "status");
    assertEquals(written[0].name, "status");
    assertEquals(written[0].data.status, "Running");
    assertEquals(written[0].data.runtime, "docker");
    // Enrichment from `colima status` only happens for a running VM.
    assertEquals(written[0].data.driver, "vz");
    assertEquals(written[0].data.ipAddress, "192.0.2.5");
    assertEquals(written[0].data.kubernetes, false);
    // status probe was issued exactly once for the running VM.
    assertEquals(calls.filter((c) => c[0] === "status").length, 1);
    // Methods log their progress at info level.
    assertEquals(getLogsByLevel("info").length > 0, true);
  });
});

Deno.test("sync records not_found and skips status when the profile is absent", async () => {
  const calls: string[][] = [];
  await withMockedCommand((_cmd, args) => {
    calls.push(args);
    // No row matches the profile name.
    if (args[0] === "list") return { stdout: "", code: 0 };
    return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL,
    });

    await model.methods.sync.execute({}, ctx(context));

    const written = getWrittenResources();
    assertEquals(written[0].data.status, "not_found");
    // A missing VM must not trigger the running-only status probe.
    assertEquals(calls.some((c) => c[0] === "status"), false);
  });
});

Deno.test("start provisions the VM with global args, then records status", async () => {
  const calls: string[][] = [];
  await withMockedCommand((_cmd, args) => {
    calls.push(args);
    if (args[0] === "start") return { stdout: "", code: 0 };
    if (args[0] === "list") {
      return { stdout: JSON.stringify(RUNNING_ROW), code: 0 };
    }
    if (args[0] === "status") {
      return { stdout: JSON.stringify(STATUS_DETAIL), code: 0 };
    }
    return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { profile: "default", cpus: 4, memory: 8, arch: "aarch64" },
    });

    await model.methods.start.execute({}, ctx(context));

    const startCall = calls.find((c) => c[0] === "start")!;
    assertEquals(startCall.includes("--cpu"), true);
    assertEquals(startCall.includes("4"), true);
    assertEquals(startCall.includes("--memory"), true);
    assertEquals(startCall.includes("--arch"), true);
    assertEquals(startCall.includes("aarch64"), true);

    const written = getWrittenResources();
    assertEquals(written[0].specName, "status");
    assertEquals(written[0].data.status, "Running");
  });
});

Deno.test("stop --force stops a running VM and records the stopped state", async () => {
  const calls: string[][] = [];
  let listCount = 0;
  await withMockedCommand((_cmd, args) => {
    calls.push(args);
    if (args[0] === "list") {
      listCount++;
      // First probe shows Running; after `stop`, it shows Stopped.
      const row = listCount === 1 ? RUNNING_ROW : STOPPED_ROW;
      return { stdout: JSON.stringify(row), code: 0 };
    }
    if (args[0] === "status") {
      return { stdout: JSON.stringify(STATUS_DETAIL), code: 0 };
    }
    if (args[0] === "stop") return { stdout: "", code: 0 };
    return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL,
    });

    await model.methods.stop.execute({ force: true }, ctx(context));

    const stopCall = calls.find((c) => c[0] === "stop")!;
    assertEquals(stopCall.includes("-f"), true);
    assertEquals(getWrittenResources()[0].data.status, "Stopped");
  });
});

Deno.test("stop is idempotent — an already-stopped VM issues no stop command", async () => {
  const calls: string[][] = [];
  await withMockedCommand((_cmd, args) => {
    calls.push(args);
    if (args[0] === "list") {
      return { stdout: JSON.stringify(STOPPED_ROW), code: 0 };
    }
    return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL,
    });

    await model.methods.stop.execute({ force: false }, ctx(context));

    // No `stop` subcommand — the VM was already stopped.
    assertEquals(calls.some((c) => c[0] === "stop"), false);
    assertEquals(getWrittenResources()[0].data.status, "Stopped");
  });
});

Deno.test("delete --force tears down an existing VM and drops stored status", async () => {
  const calls: string[][] = [];
  await withMockedCommand((_cmd, args) => {
    calls.push(args);
    if (args[0] === "list") {
      return { stdout: JSON.stringify(STOPPED_ROW), code: 0 };
    }
    if (args[0] === "delete") return { stdout: "", code: 0 };
    return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL,
      storedResources: {
        "status": { profile: "default", status: "Stopped" },
      },
    });

    await model.methods.delete.execute({}, ctx(context));

    const deleteCall = calls.find((c) => c[0] === "delete")!;
    assertEquals(deleteCall.includes("-f"), true);
    // delete drops the stale stored status and writes no resource.
    assertEquals(getWrittenResources().length, 0);
  });
});

Deno.test("delete is idempotent — an absent profile issues no delete command", async () => {
  const calls: string[][] = [];
  await withMockedCommand((_cmd, args) => {
    calls.push(args);
    if (args[0] === "list") return { stdout: "", code: 0 };
    return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL,
    });

    await model.methods.delete.execute({}, ctx(context));

    // An absent profile issues no `delete` and writes no resource.
    assertEquals(calls.some((c) => c[0] === "delete"), false);
    assertEquals(getWrittenResources().length, 0);
  });
});

Deno.test("exec records a non-zero exit rather than throwing", async () => {
  await withMockedCommand((_cmd, args) => {
    if (args[0] === "ssh") {
      return { stdout: "", stderr: "sh: nope: not found", code: 127 };
    }
    return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL,
    });

    await model.methods.exec.execute({ command: "nope" }, ctx(context));

    const written = getWrittenResources();
    assertEquals(written[0].specName, "exec");
    assertEquals(written[0].data.exitCode, 127);
    assertEquals(written[0].data.success, false);
    assertEquals(written[0].data.stderr, "sh: nope: not found");
  });
});

Deno.test("a non-zero colima start throws before any resource is written", async () => {
  await withMockedCommand((_cmd, args) => {
    if (args[0] === "start") {
      return { stdout: "", stderr: "FATA[0000] cannot start", code: 1 };
    }
    return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL,
    });

    await assertRejects(
      () => model.methods.start.execute({}, ctx(context)),
      Error,
      "failed (exit 1)",
    );
    assertEquals(getWrittenResources().length, 0);
  });
});
