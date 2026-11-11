import { expect, test } from "bun:test";
import { createSqlAuthStore } from "@armada/auth";
import {
  createApplicationVault,
  createSqlMcpLaunchPort,
  createSqlMcpRegistry,
  createSqlVaultStore,
  createTemplateService,
  type LaunchTemplate,
  type Sql,
  type TemplateRuntime,
} from "@armada/core/server";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { callSharedTool } from "../src/tool-api.ts";
import { database, ENCRYPTION_KEY, fakeBoat } from "./support.ts";

// Primary contract owner: real migrations + service-role authorization/admission, fake physical provider only.
async function fixture() {
  const { db, people } = await database();
  const sql: Sql = { query: (s, p) => db.query(s, p), transaction: (work) => db.transaction((tx) => work(tx)) };
  const service = createTemplateService(sql);
  const vault = createApplicationVault(sql, undefined);
  const actor = (userId = people.owner) => ({
    userId,
    orgs: [{ orgId: people.org, role: userId === people.admin ? ("admin" as const) : ("member" as const) }],
    via: "supabase" as const,
  });
  const rows = await db.query<{ id: string }>("select id from goldens where name='shared'");
  const goldenId = rows.rows[0]!.id;
  const v = await vault.command(actor(), "variable", "set", {
    org: people.org,
    scope: "personal",
    name: "APP_REGION",
    value: "europe\n$(not-a-command)",
  });
  const variableId = (v.item as { id: string }).id;
  const definition = {
    goldenId,
    provider: "boat",
    harness: "codex",
    model: "gpt-5.4",
    reasoningEffort: "high",
    variables: [{ key: "APP_REGION", variableId, version: 1 }],
    connections: [],
  };
  const boat = fakeBoat();
  const configured: unknown[] = [];
  const provider = {
    ...boat.provider,
    configureReadableVariables: async (r: unknown) => {
      configured.push(r);
    },
  };
  const data = createSqlData(sql)(actor());
  const credential = (await db.query<{ id: string }>("select id from credentials where kind='openai'")).rows[0]!.id;
  const runtime: TemplateRuntime = {
    stores: {
      goldens: data.goldens,
      sandboxes: data.sandboxes,
      connections: createSqlMcpLaunchPort(sql, createSqlMcpRegistry(sql, ENCRYPTION_KEY)),
      credentials: {
        resolve: async () => ({
          binding: { credentialId: credential, credentialVersion: 1 },
          env: { OPENAI_API_KEY: "test-model-only" },
          secrets: ["test-model-only"],
          codexAuthJson: false,
        }),
      },
    },
    provider: async () => provider,
    options: { sleep: async () => {} },
  };
  const create = async (user = people.owner, scope = "personal", def: unknown = definition) =>
    await service.command(actor(user), "create", {
      org: people.org,
      name: crypto.randomUUID(),
      scope,
      definition: def,
    });
  const launch = async (templateId: string, key = "request-1", extra: Record<string, unknown> = {}) =>
    service.command(
      actor(),
      "launch",
      { org: people.org, id: templateId, requestKey: key, prompt: "Inspect configuration", ...extra },
      runtime,
    );
  return {
    db,
    sql,
    people,
    actor,
    service,
    vault,
    definition,
    variableId,
    goldenId,
    boat,
    provider,
    configured,
    runtime,
    create,
    launch,
  };
}

