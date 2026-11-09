import { expect, test } from "bun:test";
import { connectGolden, type Provider, ProviderError, type Sql } from "@armada/core";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { createSqlData } from "../src/data.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const admin = "22222222-2222-4222-8222-222222222222";
const org = "33333333-3333-4333-8333-333333333333";
const backendId = "restore-fixture-account";

async function bindBackend(sql: Sql, name: string): Promise<void> {
  await sql.query(
    `insert into golden_backend_slots(provider,backend_id,max_goldens,org_id,owner_id,golden_id)
     select 'boat',$1,1,org_id,owner_id,id from goldens where org_id=$2 and name=$3`,
    [`${backendId}:${name}`, org, name],
  );
}

test("scoped stopped-master restore CAS publishes one ready fork, cleans the loser, and never grants private access to an admin", async () => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    await db.query("insert into auth.users(id) values ($1),($2)", [owner, admin]);
    await db.query("insert into orgs(id,name) values ($1,'Restore')", [org]);
    await db.query("insert into members(org_id,user_id,role) values ($1,$2,'admin'),($1,$3,'admin')", [
      org,
      owner,
      admin,
    ]);
    await db.query(
      'insert into goldens(org_id,name,visibility,owner_id,boat_sandbox_id,boat_snapshot_id,config) values ($1,\'web\',\'private\',$2,\'bx_old\',\'snapshot\',\'{"repos":[{"url":"https://github.com/acme/web.git","branch":"main","dir":"web"}],"init":[]}\'::jsonb)',
      [org, owner],
    );
    await bindBackend(db, "web");
    const ownerStore = createSqlData(db)({
      userId: owner,
      via: "supabase",
      orgs: [{ orgId: org, role: "admin" }],
    }).goldens;
    const adminStore = createSqlData(db)({
      userId: admin,
      via: "supabase",
      orgs: [{ orgId: org, role: "admin" }],
    }).goldens;
    const actor = { userId: owner, orgId: org, role: "admin" as const };
    const deleted: string[] = [];
    let forks = 0;
    let release!: () => void;
    const bothForked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = {
      id: "boat",
      backendIdentity: async () => ({ id: `${backendId}:web` }),
      async get(id: string) {
        return { id, state: id === "bx_old" ? "stopped" : "ready" };
      },
      async fork(input: { from: string; noEnv: boolean }) {
        expect(input).toEqual({ from: "snapshot", noEnv: true });
        const id = `bx_restored_${++forks}`;
        if (forks === 2) release();
        await bothForked;
        return { id };
      },
      async delete(input: { sandboxId: string }) {
        deleted.push(input.sandboxId);
      },
    } as unknown as Provider;
    await expect(connectGolden(provider, adminStore, { ...actor, userId: admin }, "web")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(forks).toBe(0);
    const refused = {
      ...provider,
      fork: async () => {
        throw new ProviderError({
          provider: "boat",
          code: "forbidden",
          retryable: false,
          message: "Explicit provider refusal",
        });
      },
    };
    await expect(connectGolden(refused, ownerStore, actor, "web")).rejects.toMatchObject({ code: "forbidden" });
    expect((await db.query("select id from golden_operation_fences")).rows).toEqual([]);

    const results = await Promise.allSettled([
      connectGolden(provider, ownerStore, actor, "web"),
      connectGolden(provider, ownerStore, actor, "web"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(deleted).toHaveLength(1);
    const golden = (await ownerStore.findByName(org, "web"))[0];
    expect(golden?.providerSandboxId).not.toBe("bx_old");
    expect(deleted).not.toContain(golden?.providerSandboxId ?? "");
    if (!golden?.providerSandboxId || !ownerStore.replaceSandbox) throw new Error("Missing restored golden.");
    const canonicalId = golden.providerSandboxId;
    await expect(adminStore.setSandbox(golden.id, "bx_unauthorized_overwrite")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect((await ownerStore.findByName(org, "web"))[0]?.providerSandboxId).toBe(canonicalId);
    await db.query("delete from members where user_id = $1", [owner]);
    expect(await ownerStore.replaceSandbox(golden.id, golden.providerSandboxId, "snapshot", "bx_unauthorized")).toBe(
      false,
    );
  } finally {
    await db.close();
  }
});

test("a committed restore with a lost SQL response never deletes the canonical fork, even when reconciliation reads fail", async () => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    await db.query("insert into auth.users(id) values ($1)", [owner]);
    await db.query("insert into orgs(id,name) values ($1,'AmbiguousRestore')", [org]);
    await db.query("insert into members(org_id,user_id,role) values ($1,$2,'admin')", [org, owner]);
    const caller = { userId: owner, via: "supabase" as const, orgs: [{ orgId: org, role: "admin" as const }] };
    const actor = { userId: owner, orgId: org, role: "admin" as const };
    for (const reconcileAvailable of [true, false]) {
      const name = reconcileAvailable ? "recoverable" : "unknown";
      await db.query(
        "insert into goldens(org_id,name,visibility,owner_id,boat_sandbox_id,boat_snapshot_id,config) values ($1,$2,'private',$3,'bx_old',$5,$4::jsonb)",
        [
          org,
          name,
          owner,
          JSON.stringify({ repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] }),
          `snapshot_${name}`,
        ],
      );
      await bindBackend(db, name);
      let writeCommitted = false;
      const store = createSqlData({
        async query<T>(sql: string, params?: unknown[]) {
          if (writeCommitted && !reconcileAvailable) throw new Error("Reconciliation transport unavailable.");
          const result = await db.query<T>(sql, params);
          if (sql.includes("update public.goldens g set provider_sandbox_id")) {
            writeCommitted = true;
            throw new Error("SQL response lost after commit.");
          }
          return result;
        },
      })(caller).goldens;
      let forks = 0;
      const deleted: string[] = [];
      const restoredId = `bx_${name}`;
      const provider = {
        id: "boat",
        backendIdentity: async () => ({ id: `${backendId}:${name}` }),
        async get(id: string) {
          return { id, state: id === "bx_old" ? "stopped" : "ready" };
        },
        async fork() {
          forks++;
          return { id: restoredId };
        },
        async delete(input: { sandboxId: string }) {
          deleted.push(input.sandboxId);
        },
      } as unknown as Provider;
      if (reconcileAvailable)
        expect((await connectGolden(provider, store, actor, name)).golden.providerSandboxId).toBe(restoredId);
      else
        await expect(connectGolden(provider, store, actor, name)).rejects.toMatchObject({
          code: "conflict",
          message: expect.stringContaining(`Retained sandbox ${restoredId}`),
        });
      expect(writeCommitted).toBe(true);
      expect(deleted).toEqual([]);
      const scoped = createSqlData(db)(caller);
      const goldenId = (await scoped.goldens.findByName(org, name))[0]!.id;
      const fences = async () =>
        (await db.query("select id from golden_operation_fences where golden_id=$1", [goldenId])).rows;
      if (!reconcileAvailable) {
        expect(await fences()).toHaveLength(1);
        await expect(scoped.removeGolden!(goldenId)).rejects.toMatchObject({ code: "conflict" });
      } else expect(await fences()).toHaveLength(0);
      const durableStore = scoped.goldens;
      expect((await durableStore.findByName(org, name))[0]?.providerSandboxId).toBe(restoredId);
      expect((await connectGolden(provider, durableStore, actor, name)).sandbox.id).toBe(restoredId);
      expect(await fences()).toHaveLength(0);
      await expect(scoped.removeGolden!(goldenId)).resolves.toMatchObject({ artifacts: "retained" });
      expect(forks).toBe(1);
      expect(deleted).toEqual([]);
    }
  } finally {
    await db.close();
  }
});

