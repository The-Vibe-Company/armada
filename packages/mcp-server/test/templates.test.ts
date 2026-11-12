import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqlAuthStore } from "@armada/auth";
import {
  createApplicationVault,
  createSkillDefaultsService,
  createSqlMcpLaunchPort,
  createSqlMcpRegistry,
  createSqlVaultStore,
  createTemplateService,
  encryptSecret,
  type LaunchTemplate,
  launchSandbox,
  PrivateSkillError,
  ProviderError,
  type Sql,
  type TemplateRuntime,
} from "@armada/core/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AUTH_HEADER, CodexDriver, Journal, Runner } from "../../agent-runtime/src/index.ts";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createMcpLifecycle } from "../src/mcp-lifecycle.ts";
import { callSharedTool } from "../src/tool-api.ts";
import { createArmadaServer } from "../src/tools.ts";
import { database, ENCRYPTION_KEY, fakeBoat } from "./support.ts";

// Primary contract owner: real migrations + service-role authorization/admission, fake physical provider only.
async function fixture() {
  const { db, people } = await database();
  const queries: string[] = [];
  const sql: Sql = {
    query: (s, p) => {
      queries.push(s);
      return db.query(s, p);
    },
    transaction: (work) => db.transaction((tx) => work(tx)),
  };
  const service = createTemplateService(sql, ENCRYPTION_KEY);
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
    queries,
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

for (const mode of ["before_commit", "after_commit", "both_before_commit", "both_after_commit"] as const) {
  test(`template launch result publication recovers without redispatch (${mode})`, async () => {
    const f = await fixture();
    const query = f.sql.query.bind(f.sql);
    let publications = 0;
    const injected = spyOn(f.sql, "query").mockImplementation(async <T>(text: string, params?: unknown[]) => {
      if (!text.startsWith("update public.template_launch_requests set state='succeeded'"))
        return query<T>(text, params);
      publications++;
      const lose = publications === 1 || mode.startsWith("both_");
      if (lose && mode.endsWith("before_commit")) throw Error("publication transport unavailable");
      const result = await query<T>(text, params);
      if (lose) throw Error("publication acknowledgement lost");
      return result;
    });
    try {
      const t = (await f.create()).item as LaunchTemplate;
      const result = await f.launch(t.id);
      const row = (
        await f.db.query<{ state: string; result: unknown }>(
          "select state,result from template_launch_requests where id=$1",
          [result.requestId],
        )
      ).rows[0]!;
      const expected = mode === "both_before_commit" ? "reconciling" : "succeeded";
      expect(row.state).toBe(expected);
      expect(publications).toBe(2);
      if (mode.startsWith("both_")) expect(result.state).toBe("reconciling");
      else expect(result.state).toBe("succeeded");
      const restarted = createTemplateService(f.sql);
      const replay = await restarted.command(
        f.actor(),
        "launch",
        {
          org: f.people.org,
          id: t.id,
          requestKey: "request-1",
          prompt: "Inspect configuration",
        },
        f.runtime,
      );
      expect(replay.state).toBe(expected);
      if (expected === "succeeded") {
        expect(row.result).toEqual(replay);
        const sandbox = (
          await f.db.query<{ task_prompt_id: string }>("select task_prompt_id from sandboxes where id=$1", [replay.id])
        ).rows[0]!;
        expect(replay.promptId).toBe(sandbox.task_prompt_id);
      } else expect(row.result).toBeNull();
      expect(f.boat.forks).toHaveLength(1);
      expect(f.boat.prompts).toHaveLength(1);
    } finally {
      injected.mockRestore();
      await f.db.close();
    }
  });
}

for (const retained of [false, true]) {
  test(`template allocation quota refusal is terminal only without retained evidence (${retained})`, async () => {
    const f = await fixture();
    try {
      const t = (await f.create()).item as LaunchTemplate;
      let calls = 0;
      f.provider.fork = async () => {
        calls++;
        throw new ProviderError({
          provider: "boat",
          code: "rate_limited",
          status: 429,
          retryable: false,
          message: "Daily starts exhausted",
          ...(retained ? { details: { keepSource: true } } : {}),
        });
      };
      const result = await f.launch(t.id);
      expect(result).toMatchObject(
        retained
          ? { state: "reconciling", reason: "allocation_or_start_unknown" }
          : { state: "failed", reason: "provider_rate_limited" },
      );
      expect(await f.launch(t.id)).toEqual(result);
      expect(calls).toBe(1);
      expect((await f.db.query("select id from sandboxes")).rows).toHaveLength(0);
      expect((await f.db.query("select id from golden_operation_fences")).rows).toHaveLength(retained ? 1 : 0);
    } finally {
      await f.db.close();
    }
  });
}

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
    // A visible Claude template without a compatible account is an admission refusal, never a missing template.
    await f.db.query("delete from credentials where kind in ('anthropic','claude_oauth')");
    const claude = (
      await f.create(f.people.owner, "personal", {
        ...f.definition,
        harness: "claude",
        model: "claude-opus-5-5",
        reasoningEffort: "medium",
      })
    ).item as LaunchTemplate;
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const [reason, accounts, status] of [
        ["model_account_unavailable", 0, "active"],
        ["model_account_ambiguous", 2, "active"],
        ["model_account_refused", 1, "revoked"],
      ] as const) {
        await f.db.query("delete from credentials where kind='anthropic'");
        for (let i = 0; i < accounts; i++)
          await f.db.query(
            "insert into credentials(scope,owner_id,kind,value_enc,status) select 'user',$1,'anthropic',value_enc,$2 from credentials where kind='openai' limit 1",
            [f.people.owner, status],
          );
        warning.mockClear();
        const refused = await api("launch", { org: f.people.org, id: claude.id, requestKey: reason });
        expect(refused?.status).toBe(409);
        expect(await refused!.json()).toEqual({
          error: { code: "conflict", message: `Template launch refused: ${reason}.` },
        });
        expect(warning.mock.calls).toEqual([
          ["armada: template launch refused", { reason, templateId: claude.id, orgId: f.people.org }],
        ]);
        expect(f.boat.forks).toHaveLength(0);
        expect((await f.db.query("select id from template_launch_requests")).rows).toHaveLength(0);
        expect((await api("get", { org: f.people.org, id: claude.id }))?.status).toBe(200);
      }
      expect(
        (await api("launch", { org: f.people.org, id: crypto.randomUUID(), requestKey: "missing-template" }))?.status,
      ).toBe(404);
    } finally {
      warning.mockRestore();
    }
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
    // Routine OAuth refresh after publication must not require a new template revision.
    await f.db.query("update mcp_grants set version=version+1 where connection_id in ($1,$2)", [
      connection.id,
      second.id,
    ]);
    const first = await f.launch(t.id);
    expect(first.state).toBe("succeeded");
    const saved = await f.service.command(f.actor(), "get", { org: f.people.org, id: t.id });
    expect((saved.revision as { definition: { connections: string[] } }).definition.connections).toEqual([
      connection.id,
      second.id,
    ]);
    expect(
      (first.manifest as { connections: { id: string; version: number; generation: number }[] }).connections.map(
        (c) => ({ id: c.id, version: c.version }),
      ),
    ).toEqual([
      { id: connection.id, version: 2 },
      { id: second.id, version: 2 },
    ]);
    expect(
      (
        await f.db.query<{ connection_id: string }>("select connection_id from mcp_bindings order by connection_id")
      ).rows.map((r) => r.connection_id),
    ).toEqual([connection.id, second.id].sort());
    f.runtime.provider = async () => {
      await f.db.query("update mcp_grants set version=version+1 where connection_id=$1", [connection.id]);
      return f.provider;
    };
    expect(await f.launch(t.id, "refresh-during-admission")).toMatchObject({
      state: "failed",
      reason: "connection_version_changed",
    });
    expect(f.boat.forks).toHaveLength(1);
    f.runtime.provider = async () => f.provider;
    expect((await f.launch(t.id, "after-refresh")).state).toBe("succeeded");
    await registry.revoke(f.people.owner, f.people.org, connection.id, true);
    await expect(f.launch(t.id, "next-request")).rejects.toMatchObject({ code: "conflict" });
    expect(f.boat.forks).toHaveLength(2);
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
    expect(f.boat.forks).toHaveLength(2);
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

