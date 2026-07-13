import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { type GlobalArgs, type MethodContext, model } from "./ca.ts";

// createModelTestContext types globalArgs as Record<string, unknown> (it isn't
// generic over the model's GlobalArgs), so a cast is required to satisfy this
// model's stricter MethodContext interface.
function ctx(context: unknown): MethodContext {
  return context as MethodContext;
}

const BASE: GlobalArgs = {
  caName: "Test CA",
  dnsNames: ["localhost"],
  provisionerPassword: "test-password",
  provisionerName: "admin",
  port: 9000,
  address: ":9000",
  image: "smallstep/step-ca",
  containerName: "step-ca",
  volume: "step",
  remoteManagement: false,
  acme: false,
  ssh: false,
  dockerBinary: "docker",
};

interface FakeDaemon {
  hasContainer: boolean;
  running: boolean;
  initialized: boolean;
  daemonUp: boolean;
}

// Stateful mock of the docker CLI. Mutates `state` so that e.g. `docker run -d`
// makes a subsequent fingerprint read succeed, mirroring the real lifecycle.
function dockerMock(state: FakeDaemon) {
  return (_cmd: string, args: string[]) => {
    const sub = args[0];
    if (sub === "version") {
      return state.daemonUp ? { stdout: "27.0.0\n", code: 0 } : {
        stdout: "",
        stderr: "Cannot connect to the Docker daemon",
        code: 1,
      };
    }
    if (sub === "inspect") {
      if (!state.hasContainer) {
        return { stdout: "", stderr: "No such object: step-ca", code: 1 };
      }
      const status = state.running ? "running" : "exited";
      return {
        stdout: `abc123|${status}|${state.running}|2026-07-13T00:00:00Z`,
        code: 0,
      };
    }
    // Fingerprint read from the volume (throwaway container).
    if (sub === "run" && args.includes("certificate")) {
      return state.initialized ? { stdout: "FP123ABC\n", code: 0 } : {
        stdout: "",
        stderr: "open /home/step/certs/root_ca.crt: no such file",
        code: 1,
      };
    }
    // Detached server boot — auto-initializes the volume.
    if (sub === "run" && args.includes("-d")) {
      state.hasContainer = true;
      state.running = true;
      state.initialized = true;
      return { stdout: "newcontainerid\n", code: 0 };
    }
    if (sub === "start") {
      state.running = true;
      return { stdout: "step-ca\n", code: 0 };
    }
    if (sub === "rm") {
      state.hasContainer = false;
      state.running = false;
      return { stdout: "step-ca\n", code: 0 };
    }
    if (sub === "exec" && args.includes("health")) {
      return state.running
        ? { stdout: "ok\n", code: 0 }
        : { stdout: "", stderr: "container not running", code: 1 };
    }
    return {
      stdout: "",
      stderr: `unexpected docker ${args.join(" ")}`,
      code: 1,
    };
  };
}

Deno.test("up bootstraps a fresh CA on an empty volume", async () => {
  const state: FakeDaemon = {
    hasContainer: false,
    running: false,
    initialized: false,
    daemonUp: true,
  };
  await withMockedCommand(dockerMock(state), async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: BASE,
    });
    await model.methods.up.execute({}, ctx(context));

    const written = getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(written[0].specName, "ca");
    const d = written[0].data;
    assertEquals(d.initializedNow, true);
    assertEquals(d.running, true);
    assertEquals(d.containerId, "newcontainerid");
    assertEquals(d.rootFingerprint, "FP123ABC");
    assertEquals(d.caUrl, "https://localhost:9000");
  });
});

Deno.test("up on an already-running container does not re-initialize", async () => {
  const state: FakeDaemon = {
    hasContainer: true,
    running: true,
    initialized: true,
    daemonUp: true,
  };
  await withMockedCommand(dockerMock(state), async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: BASE,
    });
    await model.methods.up.execute({}, ctx(context));

    const d = getWrittenResources()[0].data;
    assertEquals(d.initializedNow, false);
    assertEquals(d.running, true);
    assertEquals(d.containerId, "abc123");
    assertEquals(d.rootFingerprint, "FP123ABC");
  });
});

Deno.test("up starts a stopped container without re-initializing", async () => {
  const state: FakeDaemon = {
    hasContainer: true,
    running: false,
    initialized: true,
    daemonUp: true,
  };
  await withMockedCommand(dockerMock(state), async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: BASE,
    });
    await model.methods.up.execute({}, ctx(context));

    const d = getWrittenResources()[0].data;
    assertEquals(d.initializedNow, false);
    assertEquals(d.running, true);
    assertEquals(d.containerId, "abc123");
    assertEquals(state.running, true);
  });
});

Deno.test("status reports a running, healthy CA", async () => {
  const state: FakeDaemon = {
    hasContainer: true,
    running: true,
    initialized: true,
    daemonUp: true,
  };
  await withMockedCommand(dockerMock(state), async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: BASE,
    });
    await model.methods.status.execute({}, ctx(context));

    const written = getWrittenResources();
    assertEquals(written[0].specName, "status");
    const d = written[0].data;
    assertEquals(d.exists, true);
    assertEquals(d.running, true);
    assertEquals(d.state, "running");
    assertEquals(d.healthy, true);
    assertEquals(d.health, "ok");
    assertEquals(d.rootFingerprint, "FP123ABC");
  });
});

Deno.test("status reports an absent container", async () => {
  const state: FakeDaemon = {
    hasContainer: false,
    running: false,
    initialized: false,
    daemonUp: true,
  };
  await withMockedCommand(dockerMock(state), async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: BASE,
    });
    await model.methods.status.execute({}, ctx(context));

    const d = getWrittenResources()[0].data;
    assertEquals(d.exists, false);
    assertEquals(d.running, false);
    assertEquals(d.state, "absent");
    assertEquals(d.healthy, false);
    assertEquals(d.health, "no such container");
    assertEquals(d.rootFingerprint, null);
  });
});

Deno.test("down removes the container but the volume (fingerprint) survives", async () => {
  const state: FakeDaemon = {
    hasContainer: true,
    running: true,
    initialized: true,
    daemonUp: true,
  };
  await withMockedCommand(dockerMock(state), async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: BASE,
    });
    await model.methods.down.execute({}, ctx(context));

    const d = getWrittenResources()[0].data;
    assertEquals(d.exists, false);
    assertEquals(d.running, false);
    assertEquals(d.state, "removed");
    // Volume persists, so the CA fingerprint is still readable.
    assertEquals(d.rootFingerprint, "FP123ABC");
    assertEquals(state.hasContainer, false);
  });
});

Deno.test("down on an absent container is a no-op", async () => {
  const state: FakeDaemon = {
    hasContainer: false,
    running: false,
    initialized: false,
    daemonUp: true,
  };
  await withMockedCommand(dockerMock(state), async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: BASE,
    });
    await model.methods.down.execute({}, ctx(context));

    const d = getWrittenResources()[0].data;
    assertEquals(d.exists, false);
    assertEquals(d.state, "absent");
    assertEquals(d.rootFingerprint, null);
  });
});

Deno.test("up throws when the docker daemon is unavailable", async () => {
  const state: FakeDaemon = {
    hasContainer: false,
    running: false,
    initialized: false,
    daemonUp: false,
  };
  await withMockedCommand(dockerMock(state), async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: BASE,
    });
    await assertRejects(
      () => model.methods.up.execute({}, ctx(context)),
      Error,
      "Docker daemon not available",
    );
    assertEquals(getWrittenResources().length, 0);
  });
});