test("immutable revisions enforce personal/org ownership, optimistic publication, tombstones and JWT grants", async () => {
  const f = await fixture();
  try {
    const created = await f.create();
    const t = created.item as LaunchTemplate;
    for (const user of [f.people.member, f.people.admin]) {
      expect((await f.service.command(f.actor(user), "list", { org: f.people.org })).items).toEqual([]);
      await expect(f.service.command(f.actor(user), "get", { org: f.people.org, id: t.id })).rejects.toMatchObject({
        code: "not_found",
      });
    }
    await expect(f.create(f.people.owner, "org")).rejects.toMatchObject({ code: "forbidden" });
    await expect(f.create(f.people.admin, "org")).rejects.toMatchObject({ code: "conflict" }); // Author's personal variable is never shareable.
    const shared = await f.create(f.people.admin, "org", { ...f.definition, variables: [] });
    const sharedId = (shared.item as LaunchTemplate).id;
    await expect(
      f.service.command(f.actor(), "delete", { org: f.people.org, id: sharedId, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const published = await f.service.command(f.actor(), "publish", {
      org: f.people.org,
      id: t.id,
      expectedRevision: 1,
      definition: { ...f.definition, model: "gpt-5.4-mini" },
    });
    expect((published.item as LaunchTemplate).currentRevision).toBe(2);
    const historical = await f.service.command(f.actor(), "get", { org: f.people.org, id: t.id, revision: 1 });
    expect((historical.revision as { definition: { model: string } }).definition.model).toBe("gpt-5.4");
    await expect(
      f.service.command(f.actor(), "publish", {
        org: f.people.org,
        id: t.id,
        expectedRevision: 1,
        definition: f.definition,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      f.db.query("update launch_template_revisions set digest=repeat('a',64) where template_id=$1", [t.id]),
    ).rejects.toThrow("immutable");
    await f.db.exec("set role anon");
    await expect(f.db.query("select * from launch_templates")).rejects.toThrow("permission denied");
    await f.db.exec("reset role");
    await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [f.people.member]);
    await f.db.exec("set role authenticated");
    expect((await f.db.query<{ id: string }>("select id from launch_templates")).rows.map((r) => r.id)).toEqual([
      sharedId,
    ]);
    expect((await f.db.query("select * from launch_template_revisions")).rows).toHaveLength(1);
    await expect(f.db.query("update launch_templates set name='bypass'")).rejects.toThrow("permission denied");
    await f.db.exec("reset role");
    await f.service.command(f.actor(), "delete", { org: f.people.org, id: t.id, expectedRevision: 2 });
    await expect(f.service.command(f.actor(), "get", { org: f.people.org, id: t.id })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(
      (await f.db.query("select * from launch_template_revisions where template_id=$1", [t.id])).rows,
    ).toHaveLength(2);
  } finally {
    await f.db.close();
  }
});

test("template launch freezes selection before allocation, delivers readable values after init, replays once and follows later rebuilds", async () => {
  const f = await fixture();
  try {
    const t = (await f.create()).item as LaunchTemplate;
    let admitted!: () => void;
    const claim = new Promise<void>((r) => {
      admitted = r;
    });
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const originalFork = f.provider.fork;
    f.provider.fork = async (request) => {
      admitted();
      await barrier;
      return originalFork(request);
    };
    const inFlight = f.launch(t.id);
    await claim;
    const before = (
      await f.db.query<{ manifest: { golden: { providerSnapshotId: string } } }>(
        "select manifest from template_launch_requests",
      )
    ).rows[0]!.manifest.golden.providerSnapshotId;
    const rebuilt = `a${"9".repeat(62)}`;
    // Same-key joins while dispatch is in flight; it cannot fork again.
    const joined = await f.launch(t.id);
    expect(joined.state).toBe("allocating");
    await f.db.query("update goldens set provider_snapshot_id=$2,boat_snapshot_id=$2 where id=$1", [
      f.goldenId,
      rebuilt,
    ]);
    release();
    const result = await inFlight;
    expect(result.state).toBe("succeeded");
    expect(f.boat.forks).toHaveLength(1);
    expect(f.boat.forks[0]!.from).toBe(before);
    expect(f.boat.forks[0]!.env).not.toHaveProperty("APP_REGION");
    expect(f.boat.execs.some((e) => e.command.includes("not-a-command"))).toBe(false);
    expect(f.configured).toEqual([
      { sandboxId: result.providerSandboxId, harness: "codex", variables: { APP_REGION: "europe\n$(not-a-command)" } },
    ]);
    expect(f.boat.prompts[0]).toMatchObject({ model: "gpt-5.4", reasoningEffort: "high" });
    expect(await f.launch(t.id)).toEqual(result);
    expect(f.boat.forks).toHaveLength(1);
    await expect(f.launch(t.id, "request-1", { prompt: "Different" })).rejects.toMatchObject({ code: "conflict" });
    await f.launch(t.id, "request-2");
    expect(f.boat.forks[1]!.from).toBe(rebuilt);
    const manifests = (
      await f.db.query<{ manifest: { revisionId: string; golden: { providerSnapshotId: string } } }>(
        "select manifest from template_launch_requests order by created_at",
      )
    ).rows;
    expect(manifests[0]!.manifest.revisionId).toBe(manifests[1]!.manifest.revisionId);
    expect(manifests[0]!.manifest.golden.providerSnapshotId).toBe(before);
    expect(manifests[1]!.manifest.golden.providerSnapshotId).toBe(rebuilt);
    await expect(f.db.query("update template_launch_requests set manifest='{}'")).rejects.toThrow("immutable");
  } finally {
    await f.db.close();
  }
});

test("unknown provider outcomes remain durable reconciling across service restart and never allocate again", async () => {
  const f = await fixture();
  try {
    const t = (await f.create()).item as LaunchTemplate;
    let calls = 0;
    f.provider.fork = async () => {
      calls++;
      throw Error("transport lost after possible allocation");
    };
    const first = await f.launch(t.id);
    expect(first.state).toBe("reconciling");
    const restarted = createTemplateService(f.sql);
    const retry = await restarted.command(
      f.actor(),
      "launch",
      { org: f.people.org, id: t.id, requestKey: "request-1", prompt: "Inspect configuration" },
      f.runtime,
    );
    expect(retry.state).toBe("reconciling");
    expect(calls).toBe(1);
    expect(f.boat.prompts).toHaveLength(0);
    // Unknown allocation keeps the existing retirement barrier through process restart.
    expect(
      (
        await f.db.query(
          "select f.id from golden_operation_fences f join template_launch_requests r on r.golden_operation_fence_id=f.id",
        )
      ).rows,
    ).toHaveLength(1);
  } finally {
    await f.db.close();
  }
});

test("changed variable, removed membership and invalid authority overrides fail before fork", async () => {
  const f = await fixture();
  try {
    const t = (await f.create()).item as LaunchTemplate;
    for (const extra of [{ env: { X: "y" } }, { connections: [] }, { model: "other" }, { secretBindings: [] }])
      await expect(f.launch(t.id, crypto.randomUUID(), extra)).rejects.toMatchObject({ code: "invalid" });
    await f.vault.command(f.actor(), "variable", "update", {
      org: f.people.org,
      id: f.variableId,
      expectedVersion: 1,
      value: "changed",
    });
    await expect(f.launch(t.id)).rejects.toMatchObject({ code: "conflict" });
    expect(f.boat.forks).toHaveLength(0);
    await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.people.org, f.people.owner]);
    await expect(f.launch(t.id)).rejects.toMatchObject({ code: "forbidden" });
    expect(f.boat.forks).toHaveLength(0);
  } finally {
    await f.db.close();
  }
});

test("HTTP and MCP share strict template operations; secure routes require authentication and no query parameters", async () => {
  const f = await fixture();
  try {
    const options: ControlOptions = {
      templates: f.service,
      store: createSqlVaultStore(f.sql),
      authStore: createSqlAuthStore(f.sql),
      encryptionKey: ENCRYPTION_KEY,
      data: createSqlData(f.sql),
      providers: { resolve: async () => f.provider },
      supabase: {
        supabaseUrl: "https://supabase.test",
        anonKey: "synthetic-anon",
        fetch: async () => Response.json({ id: f.people.owner }),
      },
    };
    const api = async (op: string, body: unknown, bearer = true, query = "") =>
      handleControlRequest(
        new Request(`https://armada.test/api/v1/templates/${op}${query}`, {
          method: "POST",
          headers: bearer ? { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig" } : {},
          body: JSON.stringify(body),
        }),
        options,
      );
    expect((await api("list", { org: f.people.org }, false))?.status).toBe(401);
    expect((await api("list", { org: f.people.org }, true, "?ignored=1"))?.status).toBe(400);
    expect(
      (
        await api("create", {
          org: f.people.org,
          name: "bad",
          scope: "personal",
          definition: { ...f.definition, secretBindings: [] },
        })
      )?.status,
    ).toBe(400);
    const created = await api("create", {
      org: f.people.org,
      name: "transport",
      scope: "personal",
      definition: f.definition,
    });
    expect(created?.status).toBe(200);
    expect(created?.headers.get("cache-control")).toBe("no-store");
    const saved = (await created!.json()) as { item: LaunchTemplate };
    const context = {
      templates: f.service,
      caller: f.actor(),
      data: createSqlData(f.sql)(f.actor()),
      provider: async () => f.provider,
      launchCredentials: f.runtime.stores.credentials,
      connections: f.runtime.stores.connections,
      exposedSecrets: async () => [],
      now: () => new Date(),
      sleep: async () => {},
    };
    const got = (await callSharedTool(context, "template_get", { org: f.people.org, id: saved.item.id })) as {
      item: LaunchTemplate;
    };
    expect(got.item.id).toBe(saved.item.id);
    await expect(
      callSharedTool(context, "template_publish", {
        org: f.people.org,
        id: saved.item.id,
        expectedRevision: 1,
        definition: { ...f.definition, env: { X: "no" } },
      }),
    ).rejects.toThrow();
    const launched = (await callSharedTool(context, "template_launch", {
      org: f.people.org,
      id: saved.item.id,
      requestKey: "transport-launch",
    })) as { state: string };
    expect(launched.state).toBe("succeeded");
  } finally {
    await f.db.close();
  }
});

test("exact connection grant generations and account versions fail closed without fallback", async () => {
  const f = await fixture();
  try {
    const registry = createSqlMcpRegistry(f.sql, ENCRYPTION_KEY);
    const connection = await registry.save(f.people.owner, f.people.org, {
      name: "one workspace",
      scope: "personal",
      transport: "http",
      url: "https://workspace.example/mcp",
      authType: "none",
    });
    const second = await registry.save(f.people.owner, f.people.org, {
      name: "other workspace",
      scope: "personal",
      transport: "http",
      url: "https://second.example/mcp",
      authType: "none",
    });
    await f.db.query("update mcp_grants set status='connected' where connection_id in ($1,$2)", [
      connection.id,
      second.id,
    ]);
    const def = { ...f.definition, connections: [connection.id, second.id] };
    const t = (await f.create(f.people.owner, "personal", def)).item as LaunchTemplate;
    const first = await f.launch(t.id);
    expect(first.state).toBe("succeeded");
    expect(
      (
        await f.db.query<{ connection_id: string }>("select connection_id from mcp_bindings order by connection_id")
      ).rows.map((r) => r.connection_id),
    ).toEqual([connection.id, second.id].sort());
    await registry.revoke(f.people.owner, f.people.org, connection.id, true);
    await expect(f.launch(t.id, "next-request")).rejects.toMatchObject({ code: "conflict" });
    expect(f.boat.forks).toHaveLength(1);
    const account = f.runtime.stores.credentials.resolve;
    const binding = await account({ userId: f.people.owner, orgId: f.people.org, role: "member" }, "codex");
    const pinned = (
      await f.create(f.people.owner, "personal", {
        ...f.definition,
        modelAccount: { id: binding.binding!.credentialId, version: 1 },
      })
    ).item as LaunchTemplate;
    await f.db.query("update credentials set value_enc=decode('01','hex') where id=$1", [
      binding.binding!.credentialId,
    ]);
    await expect(f.launch(pinned.id, "stale-account")).rejects.toMatchObject({ code: "conflict" });
    expect(f.boat.forks).toHaveLength(1);
  } finally {
    await f.db.close();
  }
});

test("reference revocation during initialization stops the allocated sandbox before variable delivery or first prompt", async () => {
  const f = await fixture();
  try {
    const t = (await f.create()).item as LaunchTemplate;
    const exec = f.provider.exec;
    let changed = false;
    f.provider.exec = async (request) => {
      if (!changed) {
        changed = true;
        await f.vault.command(f.actor(), "variable", "update", {
          org: f.people.org,
          id: f.variableId,
          expectedVersion: 1,
          value: "changed-during-init",
        });
      }
      return exec(request);
    };
    const result = await f.launch(t.id);
    expect(result).toMatchObject({ state: "reconciling", reason: "variable_version_changed" });
    expect(f.boat.forks).toHaveLength(1);
    expect(f.boat.prompts).toHaveLength(0);
    expect(f.configured).toHaveLength(0);
    expect(f.boat.stops).toHaveLength(1);
  } finally {
    await f.db.close();
  }
});

test("a rebuild published during provider selection cannot replace or invalidate the already claimed snapshot", async () => {
  const f = await fixture();
  try {
    const template = (await f.create()).item as LaunchTemplate;
    const rebuilt = `a${"8".repeat(62)}`;
    let frozen = "";
    let rebuild = true;
    f.runtime.provider = async (golden) => {
      if (rebuild) {
        rebuild = false;
        frozen = golden.providerSnapshotId ?? "";
        // After immutable request claim, but BEFORE normal launch's beginOperation.
        await f.db.query("update goldens set provider_snapshot_id=$2,boat_snapshot_id=$2 where id=$1", [
          f.goldenId,
          rebuilt,
        ]);
      }
      return f.provider;
    };
    const first = await f.launch(template.id);
    expect(first.state).toBe("succeeded");
    expect(f.boat.forks.map((fork) => fork.from)).toEqual([frozen]);
    expect(await f.launch(template.id)).toEqual(first);
    expect(f.boat.forks).toHaveLength(1);
    expect((await f.launch(template.id, "after-rebuild")).state).toBe("succeeded");
    expect(f.boat.forks.map((fork) => fork.from)).toEqual([frozen, rebuilt]);
    expect((await f.db.query("select id from golden_operation_fences")).rows).toHaveLength(0);
    await expect(
      f.db.query("update template_launch_requests set golden_operation_fence_id=gen_random_uuid()"),
    ).rejects.toThrow("immutable");
  } finally {
    await f.db.close();
  }
});

test("claimed snapshot fences release on pre-adoption launch refusals without losing request tombstones", async () => {
  const f = await fixture();
  try {
    const template = (await f.create()).item as LaunchTemplate;
    f.runtime.provider = async () => {
      throw Error("provider routing unavailable before launch");
    };
    expect((await f.launch(template.id, "routing-refusal")).state).toBe("failed");
    expect((await f.db.query("select id from golden_operation_fences")).rows).toHaveLength(0);
    f.runtime.provider = async () => f.provider;
    expect((await f.launch(template.id, "ttl-refusal", { ttlSeconds: 3000000 })).state).toBe("failed");
    expect((await f.db.query("select id from golden_operation_fences")).rows).toHaveLength(0);
    expect((await f.db.query("select id from template_launch_requests")).rows).toHaveLength(2);
    expect(f.boat.forks).toHaveLength(0);
  } finally {
    await f.db.close();
  }
});
