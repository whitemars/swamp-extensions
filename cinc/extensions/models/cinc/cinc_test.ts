import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { type MethodContext, model } from "./cinc.ts";

// createModelTestContext's returned context types globalArgs as
// Record<string, unknown> (the library isn't generic over the model's own
// GlobalArgs shape), so a cast is required to satisfy this model's stricter
// MethodContext interface.
function ctx(context: unknown): MethodContext {
  return context as MethodContext;
}

// `status` and `filter` fetch the fleet with a single `knife search -a …`,
// which returns rows keyed by node name holding only the requested attributes.
const OK_NODE_ROW = {
  "web01.example.org": {
    ohai_time: Math.floor(Date.now() / 1000) - 3600, // 1h ago: within staleHours
    chef_environment: "production",
    ipaddress: "203.0.113.10",
    platform: "ubuntu",
    platform_version: "22.04",
    policy_name: "base",
    policy_group: "production",
  },
};

const NEVER_CONVERGED_ROW = {
  "web02.example.org": {
    ohai_time: null,
    chef_environment: "production",
    ipaddress: "203.0.113.11",
    platform: "ubuntu",
    platform_version: "22.04",
    policy_name: null,
    policy_group: null,
  },
};

Deno.test("status fetches all nodes in one knife search and classifies them", async () => {
  let searchCalls = 0;
  await withMockedCommand((cmd, args) => {
    if (args.includes("search")) {
      searchCalls++;
      return {
        stdout: JSON.stringify({ rows: [OK_NODE_ROW, NEVER_CONVERGED_ROW] }),
        code: 0,
      };
    }
    return { stdout: "", stderr: `unexpected knife invocation: ${cmd} ${args.join(" ")}`, code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { staleHours: 24, criticalHours: 168 },
    });

    await model.methods.status.execute({}, ctx(context));

    // The whole fleet's health — including policy fields — comes from a
    // SINGLE server round-trip. This is the crux of the optimization.
    assertEquals(searchCalls, 1);

    const written = getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(written[0].specName, "nodeHealth");

    const nodes = written[0].data.nodes as Array<Record<string, unknown>>;
    const web01 = nodes.find((n) => n.name === "web01.example.org")!;
    const web02 = nodes.find((n) => n.name === "web02.example.org")!;

    assertEquals(web01.healthStatus, "ok");
    assertEquals(web01.ip, "203.0.113.10"); // mapped from the ipaddress attribute
    assertEquals(web01.policyName, "base");
    assertEquals(web01.policyGroup, "production");

    // Never-converged node: search returned explicit nulls, not undefined —
    // the schema must accept null, not just optional-absent.
    assertEquals(web02.healthStatus, "never_converged");
    assertEquals(web02.policyName, null);
    assertEquals(web02.policyGroup, null);

    assertEquals(written[0].data.summary, {
      total: 2,
      ok: 1,
      stale: 0,
      critical: 0,
      neverConverged: 1,
    });
  });
});

Deno.test("status throws before writing when the node search fails", async () => {
  await withMockedCommand((_cmd, args) => {
    // Fail the fleet search; let the knife `--version` probe succeed so
    // resolveKnife settles without masking the search failure.
    if (args.includes("search")) {
      return { stdout: "", stderr: "ERROR: Connection refused", code: 1 };
    }
    return { stdout: "", code: 0 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { staleHours: 24, criticalHours: 168 },
    });

    await assertRejects(
      () => model.methods.status.execute({}, ctx(context)),
      Error,
      "knife search failed",
    );
    assertEquals(getWrittenResources().length, 0);
  });
});

Deno.test("show returns node detail for a converged node", async () => {
  await withMockedCommand((_cmd, args) => {
    if (args.includes("show")) {
      return {
        stdout: JSON.stringify({
          name: "web01.example.org",
          chef_environment: "production",
          policy_name: "base",
          policy_group: "production",
          run_list: ["recipe[base]"],
          platform: "ubuntu",
          platform_version: "22.04",
          ip: "203.0.113.10",
          ohai_time: Math.floor(Date.now() / 1000) - 60,
          normal: { tags: ["web"] },
        }),
        code: 0,
      };
    }
    return { stdout: "", stderr: "unexpected call", code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { staleHours: 24, criticalHours: 168 },
    });

    await model.methods.show.execute({ nodeName: "web01.example.org" }, ctx(context));

    const written = getWrittenResources();
    assertEquals(written[0].specName, "nodeDetail");
    assertEquals(written[0].data.healthStatus, "ok");
    assertEquals(written[0].data.tags, ["web"]);
  });
});

