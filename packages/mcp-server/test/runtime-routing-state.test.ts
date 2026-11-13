import { expect, test } from "bun:test";
import { createSqlSandboxStore, type SandboxStore, type Sql } from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { database } from "./support.ts";

async function fixture() {
  const { db, people } = await database();
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
    const f = await fixture();
    try {
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
      expect(
        (await f.core.listBefore(new Date(Date.now() + 1000).toISOString())).find((row) => row.id === runtime.id)
          ?.boatRuntime,
      ).toBe(true);
    } finally {
      await f.db.close();
    }
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
    await expect(f.core.insert({ ...f.input(), harness: "opencode", boatRuntime: true })).rejects.toThrow(
      "sandboxes_boat_runtime_target",
    );
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
    await f.db.close();
  }
});