test("later readable preparation survives variable edits, template tombstones and role changes", async () => {
  const f = await fixture();
  try {
    const template = (await f.create()).item as LaunchTemplate;
    const launched = await f.launch(template.id);
    await f.vault.command(f.actor(), "variable", "update", {
      org: f.people.org,
      id: f.variableId,
      expectedVersion: 1,
      value: "replacement",
    });
    await f.service.command(f.actor(), "delete", { org: f.people.org, id: template.id, expectedRevision: 1 });
    await f.db.query("update members set role='admin' where org_id=$1 and user_id=$2", [f.people.org, f.people.owner]);
    const lifecycle = createMcpLifecycle({
      sql: f.sql,
      registry: createSqlMcpRegistry(f.sql, ENCRYPTION_KEY),
      encryptionKey: ENCRYPTION_KEY,
      origin: "https://armada.test",
      prepareReadableVariables: f.service.prepare,
    });
    await lifecycle.beforePrompt(f.provider, launched.providerSandboxId as string, {
      userId: f.people.owner,
      orgId: f.people.org,
    });
    expect(f.configured).toHaveLength(2);
    expect(f.configured[1]).toMatchObject({ variables: { APP_REGION: "europe\n$(not-a-command)" } });
    await f.provider.prompt({
      sandboxId: launched.providerSandboxId as string,
      harness: "codex",
      text: "Continue with frozen values",
    });
    await expect(
      lifecycle.beforePrompt(f.provider, launched.providerSandboxId as string, {
        userId: f.people.member,
        orgId: f.people.org,
      }),
    ).rejects.toThrow("No authorized Armada sandbox");
    await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.people.org, f.people.owner]);
    await expect(
      f.service.prepare(
        f.provider,
        launched.providerSandboxId as string,
        { userId: f.people.owner, orgId: f.people.org },
        launched.requestId as string,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(f.configured).toHaveLength(2);
  } finally {
    await f.db.close();
  }
});