Deno.test("show throws before writing when the node does not exist", async () => {
  await withMockedCommand(() => {
    return { stdout: "", stderr: "ERROR: The object you are looking for could not be found", code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext();

    await assertRejects(
      () => model.methods.show.execute({ nodeName: "missing.example.org" }, ctx(context)),
      Error,
    );
    assertEquals(getWrittenResources().length, 0);
  });
});

Deno.test("checkPackage separates current from outdated versions against minVersion", async () => {
  await withMockedCommand((_cmd, args) => {
    if (args.includes("search")) {
      return {
        stdout: JSON.stringify({
          rows: [
            {
              "web01.example.org": {
                packages: { "openssl-3.0.9": { version: "3.0.9-1", arch: "amd64", status: "installed" } },
              },
            },
            {
              "web02.example.org": {
                packages: { "openssl-1.1.1": { version: "1.1.1-1", arch: "amd64", status: "installed" } },
              },
            },
          ],
        }),
        code: 0,
      };
    }
    return { stdout: "", stderr: "unexpected call", code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext();

    await model.methods.checkPackage.execute(
      { packageName: "openssl", showMissing: false, minVersion: "3.0.0" },
      ctx(context),
    );

    const data = getWrittenResources()[0].data as {
      current: Array<{ name: string }>;
      outdated: Array<{ name: string }>;
      summary: { total: number; installed: number; current: number; outdated: number; missing: number };
    };
    assertEquals(data.current.map((e) => e.name), ["web01.example.org"]);
    assertEquals(data.outdated.map((e) => e.name), ["web02.example.org"]);
    assertEquals(data.summary, { total: 2, installed: 2, current: 1, outdated: 1, missing: 0 });
  });
});

Deno.test("filter reports the matching status in summary, not zeros", async () => {
  await withMockedCommand((_cmd, args) => {
    if (args.includes("search")) {
      return {
        stdout: JSON.stringify({ rows: [OK_NODE_ROW, NEVER_CONVERGED_ROW] }),
        code: 0,
      };
    }
    return { stdout: "", stderr: "unexpected call", code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { staleHours: 24, criticalHours: 168 },
    });

    await model.methods.filter.execute({ status: "never_converged" }, ctx(context));

    const written = getWrittenResources()[0];
    assertEquals(written.specName, "nodeHealth");
    const nodes = written.data.nodes as Array<Record<string, unknown>>;
    assertEquals(nodes.map((n) => n.name), ["web02.example.org"]);
    assertEquals(written.data.summary, {
      total: 1,
      ok: 0,
      stale: 0,
      critical: 0,
      neverConverged: 1,
    });
  });
});

Deno.test("search returns attribute rows and logs on entry and completion", async () => {
  await withMockedCommand((_cmd, args) => {
    if (args.includes("search")) {
      return {
        stdout: JSON.stringify({
          total: 2,
          rows: [
            { "web01.example.org": { platform: "ubuntu" } },
            { "web02.example.org": { platform: "centos" } },
          ],
        }),
        code: 0,
      };
    }
    return { stdout: "", stderr: "unexpected call", code: 1 };
  }, async () => {
    const { context, getWrittenResources, getLogs } = createModelTestContext();

    await model.methods.search.execute(
      { query: "platform:*", index: "node", attributes: ["platform"] },
      ctx(context),
    );

    const written = getWrittenResources()[0];
    assertEquals(written.specName, "searchResult");
    assertEquals(written.data.total, 2);
    assertEquals(
      (written.data.rows as Array<{ name: string }>).map((r) => r.name),
      ["web01.example.org", "web02.example.org"],
    );

    const logs = getLogs();
    assertEquals(logs.length > 0, true);
  });
});

Deno.test("search throws before writing when the query is invalid", async () => {
  await withMockedCommand(() => {
    return { stdout: "", stderr: "ERROR: invalid search query", code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext();

    await assertRejects(
      () =>
        model.methods.search.execute(
          { query: "not a valid query(((", index: "node" },
          ctx(context),
        ),
      Error,
    );
    assertEquals(getWrittenResources().length, 0);
  });
});

Deno.test("acl returns permission grants for an object", async () => {
  await withMockedCommand((_cmd, args) => {
    if (args.includes("acl")) {
      return {
        stdout: JSON.stringify({
          create: { groups: ["admins"] },
          read: { groups: ["admins", "users"] },
          update: { groups: ["admins"] },
          delete: { groups: ["admins"] },
          grant: { groups: ["admins"] },
        }),
        code: 0,
      };
    }
    return { stdout: "", stderr: "unexpected call", code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext();

    await model.methods.acl.execute(
      { objectType: "groups", objectName: "admins" },
      ctx(context),
    );

    const written = getWrittenResources()[0];
    assertEquals(written.specName, "aclInfo");
    assertEquals(
      (written.data.perms as { read: { groups: string[] } }).read.groups,
      ["admins", "users"],
    );
  });
});

Deno.test("acl throws before writing when the object does not exist", async () => {
  await withMockedCommand(() => {
    return { stdout: "", stderr: "ERROR: The object you are looking for could not be found", code: 1 };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext();

    await assertRejects(
      () =>
        model.methods.acl.execute(
          { objectType: "groups", objectName: "missing-group" },
          ctx(context),
        ),
      Error,
    );
    assertEquals(getWrittenResources().length, 0);
  });
});

Deno.test("group show requires a group name", async () => {
  const { context } = createModelTestContext();

  await assertRejects(
    () => model.methods.group.execute({ action: "show" }, ctx(context)),
    Error,
    "group is required",
  );
});
