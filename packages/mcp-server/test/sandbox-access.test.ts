import { expect, test } from "bun:test";
import type { SandboxListMetadata } from "@armada/core";
import type { Caller } from "../src/caller.ts";
import { createSqlData } from "../src/data.ts";
import { migratedDatabase } from "./migrated-database.ts";

// Primary policy proof: actual migrations, service SQL, authenticated RLS and definer RPC.
// A regression to golden/legacy visibility or trusting a stale role fails this matrix.
test("current org metadata is allowlisted; raw interior and mutation require current owner/admin", async () => {
  const db = await migratedDatabase();
  const p = {
    org: crypto.randomUUID(),
    owner: crypto.randomUUID(),
    member: crypto.randomUUID(),
    admin: crypto.randomUUID(),
  };
  try {
    const outsider = crypto.randomUUID();
    await db.query("insert into auth.users(id) values($1)", [outsider]);
    await db.query("insert into auth.users(id) values($1),($2),($3)", [p.owner, p.member, p.admin]);
    await db.query("insert into orgs(id,name) values($1,'Access policy')", [p.org]);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'member'),($1,$3,'member'),($1,$4,'admin')", [
      p.org,
      p.owner,
      p.member,
      p.admin,
    ]);
    // An admin in another org still cannot open this org's sandbox interiors.
    const otherOrg = crypto.randomUUID();
    await db.query("insert into orgs(id,name) values($1,'Other org')", [otherOrg]);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [otherOrg, p.member]);
    const golden = crypto.randomUUID();
    await db.query(
      `insert into goldens(id,org_id,owner_id,name,visibility,boat_snapshot_id,config)
      values($1,$2,$3,'source','private','snapshot','{"repos":[],"init":[]}'::jsonb)`,
      [golden, p.org, p.owner],
    );
    const modal = crypto.randomUUID();
    await db.query(
      `insert into goldens(id,org_id,owner_id,name,visibility,provider,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
      values($1,$2,$3,'sensitive-source','private','modal','image-private','workspace-private','main','app-private','{"repos":[],"init":[]}'::jsonb)`,
      [modal, p.org, p.owner],
    );
    const ids: string[] = [];
    // Policy is provider-independent: cover both providers and visibility values
    // without replaying the same SQL authorization matrix for their cross-product.
    for (const [source, provider, visibility] of [
      [golden, "boat", "private"],
      [modal, "modal", "org"],
    ] as const) {
      const id = crypto.randomUUID();
      ids.push(id);
      await db.query(
        `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,visibility,access_owner_id,conversation_ids,status_reason)
          values($1,$2,$3,$4,$5,$6,'claude','failed',$7,$8,array['conversation-private'],'failure-private')`,
        [id, source, p.org, p.owner, provider, `physical-${id}`, visibility, p.member],
      );
    }
    await db.query("update sandboxes set task_prompt_id='finished-turn', task_outcome=$1::jsonb", [
      JSON.stringify({ state: "blocked", reason: "interior-only" }),
    ]);
    await db.query("update goldens set removed_at=now() where id=$1", [golden]);
    const caller = (userId: string): Caller => ({ userId, via: "service", orgs: [{ orgId: p.org, role: "admin" }] });
    const data = (userId: string) => createSqlData(db)(caller(userId)).sandboxes;
    await db.query(
      "update sandboxes set status='stopped',status_reason='idle_paused',stopped_at=now(),expires_at=now()+interval '1 hour' where id=$1",
      [ids[0]],
    );
    const expectedKeys = [
      "idlePaused",
      "usage",
      "preservationNote",
      "taskOutcome",
      "providerSandboxId",
      "boatId",
      "id",
      "orgId",
      "ownerId",
      "provider",
      "harness",
      "model",
      "reasoningEffort",
      "status",
      "createdAt",
      "stoppedAt",
      "expiresAt",
      "effectiveTtlSeconds",
      "machineSize",
      "displayLabel",
      "canOpen",
      "canManage",
    ].sort();
    const asUser = async (userId: string, work: () => Promise<void>) => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userId]);
      await db.exec("set role authenticated");
      try {
        await work();
      } finally {
        await db.exec("reset role");
      }
    };
    for (const [actor, mayList, mayOpen] of [
      [p.owner, true, true],
      [p.member, true, false],
      [p.admin, true, true],
      [outsider, false, false],
    ] as const) {
      const list = await data(actor).list({ limit: 100 });
      expect(list.total).toBe(mayList ? 2 : 0);
      for (const row of list.rows) {
        expect(Object.keys(row).sort()).toEqual(expectedKeys);
        expect(row.providerSandboxId).toBe(`physical-${row.id}`);
        expect(row.boatId).toBe(row.provider === "boat" ? row.providerSandboxId : null);
        expect(row.taskOutcome).toEqual(mayOpen ? { state: "blocked", reason: "interior-only" } : null);
        expect(row.idlePaused).toBe(row.id === ids[0]);
        expect(row.canOpen).toBe(mayOpen);
        expect(row.canManage).toBe(mayOpen);
        expect(JSON.stringify(row)).not.toMatch(/sensitive-source|conversation-private|failure-private|app-private/);
      }
      expect((await data(actor).list({ limit: 1, page: 5 })).total).toBe(mayList ? 2 : 0);
      expect((await data(actor).list({ limit: 1, page: 5 })).rows).toEqual([]);
      for (const id of ids) {
        expect(!!(await data(actor).get(id))).toBe(mayOpen);
        if (mayOpen) await data(actor).update(id, { conversationIds: ["changed"] });
        else await expect(data(actor).update(id, { conversationIds: ["forbidden"] })).rejects.toThrow();
        const report = data(actor).reportTaskOutcome!(id, "finished-turn", {
          state: "blocked",
          reason: "interior-only",
        });
        if (mayOpen) await report;
        else await expect(report).rejects.toThrow();
      }
      await asUser(actor, async () => {
        const rpc = await db.query<SandboxListMetadata>("select * from sandbox_list_metadata()");
        expect(rpc.rows.length).toBe(mayList ? 2 : 0);
        for (const row of rpc.rows) {
          expect(Object.keys(row).sort()).toEqual(expectedKeys.filter((key) => key !== "usage"));
          expect(row.taskOutcome).toEqual(mayOpen ? { state: "blocked", reason: "interior-only" } : null);
          expect(row.idlePaused).toBe(row.id === ids[0]);
          expect(row.canOpen).toBe(mayOpen);
        }
        expect((await db.query("select * from sandboxes")).rows.length).toBe(mayOpen ? 2 : 0);
        expect((await db.query("update sandboxes set conversation_ids=array['rls'] returning id")).rows.length).toBe(
          mayOpen ? 2 : 0,
        );
        await expect(db.query("select * from mcp_grants")).rejects.toThrow("permission denied"); // even admin
      });
    }
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [p.org, outsider]);
    await db.query("update members set role='member' where org_id=$1 and user_id=$2", [p.org, p.admin]);
    expect(await data(p.admin).get(ids[0]!)).toBeNull(); // stale admin claim cannot open
    await db.query("delete from members where org_id=$1 and user_id=$2", [p.org, p.owner]);
    expect((await data(p.owner).list({ limit: 100 })).total).toBe(0);
    expect(await data(p.owner).get(ids[0]!)).toBeNull();
    await asUser(p.owner, async () => {
      expect((await db.query("select * from sandbox_list_metadata()")).rows).toEqual([]);
      expect((await db.query("select * from sandboxes")).rows).toEqual([]);
    });
    await db.exec("set role anon");
    try {
      await expect(db.query("select * from sandbox_list_metadata()")).rejects.toThrow("permission denied");
    } finally {
      await db.exec("reset role");
    }
  } finally {
    await db.close();
  }
});