test("ordinary prompt admission performs no additional template queries or provider bootstrap", async () => {
  const f = await fixture();
  try {
    const launched = await launchSandbox(
      f.provider,
      f.runtime.stores,
      { userId: f.people.owner, orgId: f.people.org, role: "member" },
      { golden: "shared", provider: "boat", harness: "codex", connections: [] },
    );
    const options = {
      sql: f.sql,
      registry: createSqlMcpRegistry(f.sql, ENCRYPTION_KEY),
      encryptionKey: ENCRYPTION_KEY,
      origin: "https://armada.test",
    };
    const ordinary = createMcpLifecycle(options);
    const withTemplates = createMcpLifecycle({ ...options, prepareReadableVariables: f.service.prepare });
    const actor = { userId: f.people.owner, orgId: f.people.org };
    f.queries.length = 0;
    await ordinary.beforePrompt(f.provider, launched.sandbox.providerSandboxId, actor);
    const baseline = f.queries.length;
    f.queries.length = 0;
    await withTemplates.beforePrompt(f.provider, launched.sandbox.providerSandboxId, actor);
    expect(f.queries).toHaveLength(baseline);
    expect(f.configured).toHaveLength(0);
    // A fresh read sees a newly admitted template; there is no negative process cache.
    const template = (await f.create()).item as LaunchTemplate;
    const fromTemplate = await f.launch(template.id);
    await withTemplates.beforePrompt(f.provider, fromTemplate.providerSandboxId as string, actor);
    expect(f.configured).toHaveLength(2);
  } finally {
    await f.db.close();
  }
});

