import { expect, test } from "bun:test";
import { createSqlMcpRegistry } from "@armada/core/server";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { createMcpOAuthStore, createMcpSecretBox } from "../src/mcp-integration.ts";

test("SQL OAuth store fences callback replay, concurrent initial grants, consumed refresh and revocation", async () => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    const actor = crypto.randomUUID(),
      other = crypto.randomUUID(),
      org = crypto.randomUUID(),
      id = crypto.randomUUID();
    await db.query(`insert into auth.users(id) values($1),($2)`, [actor, other]);
    await db.query(`insert into public.orgs(id,name) values($1,'MCP test')`, [org]);
    await db.query(`insert into public.members(org_id,user_id,role) values($1,$2,'admin'),($1,$3,'member')`, [
      org,
      actor,
      other,
    ]);
    await db.query(
      `insert into public.mcp_connections(id,org_id,owner_id,scope,name,transport,url,auth_type) values($1,$2,$3,'personal','Example','http','https://example.com/mcp','oauth')`,
      [id, org, actor],
    );
    await db.query(`insert into public.mcp_grants(connection_id) values($1)`, [id]);
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const box = createMcpSecretBox(key),
      store = createMcpOAuthStore(db, key);
    const generation = await store.generation(id);
    const sealed = await box.seal(JSON.stringify({ access: crypto.randomUUID(), generation }));
    expect(await box.open(sealed)).toContain("access");
    const state = "ab".repeat(32);
    await store.putPending(state, { actorId: actor, connectionId: id, expiresAt: Date.now() + 60000, sealed });
    expect(await store.takePending(state, other, Date.now())).toBeNull();
    expect((await store.takePending(state, actor, Date.now()))?.sealed).toBe(sealed);
    expect(await store.takePending(state, actor, Date.now())).toBeNull();
    expect(await store.saveGrant(id, null, sealed, generation)).toBe(false); // No unbound initial publication.
    const actorStore = createMcpOAuthStore(db, key, actor);
    await store.putPending("ac".repeat(32), {
      actorId: actor,
      connectionId: id,
      expiresAt: Date.now() + 60000,
      sealed,
    });
    expect(await actorStore.takePending("ac".repeat(32), actor, Date.now())).not.toBeNull();
    expect(await actorStore.saveGrant(id, null, sealed, generation)).toBe(true);
    expect(await actorStore.saveGrant(id, null, sealed, generation)).toBe(false);
    const saved = await store.readGrant(id);
    if (!saved) throw Error("Missing persisted grant");
    const owner = crypto.randomUUID();
    expect(await store.claimRefresh(id, saved.version, generation, owner)).toBe(true);
    expect(await store.claimRefresh(id, saved.version, generation, crypto.randomUUID())).toBe(false);
    // Expired/ambiguous ownership cannot be reclaimed: upstream refresh might have consumed its token.
    await db.query(`update public.mcp_grants set refresh_until=now()-interval '1 second' where connection_id=$1`, [id]);
    expect(await store.claimRefresh(id, saved.version, generation, crypto.randomUUID())).toBe(false);
    expect(await store.readGrant(id)).toBeNull();
    expect(await store.saveGrant(id, saved.version, sealed, generation, owner)).toBe(false);
    await db.query(`update public.mcp_grants set generation=generation+1 where connection_id=$1`, [id]);
    await expect(
      store.putPending("cd".repeat(32), { actorId: actor, connectionId: id, expiresAt: Date.now() + 60000, sealed }),
    ).rejects.toThrow("no longer authorized");
    await store.revoke(id);
    expect(await store.readGrant(id)).toBeNull();
    expect(await store.saveGrant(id, saved.version, sealed, generation, owner)).toBe(false);
    // An admin may lose its role while the upstream exchange is in flight, AFTER state was taken.
    // The grant belongs to another admin, so a grant-generation check alone cannot cover this race.
    await db.query("update public.members set role='admin' where org_id=$1 and user_id=$2", [org, other]);
    const shared = await createSqlMcpRegistry(db, key).save(other, org, {
      name: "Shared OAuth",
      scope: "org",
      transport: "http",
      url: "https://example.com/shared",
      authType: "oauth",
    });
    const callbackStore = createMcpOAuthStore(db, key, actor);
    const sharedGeneration = await store.generation(shared.id);
    const pendingSeal = await box.seal(JSON.stringify({ generation: sharedGeneration }));
    await callbackStore.putPending("ef".repeat(32), {
      actorId: actor,
      connectionId: shared.id,
      expiresAt: Date.now() + 60000,
      sealed: pendingSeal,
    });
    expect(await callbackStore.takePending("ef".repeat(32), actor, Date.now())).not.toBeNull();
    await db.query("update public.members set role='member' where org_id=$1 and user_id=$2", [org, actor]);
    expect(await store.generation(shared.id)).toBe(sharedGeneration);
    expect(await callbackStore.saveGrant(shared.id, null, sealed, sharedGeneration)).toBe(false);
  } finally {
    await db.close();
  }
});
