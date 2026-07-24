import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { model } from "./incus.ts";

// The model types each execute's `context` param with an internal (unexported)
// interface. Recover that type from the method signature so the test can cast
// createModelTestContext's loosely-typed context without touching the source.
type Ctx = Parameters<typeof model.methods.sync.execute>[1];
function ctx(context: unknown): Ctx {
  return context as Ctx;
}

// A raw `incus list --format json` row for a running container with a global
// IPv4 plus a loopback address that normalize() must filter out.
const WEB01_RUNNING = {
  name: "web01",
  type: "container",
  status: "Running",
  status_code: 103,
  architecture: "x86_64",
  ephemeral: false,
  profiles: ["default"],
  config: { "image.description": "Debian 12", "image.os": "debian" },
  created_at: "2026-01-01T00:00:00Z",
  last_used_at: "2026-07-01T00:00:00Z",
  location: "none",
  state: {
    network: {
      eth0: {
        addresses: [
          { family: "inet", address: "192.0.2.10", scope: "global" },
          { family: "inet", address: "127.0.0.1", scope: "local" },
          { family: "inet6", address: "2001:db8::10", scope: "global" },
        ],
      },
    },
  },
};

const WEB01_STOPPED = {
  name: "web01",
  type: "container",
  status: "Stopped",
  status_code: 102,
  ephemeral: false,
  profiles: ["default"],
  config: {},
  state: null,
};

const DB01_STOPPED = {
  name: "db01",
  type: "container",
  status: "Stopped",
  status_code: 102,
  ephemeral: false,
  profiles: ["default"],
  config: {},
  state: null,
};

Deno.test("sync writes one container per instance plus a summary roll-up", async () => {
  let listCalls = 0;
  await withMockedCommand((_cmd, args) => {
    if (args[0] === "list") {
      listCalls++;
      return { stdout: JSON.stringify([WEB01_RUNNING, DB01_STOPPED]), code: 0 };
    }
    return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext();

    await model.methods.sync.execute({}, ctx(context));

    // Whole inventory comes from a single `incus list` round-trip.
    assertEquals(listCalls, 1);

    const written = getWrittenResources();
    // 2 containers + 1 summary
    assertEquals(written.length, 3);

    const web01 = written.find((w) => w.name === "web01")!;
    assertEquals(web01.specName, "container");
    assertEquals(web01.data.status, "Running");
    assertEquals(web01.data.image, "Debian 12");
    // Loopback ("local" scope) is filtered; only the global v4/v6 survive.
    assertEquals(web01.data.ipv4, ["192.0.2.10"]);
    assertEquals(web01.data.ipv6, ["2001:db8::10"]);

    const summary = written.find((w) => w.specName === "summary")!;
    assertEquals(summary.name, "summary");
    assertEquals(summary.data.total, 2);
    assertEquals(summary.data.running, 1);
    assertEquals(summary.data.stopped, 1);
    assertEquals(summary.data.frozen, 0);
    assertEquals(summary.data.other, 0);
    assertEquals(summary.data.instances, ["web01", "db01"]);
  });
});

Deno.test("launch shells out with image + project, then persists fresh state", async () => {
  const calls: string[][] = [];
  await withMockedCommand((_cmd, args) => {
    calls.push(args);
    if (args[0] === "launch") return { stdout: "", code: 0 };
    if (args[0] === "list") {
      return { stdout: JSON.stringify([WEB01_RUNNING]), code: 0 };
    }
    return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext();

    await model.methods.launch.execute(
      {
        name: "web01",
        image: "images:debian/12",
        vm: false,
        ephemeral: false,
        profiles: ["default"],
        config: ["limits.cpu=2"],
      },
      ctx(context),
    );

    const launchCall = calls.find((c) => c[0] === "launch")!;
    assertEquals(launchCall.includes("images:debian/12"), true);
    assertEquals(launchCall.includes("web01"), true);
    assertEquals(launchCall.includes("--project"), true);
    assertEquals(launchCall.includes("--profile"), true);
    assertEquals(launchCall.includes("-c"), true);

    const written = getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(written[0].specName, "container");
    assertEquals(written[0].name, "web01");
    assertEquals(written[0].data.status, "Running");
  });
});