test.skipIf(process.platform !== "linux")(
  "a replacement Modal runner receives frozen readable values again before the next native turn",
  async () => {
    const f = await fixture();
    const root = await mkdtemp(join(tmpdir(), "template-restore-"));
    const generations: { driver: CodexDriver; journal: Journal }[] = [];
    try {
      const generation = async (name: string) => {
        const cwd = join(root, name);
        await mkdir(cwd);
        const proof = join(cwd, "proof.json");
        const driver = new CodexDriver({
          executable: join(import.meta.dir, "../../agent-runtime/test/fixtures/app-server.ts"),
          cwd,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ARMADA_READABLE_INSPECTION: proof },
        });
        const journal = new Journal(join(cwd, "journal"), (s) => s);
        const grant = {
          token: crypto.randomUUID(),
          sandboxId: "runtime",
          generation: name,
          expiresAt: Date.now() + 60000,
        };
        const runner = new Runner(journal, grant, { claude: driver, codex: driver });
        generations.push({ driver, journal });
        const inspect = async () => {
          const turn = driver.start({
            request: { sandboxId: "runtime", harness: "codex", text: "message-semantics" },
            signal: new AbortController().signal,
            session: () => {},
            emit: () => {},
          });
          await turn.done;
          return JSON.parse(await readFile(proof, "utf8"));
        };
        return { runner, grant, inspect };
      };
      let active = await generation("modal-incarnation-1");
      // Transparent provider transport into the actual private runner/native driver, not a hydration mock.
      f.provider.configureReadableVariables = async (input) => {
        const request = input as { harness: string; variables: Record<string, string> };
        const result = await active.runner.handle(
          new Request("https://private-runner", {
            method: "POST",
            headers: { [AUTH_HEADER]: active.grant.token },
            body: JSON.stringify({
              version: 1,
              requestId: crypto.randomUUID(),
              op: "configureReadableVariables",
              ...request,
              sandboxId: active.grant.sandboxId,
            }),
          }),
        );
        if (result.status !== 200) throw Error("Native readable bootstrap refused");
      };
      const template = (await f.create()).item as LaunchTemplate;
      const launched = await f.launch(template.id);
      expect(launched.state).toBe("succeeded");
      active = await generation("modal-incarnation-2");
      expect(await active.inspect()).toEqual({}); // A fresh physical runner has no retained application environment.
      const lifecycle = createMcpLifecycle({
        sql: f.sql,
        registry: createSqlMcpRegistry(f.sql, ENCRYPTION_KEY),
        encryptionKey: ENCRYPTION_KEY,
        origin: "https://armada.test",
        prepareReadableVariables: f.service.prepare,
      });
      await lifecycle.beforePrompt(f.provider, launched.providerSandboxId as string, {
        userId: f.people.owner,
        orgId: f.people.org,
      });
      expect(await active.inspect()).toEqual({ region: "europe\n$(not-a-command)" });
    } finally {
      for (const g of generations) {
        await g.driver.close();
        g.journal.close();
      }
      await f.db.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

// Contract: installation evidence survives request replay, without mutating the
// admission manifest. Physical transports are covered by the install owners.
test("template skills retain verified receipts and closed refusals without replaying installs", async () => {
  const f = await fixture();
  try {
    const skills = ["example/review@1.0.0", "notes@2.0.0"];
    const checksum = `sha256:${"a".repeat(64)}`;
    const publicId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const privateReceipt = {
      workspaceId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      reference: skills[1]!,
      version: "2.0.0",
      skillId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      checksum,
      origin: "https://skillpack.app/v1",
    };
    const exec = f.provider.exec;
    f.provider.exec = async (r) => {
      const result = await exec(r);
      if (!result.detached && r.command.includes("skillpack install"))
        result.stdout = JSON.stringify({
          lockfileVersion: 3,
          workspaces: {
            "catalog:example": {
              apiUrl: "https://skillpack.app/v1",
              skills: {
                review: {
                  version: "1.0.0",
                  catalogReference: "example/review",
                  pinned: "1.0.0",
                  skillId: publicId,
                  checksum,
                  targets: [{ tool: "codex", version: "1.0.0", packageChecksum: checksum }],
                },
              },
            },
          },
        });
      return result;
    };
    let installs = 0;
    f.runtime.stores.credentials.installPrivateSkill = async () => {
      installs++;
      return privateReceipt;
    };
    const t = (await f.create(undefined, undefined, { ...f.definition, skills })).item as LaunchTemplate;
    const result = await f.launch(t.id);
    expect(result.state).toBe("succeeded");
    expect(result.manifest).toMatchObject({
      definition: { skills },
      skillReceipts: [
        { reference: skills[0], version: "1.0.0", skillId: publicId, checksum, origin: "https://skillpack.app/v1" },
        privateReceipt,
      ],
    });
    const stored = (await f.db.query<{ skills: unknown }>("select skills from sandboxes where id=$1", [result.id]))
      .rows[0]!;
    expect(stored.skills).toEqual((result.manifest as { skillReceipts: unknown }).skillReceipts);
    const admitted = (await f.db.query<{ manifest: unknown }>("select manifest from template_launch_requests"))
      .rows[0]!;
    expect(admitted.manifest).not.toHaveProperty("skillReceipts");
    expect(await f.launch(t.id)).toEqual(result);
    expect(installs).toBe(1);
    expect(f.boat.forks).toHaveLength(1);

    f.runtime.stores.credentials.installPrivateSkill = async () => {
      throw new PrivateSkillError("skillpack_credential_missing");
    };
    const refused = await f.launch(t.id, "missing-key");
    expect(refused.reason).toBe("skillpack_credential_missing");
    expect(f.boat.prompts).toHaveLength(1);
    expect(await f.launch(t.id, "missing-key")).toEqual(refused);
    expect(f.boat.forks).toHaveLength(2);

    f.provider.exec = async (r) =>
      r.command.includes("skillpack install")
        ? {
            detached: false,
            exitCode: 7,
            stdout: "untrusted guest output",
            stderr: "",
            timedOut: false,
            truncated: false,
          }
        : exec(r);
    const unavailable = await f.launch(t.id, "public-unavailable");
    expect(unavailable.reason).toBe("skillpack_skill_unavailable");
    expect(JSON.stringify(unavailable)).not.toContain("untrusted guest output");
    expect(f.boat.prompts).toHaveLength(1);
  } finally {
    await f.db.close();
  }
});

test("template admission freezes merged defaults and explicit overrides; opt-out excludes only defaults", async () => {
  const f = await fixture();
  try {
    const defaults = createSkillDefaultsService(f.sql);
    await defaults.command(f.actor(f.people.admin), "set", {
      org: f.people.org,
      scope: "org",
      skills: ["shared@2.0.0", "org-only@1.0.0"],
    });
    await defaults.command(f.actor(f.people.admin), "set", {
      org: f.people.org,
      scope: "golden",
      goldenId: f.goldenId,
      skills: ["shared@1.0.0", "environment@1.0.0"],
    });
    await defaults.command(f.actor(), "set", {
      org: f.people.org,
      scope: "personal",
      skills: ["shared@3.0.0", "personal@1.0.0"],
    });
    const installed: string[] = [];
    f.runtime.stores.credentials.installPrivateSkill = async (_provider, input) => {
      installed.push(input.reference);
      return {
        reference: input.reference,
        version: input.reference.split("@")[1]!,
        skillId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        workspaceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        checksum: `sha256:${"a".repeat(64)}`,
        origin: "https://skillpack.app/v1",
      };
    };
    const t = (await f.create(undefined, undefined, { ...f.definition, skills: ["shared@4.0.0", "template@1.0.0"] }))
      .item as LaunchTemplate;
    const result = await f.launch(t.id, "merged", { skills: ["shared@5.0.0"] });
    expect(result.state).toBe("succeeded");
    const expected = ["shared@5.0.0", "environment@1.0.0", "org-only@1.0.0", "personal@1.0.0", "template@1.0.0"];
    expect(installed).toEqual(expected);
    expect(result.manifest).toMatchObject({
      resolvedSkills: expected,
      definition: { skills: ["shared@4.0.0", "template@1.0.0"] },
    });
    await defaults.command(f.actor(), "set", { org: f.people.org, scope: "personal", skills: ["changed@1.0.0"] });
    expect(await f.launch(t.id, "merged", { skills: ["shared@5.0.0"] })).toEqual(result);
    expect(installed).toHaveLength(5);
    installed.length = 0;
    const optedOut = await f.launch(t.id, "opt-out", { skipSkillDefaults: true, skills: ["explicit@1.0.0"] });
    expect(optedOut.state).toBe("succeeded");
    expect(installed).toEqual(["shared@4.0.0", "template@1.0.0", "explicit@1.0.0"]);
    await expect(f.launch(t.id, "bad-opt-out", { skipSkillDefaults: "true" })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(f.launch(t.id, "bad-pins", { skills: ["floating@latest"] })).rejects.toMatchObject({
      code: "invalid",
    });
    expect(f.boat.forks).toHaveLength(2);
  } finally {
    await f.db.close();
  }
});

// Publication owns reference authorization; no raw secret fixture is needed at this boundary.
test("secret references authorize delivery without persisting values and revoke later turns", async () => {
  const f = await fixture();
  try {
    const canary = crypto.randomUUID() + crypto.randomUUID();
    // Generate in memory; assert booleans so a failing assertion never prints the value.
    const secretId = (
      await f.db.query<{ id: string }>(
        "insert into application_secrets(org_id,owner_id,scope,name,value_enc) values($1,$2,'personal','APP_TOKEN',$3) returning id",
        [f.people.org, f.people.owner, await encryptSecret(canary, ENCRYPTION_KEY)],
      )
    ).rows[0]!.id;
    const binding = { key: "APP_TOKEN", secretId, version: 1 };
    const def = { ...f.definition, variables: [], secrets: [binding] };
    // Exercise the actual remote MCP schema, not only the shared tool dispatcher.
    const server = createArmadaServer(
      {
        templates: f.service,
        caller: f.actor(),
        data: createSqlData(f.sql)(f.actor()),
        launchCredentials: f.runtime.stores.credentials,
        exposedSecrets: async () => [],
        provider: async () => f.provider,
        now: () => new Date(),
        sleep: async () => {},
      },
      "test",
    );
    const client = new Client({ name: "template-secret-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const created = await client.callTool({
        name: "template_create",
        arguments: {
          org: f.people.org,
          name: "mcp-secret-template",
          scope: "personal",
          definition: def,
        },
      });
      expect(created.isError).not.toBe(true);
      const saved = JSON.parse((created.content as { text: string }[])[0]!.text);
      expect(saved.revision.definition.secrets).toEqual([binding]);
      const published = await client.callTool({
        name: "template_publish",
        arguments: {
          org: f.people.org,
          id: saved.item.id,
          expectedRevision: 1,
          definition: def,
        },
      });
      expect(published.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
    const created = await f.create(f.people.owner, "personal", def);
    const templateId = (created.item as LaunchTemplate).id;
    const read = await f.service.command(f.actor(), "get", { org: f.people.org, id: templateId });
    expect((read.revision as { definition: unknown }).definition).toEqual({
      ...def,
      goldenBinding: null,
      skills: [],
    });
    for (const user of [f.people.member, f.people.admin]) {
      await expect(f.create(user, "personal", def)).rejects.toThrow("secret_unavailable");
    }
    await expect(f.create(f.people.admin, "org", def)).rejects.toThrow("secret_unavailable");
    for (const secrets of [
      [binding, binding],
      [{ ...binding, key: "OPENAI_API_KEY" }],
      ...["NEXT_PUBLIC_", "VITE_", "PUBLIC_"].map((prefix) => [{ ...binding, key: prefix + "TOKEN" }]),
      [{ ...binding, value: "not-accepted" }],
      [{ ...binding, version: 0 }],
    ]) {
      await expect(f.create(f.people.owner, "personal", { ...def, secrets })).rejects.toMatchObject({
        code: "invalid",
      });
    }
    await expect(
      f.create(f.people.owner, "personal", {
        ...f.definition,
        secrets: [{ ...binding, key: "APP_REGION" }],
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    const launched = await f.launch(templateId);
    expect(launched.state).toBe("succeeded");
    expect(JSON.stringify(launched).includes(canary)).toBe(false);
    expect((f.configured.at(-1) as { variables: Record<string, string> }).variables.APP_TOKEN === canary).toBe(true);
    const request = (
      await f.db.query<{ id: string; manifest: unknown }>("select id,manifest from template_launch_requests")
    ).rows[0]!;
    expect(JSON.stringify(request.manifest).includes(canary)).toBe(false);
    f.configured.length = 0;
    const lifecycle = createMcpLifecycle({
      sql: f.sql,
      registry: createSqlMcpRegistry(f.sql, ENCRYPTION_KEY),
      encryptionKey: ENCRYPTION_KEY,
      origin: "https://armada.test",
      prepareReadableVariables: f.service.prepare,
    });
    await lifecycle.beforePrompt(f.provider, launched.providerSandboxId as string, {
      userId: f.people.owner,
      orgId: f.people.org,
    });
    expect((f.configured.at(-1) as { variables: Record<string, string> }).variables.APP_TOKEN === canary).toBe(true);
    const { configureReadableVariables: _configure, ...withoutDelivery } = f.provider;
    f.runtime.provider = async () => withoutDelivery;
    const unsupported = await f.launch(templateId, "unsupported-provider");
    expect(unsupported.reason).toBe("secret_delivery_unavailable");
    await expect(
      f.service.prepare(
        withoutDelivery,
        launched.providerSandboxId as string,
        { userId: f.people.owner, orgId: f.people.org },
        request.id,
      ),
    ).rejects.toThrow("secret_delivery_unavailable");
    await f.db.query("update application_secrets set version=2 where id=$1", [secretId]);
    await expect(f.create(f.people.owner, "personal", def)).rejects.toThrow("secret_version_changed");
    await expect(
      f.service.prepare(
        f.provider,
        launched.providerSandboxId as string,
        { userId: f.people.owner, orgId: f.people.org },
        request.id,
      ),
    ).rejects.toThrow("secret_version_changed");
    await f.db.query("update application_secrets set scope='org' where id=$1", [secretId]);
    const updated = { ...def, secrets: [{ ...binding, version: 2 }] };
    await f.create(f.people.admin, "org", updated);
    const published = await f.service.command(f.actor(), "publish", {
      org: f.people.org,
      id: templateId,
      expectedRevision: 1,
      definition: updated,
    });
    expect((published.item as LaunchTemplate).currentRevision).toBe(2);
    const old = await f.service.command(f.actor(), "get", { org: f.people.org, id: templateId, revision: 1 });
    expect((old.revision as { definition: { secrets: unknown } }).definition.secrets).toEqual([binding]);
    for (const change of [
      "expires_at=now()-interval '1 minute'",
      "expires_at=null,status='revoked',value_enc=null",
      "status='deleted'",
    ]) {
      await f.db.query(`update application_secrets set ${change} where id=$1`, [secretId]);
      await expect(f.create(f.people.owner, "personal", updated)).rejects.toThrow("secret_unavailable");
    }
  } finally {
    await f.db.close();
  }
});

// Owns combined transport admission: neither per-list validation nor provider stubs enforce this contract.
test("template publication caps readable and secret bindings at 64 combined entries", async () => {
  const f = await fixture();
  try {
    const secretId = (
      await f.db.query<{ id: string }>(
        "insert into application_secrets(org_id,owner_id,scope,name,value_enc) values($1,$2,'personal','APP_TOKEN',$3) returning id",
        [f.people.org, f.people.owner, await encryptSecret(crypto.randomUUID(), ENCRYPTION_KEY)],
      )
    ).rows[0]!.id;
    const variables = Array.from({ length: 64 }, (_, i) => ({
      key: `CONFIG_${i}`,
      variableId: f.variableId,
      version: 1,
    }));
    const secrets = [{ key: "APP_TOKEN", secretId, version: 1 }];
    await expect(f.create(f.people.owner, "personal", { ...f.definition, variables, secrets })).rejects.toThrow(
      "environment_limits_exceeded",
    );
    const valid = await f.create(f.people.owner, "personal", {
      ...f.definition,
      variables: variables.slice(1),
      secrets,
    });
    expect((valid.item as LaunchTemplate).currentRevision).toBe(1);
  } finally {
    await f.db.close();
  }
});

test("template admission validates decrypted combined byte budget before any fork", async () => {
  const f = await fixture();
  try {
    // Generated in memory, never included in assertion output, fixtures or receipts.
    const canary = crypto.randomUUID().repeat(228).slice(0, 8192);
    const secretId = (
      await f.db.query<{ id: string }>(
        "insert into application_secrets(org_id,owner_id,scope,name,value_enc) values($1,$2,'personal','APP_TOKEN',$3) returning id",
        [f.people.org, f.people.owner, await encryptSecret(canary, ENCRYPTION_KEY)],
      )
    ).rows[0]!.id;
    const secrets = Array.from({ length: 8 }, (_, i) => ({ key: `APP_TOKEN_${i}`, secretId, version: 1 }));
    const oversized = (await f.create(f.people.owner, "personal", { ...f.definition, secrets })).item as LaunchTemplate;
    const refused = await f.launch(oversized.id, "over-budget");
    expect(refused.reason).toBe("environment_limits_exceeded");
    expect(refused.state).toBe("failed");
    expect(f.boat.forks).toHaveLength(0);
    expect(f.configured).toHaveLength(0);
    expect(JSON.stringify(refused).includes(canary)).toBe(false);
    const exact = (await f.create(f.people.owner, "personal", { ...f.definition, variables: [], secrets }))
      .item as LaunchTemplate;
    const accepted = await f.launch(exact.id, "exact-budget");
    expect(accepted.state).toBe("succeeded");
    expect(f.boat.forks).toHaveLength(1);
    expect(JSON.stringify(accepted).includes(canary)).toBe(false);
  } finally {
    await f.db.close();
  }
});
