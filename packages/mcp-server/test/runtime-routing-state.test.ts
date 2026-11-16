import { expect, test } from "bun:test";
import {
  createSqlSandboxStore,
  createSqlVaultStore,
  type Provider,
  type ProviderTarget,
  type SandboxStore,
  type Sql,
} from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { providerRegistry } from "../src/http.ts";
import {
  createHistoricalSandboxProviderResolver,
  createMcpSandboxProviderResolver,
} from "../src/mcp-sandbox-provider.ts";
import { callSharedTool } from "../src/tool-api.ts";
import type { ToolContext } from "../src/tools.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

async function fixture(seed = sharedDatabase) {
  const { db, people } = await seed();
  const golden = (
    await db.query<{ id: string }>("select id from goldens where owner_id=$1 and visibility='private' limit 1", [
      people.owner,
    ])
  ).rows[0];
  if (!golden) throw Error("missing owned golden");
  const sql: Sql = { query: (q, v) => db.query(q, v) };
  const core = createSqlSandboxStore(sql);
  const scoped = createSqlData(sql)({
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" }],
    via: "service",
  }).sandboxes;
  const input = (): Parameters<SandboxStore["insert"]>[0] => ({
    id: crypto.randomUUID(),
    provider: "boat",
    providerSandboxId: `physical-${crypto.randomUUID()}`,
    goldenId: golden.id,
    orgId: people.org,
    ownerId: people.owner,
    harness: "codex",
    status: "ready",
    model: "gpt-5.4",
    reasoningEffort: "high",
  });
  return { db, people, core, scoped, input };
}

// Both query builders own persistence/returning/readback at their real SQL boundary.
test.each(["core", "scoped"] as const)(
  "%s store retains an explicit runtime choice while native DTOs stay unchanged",
  async (surface) => {
    const f = await fixture(sharedDatabase);
    const store = f[surface];
    const native = await store.insert(f.input());
    expect(native.boatRuntime).toBeUndefined();
    expect((await f.db.query("select boat_runtime from sandboxes where id=$1", [native.id])).rows).toEqual([
      { boat_runtime: false },
    ]);
    const runtime = await store.insert({ ...f.input(), boatRuntime: true });
    expect(runtime.boatRuntime).toBe(true);
    expect((await f.scoped.get(runtime.id))?.boatRuntime).toBe(true);
    await store.update(runtime.id, { status: "stopped", stoppedAt: new Date().toISOString() });
    expect((await f.db.query("select boat_runtime from sandboxes where id=$1", [runtime.id])).rows).toEqual([
      { boat_runtime: true },
    ]);
  },
);

test("SQL makes routing immutable, target-specific and user-JWT read-only", async () => {
  const f = await fixture();
  try {
    const native = await f.core.insert(f.input());
    const runtime = await f.core.insert({ ...f.input(), boatRuntime: true });
    await expect(f.db.query("update sandboxes set boat_runtime=true where id=$1", [native.id])).rejects.toThrow(
      "runtime selection is immutable",
    );
    await expect(f.db.query("update sandboxes set boat_runtime=false where id=$1", [runtime.id])).rejects.toThrow(
      "runtime selection is immutable",
    );
    const claude = await f.core.insert({ ...f.input(), harness: "claude", boatRuntime: true });
    expect(claude).toMatchObject({ harness: "claude", boatRuntime: true });
    const opencode = await f.core.insert({ ...f.input(), harness: "opencode", boatRuntime: true });
    expect(opencode).toMatchObject({ harness: "opencode", boatRuntime: true });
    const modal = (
      await f.db.query<{ id: string }>(
        `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
       values($1,$2,'runtime-modal','private','modal','modal-master','image','workspace','main','app','{"repos":[],"init":[]}') returning id`,
        [f.people.org, f.people.owner],
      )
    ).rows[0];
    if (!modal) throw Error("missing modal golden");
    // First prove this otherwise-identical Modal insert works, so a provider/alias
    // guard cannot masquerade as runtime target rejection.
    await f.core.insert({ ...f.input(), provider: "modal", goldenId: modal.id });
    expect(
      (await f.core.insert({ ...f.input(), provider: "modal", goldenId: modal.id, runtimeTransport: "dialout" }))
        .runtimeTransport,
    ).toBe("dialout");
    await expect(
      f.core.insert({ ...f.input(), provider: "modal", goldenId: modal.id, boatRuntime: true }),
    ).rejects.toThrow("sandboxes_boat_runtime_target");
    expect(
      (
        await f.db.query(
          "select has_column_privilege('authenticated','sandboxes','boat_runtime','select') as readable, has_column_privilege('authenticated','sandboxes','boat_runtime','insert,update') as writable, has_column_privilege('anon','sandboxes','boat_runtime','select,insert,update') as anonymous",
        )
      ).rows,
    ).toEqual([{ readable: true, writable: false, anonymous: false }]);
    await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [f.people.owner]);
    await f.db.exec("set role authenticated");
    try {
      expect((await f.db.query("select boat_runtime from sandboxes where id=$1", [runtime.id])).rows).toEqual([
        { boat_runtime: true },
      ]);
      await expect(f.db.query("update sandboxes set boat_runtime=false where id=$1", [runtime.id])).rejects.toThrow(
        "permission denied",
      );
    } finally {
      await f.db.exec("reset role");
    }
  } finally {
    await f.db.exec("reset role; reset all; set search_path=public");
  }
});