Deno.test("launch rejects a flag-like instance name before running anything", async () => {
  let ran = false;
  await withMockedCommand(() => {
    ran = true;
    return { stdout: "", code: 0 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext();

    await assertRejects(
      () =>
        model.methods.launch.execute(
          {
            name: "-rm-rf",
            image: "images:debian/12",
            vm: false,
            ephemeral: false,
            profiles: [],
            config: [],
          },
          ctx(context),
        ),
      Error,
      "Invalid instance name",
    );
    assertEquals(ran, false);
    assertEquals(getWrittenResources().length, 0);
  });
});

Deno.test("stop --force adds the flag and persists the stopped state", async () => {
  const calls: string[][] = [];
  await withMockedCommand((_cmd, args) => {
    calls.push(args);
    if (args[0] === "stop") return { stdout: "", code: 0 };
    if (args[0] === "list") {
      return { stdout: JSON.stringify([WEB01_STOPPED]), code: 0 };
    }
    return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext();

    await model.methods.stop.execute(
      { name: "web01", force: true },
      ctx(context),
    );

    const stopCall = calls.find((c) => c[0] === "stop")!;
    assertEquals(stopCall.includes("--force"), true);

    const written = getWrittenResources();
    assertEquals(written[0].specName, "container");
    assertEquals(written[0].data.status, "Stopped");
  });
});

Deno.test("delete is idempotent — a missing instance is a no-op", async () => {
  const calls: string[][] = [];
  await withMockedCommand((_cmd, args) => {
    calls.push(args);
    // Existence probe returns an empty list: the instance does not exist.
    if (args[0] === "list") return { stdout: "[]", code: 0 };
    return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext();

    await model.methods.delete.execute(
      { name: "web01", force: false },
      ctx(context),
    );

    // No `delete` subcommand should have been issued.
    assertEquals(calls.some((c) => c[0] === "delete"), false);
    assertEquals(getWrittenResources().length, 0);
  });
});

Deno.test("delete refuses a running instance without force", async () => {
  const calls: string[][] = [];
  await withMockedCommand((_cmd, args) => {
    calls.push(args);
    if (args[0] === "list") {
      return { stdout: JSON.stringify([WEB01_RUNNING]), code: 0 };
    }
    return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, code: 1 };
  }, async () => {
    const { context } = createModelTestContext();

    await assertRejects(
      () =>
        model.methods.delete.execute(
          { name: "web01", force: false },
          ctx(context),
        ),
      Error,
      "is running",
    );
    assertEquals(calls.some((c) => c[0] === "delete"), false);
  });
});

Deno.test("delete --force removes a running instance", async () => {
  const calls: string[][] = [];
  await withMockedCommand((_cmd, args) => {
    calls.push(args);
    if (args[0] === "list") {
      return { stdout: JSON.stringify([WEB01_RUNNING]), code: 0 };
    }
    if (args[0] === "delete") return { stdout: "", code: 0 };
    return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext();

    await model.methods.delete.execute(
      { name: "web01", force: true },
      ctx(context),
    );

    const deleteCall = calls.find((c) => c[0] === "delete")!;
    assertEquals(deleteCall.includes("--force"), true);
    // delete removes state; it writes no resource.
    assertEquals(getWrittenResources().length, 0);
  });
});

Deno.test("a non-zero incus exit throws before any resource is written", async () => {
  await withMockedCommand((_cmd, args) => {
    if (args[0] === "start") {
      return {
        stdout: "",
        stderr: 'Error: Instance "web01" not found',
        code: 1,
      };
    }
    return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext();

    await assertRejects(
      () => model.methods.start.execute({ name: "web01" }, ctx(context)),
      Error,
      "failed (exit 1)",
    );
    assertEquals(getWrittenResources().length, 0);
  });
});

Deno.test("an invalid project name is rejected before any command", async () => {
  let ran = false;
  await withMockedCommand(() => {
    ran = true;
    return { stdout: "", code: 0 };
  }, async () => {
    const { context } = createModelTestContext({
      globalArgs: { project: "bad project" },
    });

    await assertRejects(
      () => model.methods.sync.execute({}, ctx(context)),
      Error,
      "Invalid project",
    );
    assertEquals(ran, false);
  });
});
