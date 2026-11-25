import { describe, expect, test } from "bun:test";
import { insertSandboxFixture } from "../../core/test/sandbox.fixture.ts";
import type { Caller } from "../src/caller.ts";
import { createSqlData } from "../src/data.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";

const getFixture = rowOnlyDatabase();

// Owning SQL boundary: protects authorization, retained provenance and durable admission
// from regressions that a provider-only mock or UI test cannot detect.
describe("golden removal authority", () => {
  test("removal preserves child access and bindings, hides selection, and checks live authority", async () => {
    const { db, people } = await getFixture();
    const caller = (userId: string, orgId = people.org): Caller => ({
      userId,
      orgs: [{ orgId, role: "admin" }],
      via: "supabase",
    });
    const source = createSqlData(db);
    const admin = source(caller(people.admin));
    const owner = source(caller(people.owner));
    const member = source(caller(people.member));
    const shared = (await admin.goldens.findByName(people.org, "shared"))[0]!;
    const privateGolden = (await owner.goldens.findByName(people.org, "mine"))[0]!;
    await expect(member.removeGolden!(shared.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(admin.removeGolden!(privateGolden.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(source(caller(people.member, people.otherOrg)).removeGolden!(shared.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await db.query(
      "insert into golden_backend_slots(provider,backend_id,max_goldens,org_id,owner_id,golden_id) values('boat','account',5,$1,$2,$3)",
      [people.org, people.admin, shared.id],
    );
    const reservation = crypto.randomUUID();
    await db.query("update golden_backend_slots set build_id=$1 where golden_id=$2", [reservation, shared.id]);
    await expect(admin.removeGolden!(shared.id)).rejects.toMatchObject({ code: "conflict" });
    await db.query("select release_golden_backend_slot($1)", [reservation]);
    const child = await insertSandboxFixture(db, {
      id: crypto.randomUUID(),
      goldenId: shared.id,
      orgId: people.org,
      ownerId: people.member,
      provider: "boat",
      providerSandboxId: "bx_retained",
      harness: "claude",
      status: "running",
      model: "claude-sonnet-4-6",
      reasoningEffort: "medium",
      repositoryDir: "web",
    });
    await db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [child.id]);
    const removed = await admin.removeGolden!(shared.id);
    expect(removed.artifacts).toBe("retained");
    expect(await admin.removeGolden!(shared.id)).toEqual(removed);
    expect(await member.goldens.findByName(people.org, "shared")).toEqual([]);
    expect((await member.sandboxes.get(child.id))?.providerSandboxId).toBe("bx_retained");
    await member.sandboxes.update(child.id, { effectiveTtlSeconds: 300 });
    expect((await member.sandboxes.get(child.id))?.effectiveTtlSeconds).toBe(300);
    const retained = await db.query("select provider_snapshot_id,owner_id from goldens where id=$1", [shared.id]);
    expect(retained.rows[0]).toEqual({ provider_snapshot_id: shared.providerSnapshotId, owner_id: shared.ownerId });
    expect((await db.query("select golden_id from golden_backend_slots")).rows).toEqual([{ golden_id: shared.id }]);
    await expect(
      db.query(
        "insert into golden_build_jobs(id,org_id,owner_id,name,visibility,idempotency_key,request_hash,payload_enc,reservation_id) values($1,$2,$3,'shared','org','late','hash',$4,$5)",
        [crypto.randomUUID(), people.org, people.admin, new Uint8Array([1]), crypto.randomUUID()],
      ),
    ).rejects.toThrow("removed");
    await expect(
      member.goldens.beginOperation!(shared.id, {
        snapshotId: shared.providerSnapshotId,
        sandboxId: shared.providerSandboxId,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(db.query("update goldens set removed_at=null where id=$1", [shared.id])).rejects.toThrow("immutable");
    await owner.removeGolden!(privateGolden.id);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [people.member]);
    await db.exec("set role authenticated");
    try {
      for (const hidden of [privateGolden.id, crypto.randomUUID()]) {
        await expect(db.query("insert into golden_operation_fences(golden_id) values($1)", [hidden])).rejects.toThrow(
          "permission denied",
        );
      }
    } finally {
      await db.exec("reset role");
    }
  });
});

describe("JWT fence authority", () => {
  test("JWTs cannot forge or release service fences, including after revocation or demotion", async () => {
    const { db, people } = await getFixture();
    const data = createSqlData(db)({
      userId: people.admin,
      orgs: [{ orgId: people.org, role: "admin" }],
      via: "supabase",
    });
    const golden = (await data.goldens.findByName(people.org, "shared"))[0]!;
    const release = await data.goldens.beginOperation!(golden.id, {
      snapshotId: golden.providerSnapshotId,
      sandboxId: golden.providerSandboxId,
    });
    await release.retain!({ kind: "connect", sandboxId: "bx_unknown", snapshotId: golden.providerSnapshotId! });
    // Preserve and protect pre-migration user-owned admissions as well as service-owned rows.
    const legacy = await db.query<{ id: string }>(
      "insert into golden_operation_fences(golden_id,owner_id,receipt,expected_snapshot_id,expected_sandbox_id) select $1,$2,$3::jsonb,provider_snapshot_id,provider_sandbox_id from goldens where id=$1 returning id",
      [
        golden.id,
        people.admin,
        JSON.stringify({ kind: "connect", sandboxId: "bx_legacy_unknown", snapshotId: golden.providerSnapshotId }),
      ],
    );
    const fences = await db.query<{ id: string }>("select id from golden_operation_fences order by id");
    const fenceId = legacy.rows[0]!.id;
    const denyJwtMutation = async (userId: string) => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userId]);
      await db.exec("set role authenticated");
      try {
        for (const [query, params] of [
          ["insert into golden_operation_fences(golden_id) values($1)", [golden.id]],
          [
            "update golden_operation_fences set receipt=$2::jsonb where id=$1",
            [
              fenceId,
              JSON.stringify({
                kind: "connect",
                sandboxId: golden.providerSandboxId,
                snapshotId: golden.providerSnapshotId,
              }),
            ],
          ],
          ["delete from golden_operation_fences where id=$1", [fenceId]],
        ] as const)
          await expect(db.query(query, [...params])).rejects.toThrow("permission denied");
      } finally {
        await db.exec("reset role");
      }
    };
    await denyJwtMutation(people.member);
    await denyJwtMutation(people.admin);
    await db.query("delete from members where org_id=$1 and user_id=$2", [people.org, people.member]);
    await denyJwtMutation(people.member);
    await db.query("update members set role='admin' where org_id=$1 and user_id=$2", [people.org, people.owner]);
    await db.query("delete from members where org_id=$1 and user_id=$2", [people.org, people.admin]);
    await denyJwtMutation(people.admin);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [people.org, people.admin]);
    await db.query("update members set role='member' where org_id=$1 and user_id=$2", [people.org, people.admin]);
    await denyJwtMutation(people.admin);
    expect((await db.query("select id from golden_operation_fences order by id")).rows).toEqual(fences.rows);
    await db.query("update members set role='admin' where org_id=$1 and user_id=$2", [people.org, people.admin]);

    await expect(data.removeGolden!(golden.id)).rejects.toMatchObject({ code: "conflict" });
  });
});
