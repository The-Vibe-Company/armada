import { expect, test } from "bun:test";
import { createSqlGoldenStore, launchSandbox, ProviderError } from "@armada/core/server";
import type { Caller } from "../src/caller.ts";
import { createSqlData } from "../src/data.ts";
import { database, fakeBoat } from "./support.ts";

// Owning SQL boundary: protects authorization, retained provenance and durable admission
// from regressions that a provider-only mock or UI test cannot detect.
test("removal preserves child access and bindings, hides selection, and checks live authority", async () => {
  const { db, people } = await database();
  try {
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
    const child = await member.sandboxes.insert({
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
    await member.sandboxes.update(child.id, { status: "stopped", stoppedAt: new Date().toISOString() });
    const removed = await admin.removeGolden!(shared.id);
    expect(removed.artifacts).toBe("retained");
    expect(await admin.removeGolden!(shared.id)).toEqual(removed);
    expect(await member.goldens.findByName(people.org, "shared")).toEqual([]);
    expect((await member.sandboxes.get(child.id))?.providerSandboxId).toBe("bx_retained");
    await member.sandboxes.update(child.id, { status: "running", stoppedAt: null });
    expect((await member.sandboxes.get(child.id))?.status).toBe("running");
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
  } finally {
    await db.close();
  }
});

test("actual launch admission blocks removal during fork; lost provider outcomes never retire artifacts", async () => {
  const { db, people } = await database();
  try {
    const caller: Caller = { userId: people.admin, orgs: [{ orgId: people.org, role: "admin" }], via: "supabase" };
    const data = createSqlData(db)(caller);
    const golden = (await data.goldens.findByName(people.org, "shared"))[0]!;
    const boat = fakeBoat();
    let admitted!: () => void;
    const reached = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    let proceed!: () => void;
    const blocked = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const fork = boat.provider.fork.bind(boat.provider);
    boat.provider.fork = async (request) => {
      admitted();
      await blocked;
      return fork(request);
    };
    const launch = launchSandbox(
      boat.provider,
      {
        goldens: data.goldens,
        sandboxes: data.sandboxes,
        credentials: { resolve: async () => ({ env: {}, secrets: [], codexAuthJson: false }) },
      },
      { userId: people.admin, orgId: people.org, role: "admin" },
      { golden: "shared", harness: "claude" },
    );
    await reached;
    await expect(data.removeGolden!(golden.id)).rejects.toMatchObject({ code: "conflict" });
    proceed();
    const launched = await launch;
    await data.removeGolden!(golden.id);
    expect((await data.sandboxes.get(launched.sandbox.id))?.providerSandboxId).toBe(launched.sandbox.providerSandboxId);
    await expect(
      launchSandbox(
        boat.provider,
        {
          goldens: data.goldens,
          sandboxes: data.sandboxes,
          credentials: { resolve: async () => ({ env: {}, secrets: [], codexAuthJson: false }) },
        },
        { userId: people.admin, orgId: people.org, role: "admin" },
        { golden: "shared", harness: "claude" },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(boat.forks).toHaveLength(1);
    // A crashed worker fence has no expiry: unknown physical state requires reconciliation,
    // never a stop ACK or a timeout interpreted as deletion.
    const privateGolden = (
      await createSqlData(db)({
        userId: people.owner,
        orgs: [{ orgId: people.org, role: "member" }],
        via: "supabase",
      }).goldens.findByName(people.org, "mine")
    )[0]!;
    const ownerData = createSqlData(db)({
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
      via: "supabase",
    });
    const unknownBoat = fakeBoat();
    const physicalFork = unknownBoat.provider.fork.bind(unknownBoat.provider);
    unknownBoat.provider.fork = async (request) => {
      await physicalFork(request);
      throw new Error("provider response lost");
    };
    await expect(
      launchSandbox(
        unknownBoat.provider,
        {
          goldens: ownerData.goldens,
          sandboxes: ownerData.sandboxes,
          credentials: { resolve: async () => ({ env: {}, secrets: [], codexAuthJson: false }) },
        },
        { userId: people.owner, orgId: people.org, role: "member" },
        { golden: "mine", harness: "claude" },
      ),
    ).rejects.toThrow("provider response lost");
    expect(unknownBoat.forks).toHaveLength(1);
    expect((await db.query("select golden_id from golden_operation_fences")).rows).toEqual([
      { golden_id: privateGolden.id },
    ]);
    await db.query("update golden_operation_fences set created_at='2000-01-01' where golden_id=$1", [privateGolden.id]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [people.owner]);
    await expect(db.query("select remove_golden($1)", [privateGolden.id])).rejects.toThrow("unresolved");
  } finally {
    await db.close();
  }
});

test("known non-mutating launch refusal releases admission", async () => {
  const { db, people } = await database();
  try {
    const actor = { userId: people.admin, orgId: people.org, role: "admin" as const };
    const data = createSqlData(db)({
      userId: people.admin,
      orgs: [{ orgId: people.org, role: "admin" }],
      via: "supabase",
    });
    const boat = fakeBoat();
    const refused = {
      ...boat.provider,
      fork: async () => {
        throw new ProviderError({
          provider: "boat",
          code: "payment_required",
          retryable: false,
          message: "Billing refusal",
        });
      },
    };
    const credentials = { resolve: async () => ({ env: {}, secrets: [], codexAuthJson: false }) };
    await expect(
      launchSandbox(refused, { goldens: data.goldens, sandboxes: data.sandboxes, credentials }, actor, {
        golden: "shared",
        harness: "claude",
      }),
    ).rejects.toMatchObject({ code: "payment_required" });
    expect((await db.query("select id from golden_operation_fences")).rows).toEqual([]);
  } finally {
    await db.close();
  }
});

test("JWTs cannot forge or release service fences, including after revocation or demotion", async () => {
  const { db, people } = await database();
  try {
    const actor = { userId: people.admin, orgId: people.org, role: "admin" as const };
    const data = createSqlData(db)({
      userId: people.admin,
      orgs: [{ orgId: people.org, role: "admin" }],
      via: "supabase",
    });
    const golden = (await data.goldens.findByName(people.org, "shared"))[0]!;
    const boat = fakeBoat();
    const credentials = { resolve: async () => ({ env: {}, secrets: [], codexAuthJson: false }) };
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

    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [people.admin]);
    await db.exec("set role authenticated");
    try {
      // Direct JWT physical operations must fail before any fork, not omit their fence.
      await expect(
        launchSandbox(
          boat.provider,
          {
            goldens: createSqlGoldenStore(db),
            sandboxes: data.sandboxes,
            credentials,
          },
          actor,
          { golden: "shared", harness: "claude" },
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(boat.forks).toHaveLength(0);
    } finally {
      await db.exec("reset role");
    }
    await expect(data.removeGolden!(golden.id)).rejects.toMatchObject({ code: "conflict" });
  } finally {
    await db.close();
  }
});
