import { expect, test } from "bun:test";
import { createSqlGoldenStore } from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { migratedDatabase } from "./migrated-database.ts";

for (const provider of ["boat", "modal"] as const) {
  test(`scoped ${provider} master writes preserve compatibility pairs without repair and refuse blind replacement`, async () => {
    const db = await migratedDatabase();
    try {
      const owner = crypto.randomUUID(),
        foreignAdmin = crypto.randomUUID(),
        org = crypto.randomUUID();
      await db.query("insert into auth.users(id) values($1),($2)", [owner, foreignAdmin]);
      await db.query("insert into orgs(id,name) values($1,'Scoped writes')", [org]);
      await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin'),($1,$3,'admin')", [
        org,
        owner,
        foreignAdmin,
      ]);
      const golden = await createSqlGoldenStore(db).insert({
        orgId: org,
        ownerId: owner,
        name: "web",
        visibility: "private",
        provider,
        modal: provider === "modal" ? { workspace: "ws", environment: "main", appId: "ap" } : null,
        config: { repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] },
      });
      // Keep the real provider CHECK/ACL guards, but require this writer to satisfy compatibility itself.
      // A repair trigger must not be needed to make canonical writes valid, regardless of trigger ordering.
      await db.exec("alter table public.goldens disable trigger goldens_provider_guard");
      const caller = (userId: string) => ({
        userId,
        via: "supabase" as const,
        orgs: [{ orgId: org, role: "admin" as const }],
      });
      const store = createSqlData(db)(caller(owner)).goldens;
      const outsider = createSqlData(db)(caller(foreignAdmin)).goldens;
      const read = async () =>
        (
          await db.query(
            "select provider_sandbox_id,boat_sandbox_id,provider_snapshot_id,boat_snapshot_id from goldens where id=$1",
            [golden.id],
          )
        ).rows[0];
      await expect(outsider.setSandbox(golden.id, "foreign")).rejects.toMatchObject({ code: "forbidden" });
      if (!store.replaceSandbox || !store.recordSnapshot) throw new Error("Scoped CAS operations are required.");
      expect(await store.recordSnapshot(golden.id, null, "snapshot-without-master")).toBe(true);
      await store.setSandbox(golden.id, "master-first");
      await store.setSnapshot(golden.id, "snapshot-first");
      await expect(store.setSandbox(golden.id, "blind-overwrite")).rejects.toMatchObject({ code: "forbidden" });
      expect(await read()).toEqual({
        provider_sandbox_id: "master-first",
        boat_sandbox_id: provider === "boat" ? "master-first" : null,
        provider_snapshot_id: "snapshot-first",
        boat_snapshot_id: provider === "boat" ? "snapshot-first" : null,
      });
      expect(await store.replaceSandbox(golden.id, "wrong-master", "snapshot-first", "loser")).toBe(false);
      expect(await store.replaceSandbox(golden.id, "master-first", "snapshot-first", "master-restored")).toBe(true);
      expect(await store.recordSnapshot(golden.id, "master-first", "stale-snapshot")).toBe(false);
      expect(await store.recordSnapshot(golden.id, "master-restored", "snapshot-next")).toBe(true);
      expect(await read()).toEqual({
        provider_sandbox_id: "master-restored",
        boat_sandbox_id: provider === "boat" ? "master-restored" : null,
        provider_snapshot_id: "snapshot-next",
        boat_snapshot_id: provider === "boat" ? "snapshot-next" : null,
      });
      await expect(outsider.setSnapshot(golden.id, "foreign-snapshot")).rejects.toMatchObject({ code: "forbidden" });
      await db.query("delete from members where user_id=$1", [owner]);
      expect(await store.replaceSandbox(golden.id, "master-restored", "snapshot-next", "revoked")).toBe(false);
      expect(await store.recordSnapshot(golden.id, "master-restored", "revoked-snapshot")).toBe(false);
      await expect(store.setSnapshot(golden.id, "revoked-setter")).rejects.toMatchObject({ code: "forbidden" });
      expect(await read()).toMatchObject({ provider_snapshot_id: "snapshot-next" });
    } finally {
      await db.close();
    }
  });
}

test("scoped setters recheck current membership and admin role after the caller context was created", async () => {
  const db = await migratedDatabase();
  try {
    const owner = crypto.randomUUID(),
      backupAdmin = crypto.randomUUID(),
      org = crypto.randomUUID();
    await db.query("insert into auth.users(id) values($1),($2)", [owner, backupAdmin]);
    await db.query("insert into orgs(id,name) values($1,'Setter authority')", [org]);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin'),($1,$3,'admin')", [
      org,
      owner,
      backupAdmin,
    ]);
    const golden = await createSqlGoldenStore(db).insert({
      orgId: org,
      ownerId: owner,
      name: "shared",
      visibility: "org",
      provider: "boat",
      modal: null,
      config: { repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] },
    });
    const store = createSqlData(db)({ userId: owner, via: "supabase", orgs: [{ orgId: org, role: "admin" }] }).goldens;
    await store.setSnapshot(golden.id, "snapshot-original");
    for (const change of ["demoted", "removed"] as const) {
      if (change === "demoted")
        await db.query("update members set role='member' where org_id=$1 and user_id=$2", [org, owner]);
      else await db.query("delete from members where org_id=$1 and user_id=$2", [org, owner]);
      await expect(store.setSnapshot(golden.id, `snapshot-${change}`)).rejects.toMatchObject({ code: "forbidden" });
      await expect(store.setSandbox(golden.id, `master-${change}`)).rejects.toMatchObject({ code: "forbidden" });
      const row = (
        await db.query(
          "select provider_sandbox_id,boat_sandbox_id,provider_snapshot_id,boat_snapshot_id from goldens where id=$1",
          [golden.id],
        )
      ).rows[0];
      expect(row).toEqual({
        provider_sandbox_id: null,
        boat_sandbox_id: null,
        provider_snapshot_id: "snapshot-original",
        boat_snapshot_id: "snapshot-original",
      });
    }
  } finally {
    await db.close();
  }
});