test.each(["lost-delete", "lost-confirmation", "confirmed-gone"] as const)(
  "acknowledged losing Boat restore retains ownership until terminal cleanup (%s)",
  async (mode) => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      await db.query("insert into auth.users(id) values($1)", [owner]);
      await db.query("insert into orgs(id,name) values($1,'LoserCleanup')", [org]);
      await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [org, owner]);
      const inserted = await db.query<{ id: string }>(
        "insert into goldens(org_id,name,visibility,owner_id,boat_sandbox_id,boat_snapshot_id,config) values($1,'loser','private',$2,'bx_old','snapshot',$3::jsonb) returning id",
        [
          org,
          owner,
          JSON.stringify({ repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] }),
        ],
      );
      const id = inserted.rows[0]!.id;
      await bindBackend(db, "loser");
      const actor = { userId: owner, orgId: org, role: "admin" as const };
      const scoped = createSqlData(db)({ userId: owner, via: "supabase", orgs: [{ orgId: org, role: "admin" }] });
      let deleting = false;
      let deleteCalls = 0;
      const provider = {
        id: "boat",
        backendIdentity: async () => ({ id: backendId + ":loser" }),
        async get(sandboxId: string) {
          if (sandboxId === "bx_loser" && deleting) {
            if (mode === "lost-confirmation") throw new Error("confirmation transport lost");
            throw new ProviderError({ provider: "boat", code: "not_found", retryable: false, message: "Gone" });
          }
          return { id: sandboxId, state: sandboxId === "bx_old" ? "stopped" : "ready" };
        },
        async fork() {
          // Another successful publication wins in SQL while this restore is in flight.
          expect(await scoped.goldens.replaceSandbox!(id, "bx_old", "snapshot", "bx_winner")).toBe(true);
          return { id: "bx_loser" };
        },
        async delete({ sandboxId }: { sandboxId: string }) {
          expect(sandboxId).toBe("bx_loser");
          deleteCalls++;
          deleting = true;
          if (mode === "lost-delete") throw new Error("delete transport lost");
        },
      } as unknown as Provider;
      await expect(connectGolden(provider, scoped.goldens, actor, "loser")).rejects.toThrow(
        mode === "lost-delete"
          ? "delete transport lost"
          : mode === "lost-confirmation"
            ? "confirmation transport lost"
            : "golden changed while restoring",
      );
      expect(deleteCalls).toBe(1);
      expect((await scoped.goldens.findByName(org, "loser"))[0]?.providerSandboxId).toBe("bx_winner");
      const fences = () =>
        db.query<{ receipt: unknown }>("select receipt from golden_operation_fences where golden_id=$1", [id]);
      if (mode === "confirmed-gone") {
        expect((await fences()).rows).toEqual([]);
        await expect(scoped.removeGolden!(id)).resolves.toMatchObject({ artifacts: "retained" });
      } else {
        expect((await fences()).rows).toEqual([
          {
            receipt: { kind: "connect", sandboxId: "bx_loser", snapshotId: "snapshot" },
          },
        ]);
        await expect(scoped.removeGolden!(id)).rejects.toMatchObject({ code: "conflict" });
        // Canonical winner readback cannot settle a different loser's unknown cleanup.
        expect((await connectGolden(provider, scoped.goldens, actor, "loser")).sandbox.id).toBe("bx_winner");
        expect((await fences()).rows).toHaveLength(1);
        await expect(scoped.removeGolden!(id)).rejects.toMatchObject({ code: "conflict" });
        expect(deleteCalls).toBe(1);
      }
    } finally {
      await db.close();
    }
  },
);