test("registry and active/historical SQL resolvers preserve immutable runtime choice or refuse, never native fallback", async () => {
  const { db, people } = await sharedDatabase();
  const sql: Sql = { query: (q, v) => db.query(q, v) };
  const golden = (
    await db.query<{ id: string }>("select id from goldens where owner_id=$1 and visibility='private' limit 1", [
      people.owner,
    ])
  ).rows[0];
  if (!golden) throw Error("missing owned golden");
  const record = await createSqlSandboxStore(sql).insert({
    id: crypto.randomUUID(),
    provider: "boat",
    providerSandboxId: "physical",
    goldenId: golden.id,
    orgId: people.org,
    ownerId: people.owner,
    harness: "codex",
    status: "ready",
    model: "gpt-5.4",
    reasoningEffort: "high",
    boatRuntime: true,
  });
  const calls: string[] = [];
  const host = { id: "boat" } as Provider;
  const base = {
    vault: createSqlVaultStore(db),
    encryptionKey: ENCRYPTION_KEY,
    providerFor() {
      calls.push("native");
      return host;
    },
  };
  const factory = providerRegistry({
    ...base,
    async runtimeProviderFor(_key, target, actor) {
      expect([target.id, target.boatRuntime, actor.userId]).toEqual([record.id, true, people.owner]);
      calls.push("runtime");
      return host;
    },
  });
  const target: ProviderTarget = {
    id: record.id,
    boatRuntime: true,
    provider: "boat",
    orgId: people.org,
    visibility: "private",
    modal: null,
  };
  await factory.resolve(target, { userId: people.owner });
  await createMcpSandboxProviderResolver(sql, factory)(record.id);
  await createHistoricalSandboxProviderResolver(factory)(sql, record.id);
  expect(calls).toEqual(["runtime", "runtime", "runtime"]);
  const { boatRuntime: choice, ...nativeTarget } = target;
  void choice;
  await factory.resolve(nativeTarget, { userId: people.owner });
  expect(calls.at(-1)).toBe("native");
  await expect(providerRegistry(base).resolve(target, { userId: people.owner })).rejects.toMatchObject({
    code: "provider_routing_unavailable",
  });
  const { id: hint, ...noIdentity } = target;
  void hint;
  await expect(factory.resolve(noIdentity, { userId: people.owner })).rejects.toMatchObject({
    code: "provider_routing_unavailable",
  });
  expect(calls.filter((value) => value === "native")).toHaveLength(1);
  const caller = {
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" as const }],
    via: "service" as const,
  };
  const context: ToolContext = {
    caller,
    data: createSqlData(sql)(caller),
    async provider() {
      throw Error("must reject before resolving native credentials/provider");
    },
    launchCredentials: {
      async resolve() {
        throw Error("must not resolve native model credentials");
      },
    },
    async exposedSecrets() {
      throw Error("must not inspect native credentials");
    },
    now: () => new Date(),
    async sleep() {
      throw Error("must not wait");
    },
  };
  for (const [name, extra] of [
    ["send", { prompt: "no" }],
    ["github_refresh", {}],
  ] as const)
    await expect(callSharedTool(context, name, { id: record.id, ...extra })).rejects.toMatchObject({
      code: "unsupported",
    });
});
