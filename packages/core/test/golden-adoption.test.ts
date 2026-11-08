import { expect, test } from "bun:test";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { createGoldenAdoption } from "../src/golden-adoption.ts";
import { createSqlGoldenStore } from "../src/golden-store.ts";
import type { Provider } from "../src/provider.ts";

const org = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";

test("adoption checks current provenance, authorization, confirmation, and preserves every legacy row", async () => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    await db.query("insert into auth.users(id,email) values ($1,'a@test'),($2,'b@test')", [owner, other]);
    await db.query("insert into orgs(id,name) values ($1,'org')", [org]);
    await db.query("insert into members(org_id,user_id,role) values ($1,$2,'admin'),($1,$3,'member')", [
      org,
      owner,
      other,
    ]);
    const store = createSqlGoldenStore(db);
    const golden = await store.insert({
      orgId: org,
      ownerId: owner,
      name: "legacy",
      visibility: "org",
      provider: "boat",
      modal: null,
      config: { repos: [{ url: "https://github.com/example/repo.git", branch: "main", dir: "repo" }], init: [] },
    });
    await store.setSandbox(golden.id, "source");
    await store.setSnapshot(golden.id, "snapshot");
    const privateGolden = await store.insert({
      orgId: org,
      ownerId: other,
      name: "hidden",
      visibility: "private",
      provider: "boat",
      modal: null,
      config: { repos: [{ url: "https://github.com/example/repo.git", branch: "main", dir: "repo" }], init: [] },
    });
    await store.setSandbox(privateGolden.id, "private-source");
    await store.setSnapshot(privateGolden.id, "private-snapshot");
    const row = { ...golden, providerSandboxId: "source", providerSnapshotId: "snapshot" };
    const before = await db.query("select * from goldens order by id");
    let account = "verified-account";
    let source = "source";
    const provider = {
      id: "boat",
      backendIdentity: async () => ({ id: account }),
      getSnapshot: async (name: string) => ({
        name,
        status: "ready",
        sourceSandboxId: name === "private-snapshot" ? "private-source" : source,
      }),
      get: async (id: string) => ({ id }),
    } as unknown as Provider;
    const adopt = createGoldenAdoption(db);
    const actor = { orgId: org, userId: owner, role: "admin" as const };
    const dry = await adopt(provider, actor, row);
    expect(dry.dryRun).toBe(true);
    expect((await db.query("select * from golden_backend_slots")).rows).toHaveLength(0);
    source = "wrong-source";
    await expect(adopt(provider, actor, row, dry.confirmation)).rejects.toThrow("Canonical adoption unavailable");
    source = "source";
    account = "other-account";
    await expect(adopt(provider, actor, row, dry.confirmation)).rejects.toThrow("Canonical adoption unavailable");
    account = "verified-account";
    // Database authorization, independently of stale caller claims.
    await db.query("update members set role='admin' where user_id=$1", [other]);
    await db.query("update members set role='member' where user_id=$1", [owner]);
    await expect(adopt(provider, actor, row, dry.confirmation)).rejects.toThrow("Canonical adoption unavailable");
    await db.query("update members set role='admin' where user_id=$1", [owner]);
    const applied = await adopt(provider, actor, row, dry.confirmation);
    expect(applied.dryRun).toBe(false);
    await expect(
      adopt(
        provider,
        { orgId: org, userId: other, role: "admin" },
        { ...privateGolden, providerSandboxId: "private-source", providerSnapshotId: "private-snapshot" },
      ),
    ).rejects.toThrow("Canonical adoption unavailable");
    expect((await db.query("select golden_id,backend_id from golden_backend_slots")).rows).toEqual([
      { golden_id: golden.id, backend_id: "verified-account" },
    ]);
    expect((await db.query("select * from goldens order by id")).rows).toEqual(before.rows);
    await expect(adopt(provider, actor, row, dry.confirmation)).rejects.toThrow("Canonical adoption unavailable");
    account = "different-account";
    await expect(adopt(provider, actor, row)).rejects.toThrow("Canonical adoption unavailable");
  } finally {
    await db.close();
  }
});
