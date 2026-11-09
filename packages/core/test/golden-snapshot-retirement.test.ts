import { expect, test } from "bun:test";
import { SQL } from "bun";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { providerRegistry } from "../../mcp-server/src/http.ts";
import { fakeBoat } from "../../mcp-server/test/support.ts";
import { encryptSecret } from "../src/crypto.ts";
import { sqlGoldenBackendSlots } from "../src/golden-create.ts";
import {
  captureGoldenPublication,
  enqueueGoldenRetirement,
  GoldenSnapshotRetirements,
  recordGoldenPublication,
} from "../src/golden-snapshot-retirement.ts";
import { beginGoldenOperation, createSqlGoldenStore, type Sql } from "../src/golden-store.ts";
import { type LaunchStores, launchSandbox } from "../src/launch.ts";
import { type Provider, ProviderError, type SnapshotInfo } from "../src/provider.ts";
import { createSqlVaultStore } from "../src/vault-store.ts";

const KEY = Buffer.alloc(32, 29).toString("base64");
const absent = () => new ProviderError({ provider: "boat", code: "not_found", retryable: false, message: "absent" });
async function fixture(sql: Sql, placement: "boat" | "modal" = "boat", visibility: "org" | "private" = "org") {
  const user = crypto.randomUUID(),
    org = crypto.randomUUID();
  await sql.query("insert into auth.users(id) values($1)", [user]);
  await sql.query("insert into orgs(id,name) values($1,$2)", [org, "retirement-" + org]);
  await sql.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [org, user]);
  const actor = { userId: user, orgId: org, role: "admin" as const };
  const store = createSqlGoldenStore(sql);
  const modal = placement === "modal" ? { workspace: "test-workspace", environment: "main", appId: "ap_" + org } : null;
  let authority: { scope: "org" | "user"; ownerId: string } = {
    scope: visibility === "org" ? "org" : "user",
    ownerId: visibility === "org" ? org : user,
  };
  const golden = await store.insert({
    orgId: org,
    ownerId: user,
    name: "retire",
    visibility,
    provider: placement,
    modal,
    config: { repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] },
  });
  await store.setSnapshot(golden.id, "old-" + golden.id);
  const old = "old-" + golden.id,
    next = "new-" + golden.id;
  const target = { orgId: org, ownerId: user, visibility, provider: placement, modal };
  const backend = "account-" + org;
  if (placement === "boat") {
    const slots = sqlGoldenBackendSlots(sql);
    const reservation = await slots.reserve({
      provider: "boat",
      backendId: backend,
      capacity: 1,
      orgId: org,
      ownerId: user,
    });
    await slots.finalize(reservation, golden.id);
  }
  const snapshots = new Map<string, SnapshotInfo>(
    [old, next].map((name) => [
      name,
      {
        name,
        status: "ready",
        sourceSandboxId: "builder-" + name,
        artifactId: "disk-" + name,
        ...(placement === "modal" ? { managementAuthority: { ...authority } } : {}),
      },
    ]),
  );
  const deleted: string[] = [];
  let failure: unknown;
  let deleteGate: (() => Promise<void>) | undefined;
  let account = backend;
  let sourceActive = false;
  let vmActions = 0;
  const forbiddenVMAction = async () => {
    vmActions++;
    throw Error("Retirement must not act on a VM");
  };
  const provider: Provider = {
    ...fakeBoat().provider,
    createGolden: forbiddenVMAction,
    stop: forbiddenVMAction,
    delete: forbiddenVMAction,
    exec: forbiddenVMAction,
    prompt: forbiddenVMAction,
    id: placement,
    harnesses: ["claude", "codex"],
    backendIdentity: async () => ({ id: account }),
    managementIdentity: async () => authority,
    getSnapshot: async (name: string) => {
      const info = snapshots.get(name);
      if (!info) throw absent();
      return info;
    },
    get: async (id: string) => ({
      id,
      state: sourceActive ? "ready" : "stopped",
      name: id,
      labels: {},
      providerState: "stopped",
    }),
    deleteSnapshot: async (name: string) => {
      deleted.push(name);
      if (failure) throw failure;
      await deleteGate?.();
      snapshots.delete(name);
    },
    fork: async () => {
      throw Error("A stale revision reached fork");
    },
  };
  const retirement = new GoldenSnapshotRetirements({ sql, encryptionKey: KEY, provider: async () => provider });
  const publish = async () => {
    const a = await captureGoldenPublication(provider, actor, target, golden.id, old, "builder-" + old);
    const b = await captureGoldenPublication(provider, actor, target, golden.id, next, "builder-" + next);
    await sql.transaction!(async (tx) => {
      await tx.query("select id from goldens where id=$1 for update", [golden.id]);
      await storeFor(tx).setSnapshot(golden.id, next);
      await enqueueGoldenRetirement(tx, await recordGoldenPublication(tx, a), await recordGoldenPublication(tx, b));
    });
  };
  const due = async () => {
    await sql.query(
      "update golden_snapshot_retirements set next_attempt_at=now()-interval '1 second',claim_until=null where golden_id=$1",
      [golden.id],
    );
  };
  return {
    sql,
    actor,
    store,
    golden,
    target,
    backend,
    old,
    next,
    snapshots,
    deleted,
    vmActions: () => vmActions,
    provider,
    retirement,
    publish,
    due,
    fail: (e: unknown) => {
      failure = e;
    },
    pause: (gate: () => Promise<void>) => {
      deleteGate = gate;
    },
    account: (id: string) => {
      account = id;
    },
    authority: (ownerId: string) => {
      authority = { scope: "org", ownerId };
    },
    active: () => {
      sourceActive = true;
    },
  };
}
const storeFor = createSqlGoldenStore;

async function seedHistory(f: Awaited<ReturnType<typeof fixture>>, middle?: string) {
  const insert = async (snapshot: string, existingGolden: unknown) =>
    f.sql.query<{ id: string }>(
      `insert into golden_build_jobs(id,reservation_id,org_id,owner_id,name,visibility,idempotency_key,request_hash,payload_enc,provider,golden_id,state,builder_id,snapshot,phase)
    values(gen_random_uuid(),case when $8='boat' then gen_random_uuid() else null end,$1,$2,'retire',$9,$3,'hash',$4,$8::public.sandbox_provider,$5,'succeeded',$6,$7,'complete') returning id`,
      [
        f.actor.orgId,
        f.actor.userId,
        crypto.randomUUID(),
        await encryptSecret(
          JSON.stringify({
            name: "retire",
            repos: ["acme/web"],
            config: null,
            setup: null,
            provider: f.target.provider,
            visibility: f.target.visibility,
            modal: f.target.modal,
            existingGolden,
          }),
          KEY,
        ),
        f.golden.id,
        "builder-" + snapshot,
        snapshot,
        f.target.provider,
        f.target.visibility,
      ],
    );
  await insert(f.old, null);
  if (middle) await insert(middle, { ...f.golden, providerSnapshotId: f.old });
  await insert(f.next, { ...f.golden, providerSnapshotId: middle ?? f.old });
  await f.store.setSnapshot(f.golden.id, f.next);
  return insert;
}

test("stale golden admission cannot fork a superseded revision", async () => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    const f = await fixture(db);
    // A real launch reads old, then credentials resolve while a rebuild publishes next.
    let forks = 0;
    f.provider.fork = async () => {
      forks++;
      throw Error("stale fork");
    };
    const stores = {
      goldens: f.store,
      sandboxes: {} as LaunchStores["sandboxes"],
      credentials: {
        resolve: async () => {
          await f.store.setSnapshot(f.golden.id, f.next);
          return { env: {}, secrets: [], codexAuthJson: false };
        },
      },
    } as LaunchStores;
    await expect(
      launchSandbox(f.provider, stores, f.actor, { golden: "retire", harness: "claude" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(forks).toBe(0);
    const release = await beginGoldenOperation(db, f.golden.id, { snapshotId: f.next, sandboxId: null });
    await release();
    expect((await db.query("select id from golden_operation_fences")).rows).toEqual([]);
  } finally {
    await db.close();
  }
});

test.each([
  "fence",
  "hidden-pointer",
  "tombstone-pointer",
  "job",
  "artifact",
  "source",
  "account",
  "authority",
  "active-source",
  "current-artifact",
  "current-source",
  "current-missing",
])("retirement retains candidate with %s protection or changed provenance", async (kind) => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    const f = await fixture(db);
    let release: (() => Promise<void>) | undefined;
    if (kind === "fence") release = await beginGoldenOperation(db, f.golden.id, { snapshotId: f.old, sandboxId: null });
    await f.publish();
    if (kind.endsWith("pointer")) {
      const hiddenOwner = crypto.randomUUID();
      await db.query("insert into auth.users(id) values($1)", [hiddenOwner]);
      const hidden = await f.store.insert({
        orgId: f.actor.orgId,
        ownerId: hiddenOwner,
        name: "hidden",
        visibility: "private",
        provider: "boat",
        modal: null,
        config: { repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] },
      });
      await f.store.setSnapshot(hidden.id, f.old);
      if (kind === "tombstone-pointer") await db.query("update goldens set removed_at=now() where id=$1", [hidden.id]);
    }
    if (kind === "job")
      await db.query(
        "insert into golden_build_jobs(id,reservation_id,org_id,owner_id,name,visibility,idempotency_key,request_hash,payload_enc,provider,golden_id,state,expected_snapshot_id) values(gen_random_uuid(),gen_random_uuid(),$1,$2,'recovery','org',$3,'hash',$4,'boat',$5,'recovery_required',$6)",
        [f.actor.orgId, f.actor.userId, crypto.randomUUID(), new Uint8Array([1]), f.golden.id, f.old],
      );
    if (kind === "artifact") f.snapshots.get(f.old)!.artifactId = "different";
    if (kind === "source") f.snapshots.get(f.old)!.sourceSandboxId = "different";
    if (kind === "account") f.account("different");
    if (kind === "authority") f.authority(crypto.randomUUID());
    if (kind === "active-source") f.active();
    if (kind === "current-artifact") f.snapshots.get(f.next)!.artifactId = "changed-current";
    if (kind === "current-source") f.snapshots.get(f.next)!.sourceSandboxId = "foreign-current";
    if (kind === "current-missing") f.snapshots.delete(f.next);
    await f.retirement.runOne();
    expect(f.deleted).toEqual([]);
    expect(f.snapshots.has(f.old)).toBe(true);
    const r = (
      await db.query<{ state: string; reason: string }>("select state,reason from golden_snapshot_retirements")
    ).rows[0]!;
    expect(r.state).toBe("deferred");
    expect(r.reason).not.toBeNull();
    if (release) {
      await release();
      await f.due();
      await f.retirement.runOne();
      expect(f.deleted).toEqual([f.old]);
    }
  } finally {
    await db.close();
  }
});

test.each(["success", "absent", "refusal", "unknown"])(
  "retirement %s outcome is idempotent and never deletes a raw artifact",
  async (mode) => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const f = await fixture(db);
      await f.publish();
      if (mode === "absent") f.snapshots.delete(f.old);
      if (mode === "refusal")
        f.fail(new ProviderError({ provider: "boat", code: "forbidden", message: "refused", retryable: false }));
      if (mode === "unknown") f.fail(Error("lost response"));
      await f.retirement.runOne();
      expect(f.snapshots.has(f.next)).toBe(true);
      if (mode === "refusal") {
        f.fail(undefined);
        await f.due();
        await f.retirement.runOne();
        expect(f.deleted).toEqual([f.old, f.old]);
      }
      if (mode === "unknown") {
        await f.due();
        await f.retirement.runOne();
        expect(f.deleted).toEqual([f.old]);
        f.snapshots.delete(f.old);
        await f.due();
        await f.retirement.runOne();
      }
      expect((await db.query<{ state: string }>("select state from golden_snapshot_retirements")).rows[0]!.state).toBe(
        "retired",
      );
      expect(f.deleted.every((name) => name === f.old)).toBe(true);
      expect(f.vmActions()).toBe(0);
      await f.due();
      await f.retirement.runOne();
      await expect(f.store.setSnapshot(f.golden.id, f.old)).rejects.toThrow("unavailable");
    } finally {
      await db.close();
    }
  },
);

test("historical dry-run follows proven succeeded chains, mutates nothing, and never enqueues the current handle", async () => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    const f = await fixture(db);
    const current = { ...f.golden, providerSnapshotId: f.next };
    const insert = await seedHistory(f);
    const unrelated = "unrelated-" + crypto.randomUUID(),
      unknown = "unknown-" + crypto.randomUUID();
    f.snapshots.set(unrelated, {
      name: unrelated,
      status: "ready",
      artifactId: "disk-unrelated",
      sourceSandboxId: "builder-" + unrelated,
    });
    f.snapshots.set(unknown, {
      name: unknown,
      status: "ready",
      artifactId: "disk-unknown",
      sourceSandboxId: "unknown-source",
    });
    await insert(unrelated, null); // A producer alone is not a successful superseding chain.

    await f.store.setSnapshot(f.golden.id, f.next);
    const before = await db.query("select * from golden_snapshot_retirements");
    const dry = await f.retirement.forCaller(f.actor.userId, [f.actor.orgId], f.golden.id, 10, false);
    expect(dry.results).toMatchObject([
      { oldSnapshot: f.old, newSnapshot: f.next, outcome: "eligible", reason: "proven_chain" },
    ]);
    expect((await db.query("select * from golden_snapshot_retirements")).rows).toEqual(before.rows);
    expect((await db.query("select * from golden_snapshot_publications")).rows).toEqual([]);
    expect(f.deleted).toEqual([]);
    const receipts = dry.results.flatMap((r) => (r.receipt ? [r.receipt] : []));
    expect(receipts[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(dry.results[0]?.proof).toMatchObject({
      backendId: f.backend,
      old: { sourceId: "builder-" + f.old, artifactId: "disk-" + f.old },
    });
    const shadow = await insert(f.next, { ...f.golden, providerSnapshotId: f.old });
    expect((await f.retirement.forCaller(f.actor.userId, [f.actor.orgId], f.golden.id, 10)).results).toMatchObject([
      { outcome: "deferred", reason: "current_provenance_unavailable" },
    ]);
    expect((await db.query("select * from golden_snapshot_retirements")).rows).toEqual([]);
    await db.query("delete from golden_build_jobs where id=$1", [shadow.rows[0]!.id]);
    f.snapshots.get(f.old)!.artifactId = "changed-after-review";
    expect((await f.retirement.reconcile(f.actor, current, 10, true, receipts)).results[0]).toMatchObject({
      outcome: "deferred",
      reason: "review_changed",
    });
    expect((await db.query("select * from golden_snapshot_retirements")).rows).toEqual([]);
    f.snapshots.get(f.old)!.artifactId = "disk-" + f.old;
    await f.retirement.reconcile(f.actor, current, 10, true, receipts);
    expect(
      (
        await db.query<{ review_receipt: string; reviewed_by: string }>(
          "select review_receipt,reviewed_by from golden_snapshot_retirements",
        )
      ).rows,
    ).toEqual([{ review_receipt: receipts[0]!, reviewed_by: f.actor.userId }]);
    expect((await db.query("select old_snapshot from golden_snapshot_retirements")).rows).toEqual([
      { old_snapshot: f.old },
    ]);
    await f.retirement.runOne();
    expect(f.deleted).toEqual([f.old]);
    expect(f.snapshots.has(f.next)).toBe(true);
    expect(f.snapshots.has(unrelated)).toBe(true);
    expect(f.snapshots.has(unknown)).toBe(true);
    await expect(f.retirement.forCaller(crypto.randomUUID(), [f.actor.orgId], f.golden.id, 10)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(f.retirement.forCaller(f.actor.userId, [crypto.randomUUID()], f.golden.id, 10)).rejects.toMatchObject({
      code: "not_found",
    });
  } finally {
    await db.close();
  }
});

const postgres = process.env.ARMADA_TEST_POSTGRES_URL;
test.skipIf(!postgres)(
  "PostgreSQL serializes retirement replicas, stale admission and pointer resurrection while deletion is in flight",
  async () => {
    const a = new SQL(postgres!, { max: 1 }),
      b = new SQL(postgres!, { max: 1 });
    const adapt = (client: Pick<SQL, "unsafe">): Sql => ({
      query: async <T>(text: string, params: unknown[] = []) => ({
        rows: Array.from(await client.unsafe(text, params as never[])) as T[],
      }),
    });
    const sqlA: Sql = { ...adapt(a), transaction: (work) => a.begin((tx) => work(adapt(tx))) };
    const sqlB: Sql = { ...adapt(b), transaction: (work) => b.begin((tx) => work(adapt(tx))) };
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let reached!: () => void;
    const entered = new Promise<void>((r) => {
      reached = r;
    });
    let running: Promise<boolean> | undefined;
    try {
      const f = await fixture(sqlA);
      await f.publish();
      f.pause(async () => {
        reached();
        await gate;
      });
      const other = new GoldenSnapshotRetirements({ sql: sqlB, encryptionKey: KEY, provider: async () => f.provider });
      running = f.retirement.runOne();
      await entered;
      await expect(
        beginGoldenOperation(sqlB, f.golden.id, { snapshotId: f.old, sandboxId: null }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(createSqlGoldenStore(sqlB).setSnapshot(f.golden.id, f.old)).rejects.toThrow("unavailable");
      expect(await other.runOne()).toBe(false);
      // Expired ownership permits readback only, not a second destructive provider request.
      await sqlB.query(
        "update golden_snapshot_retirements set claim_until=now()-interval '1 second',next_attempt_at=now()-interval '1 second' where golden_id=$1",
        [f.golden.id],
      );
      expect(await other.runOne()).toBe(true);
      expect(f.deleted).toEqual([f.old]);
      release();
      await running;
      await f.due();
      await other.runOne();
      expect(
        (
          await sqlB.query<{ state: string }>("select state from golden_snapshot_retirements where golden_id=$1", [
            f.golden.id,
          ])
        ).rows[0]!.state,
      ).toBe("retired");
      expect((await createSqlGoldenStore(sqlB).findByName(f.actor.orgId, "retire"))[0]?.providerSnapshotId).toBe(
        f.next,
      );
    } finally {
      release();
      await running;
      await Promise.all([a.close(), b.close()]);
    }
  },
);

test("retirement management authority stays immutable across cached-provider source resolutions", async () => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    const f = await fixture(db);
    const sealed = await encryptSecret("synthetic-same-backend-key", KEY);
    await db.query("update orgs set boat_api_key_enc=$2 where id=$1", [f.actor.orgId, sealed]);
    await db.query("insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'boat',$2)", [
      f.actor.userId,
      sealed,
    ]);
    const registry = providerRegistry({
      vault: createSqlVaultStore(db),
      encryptionKey: KEY,
      providerFor: () => f.provider,
    });
    const personal = await registry.resolve({ ...f.target, visibility: "private" }, { userId: f.actor.userId });
    const org = await registry.resolve(f.target, { userId: f.actor.userId });
    expect(await personal.managementIdentity!()).toEqual({ scope: "user", ownerId: f.actor.userId });
    expect(await org.managementIdentity!()).toEqual({ scope: "org", ownerId: f.actor.orgId });
    expect(await f.provider.managementIdentity!()).toEqual({ scope: "org", ownerId: f.actor.orgId });
  } finally {
    await db.close();
  }
});

test("retirement rechecks live authorization after provider inspection before admitting deletion", async () => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    const f = await fixture(db);
    await f.publish();
    const other = crypto.randomUUID();
    await db.query("insert into auth.users(id) values($1)", [other]);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [f.actor.orgId, other]);
    f.provider.get = async (id) => {
      await db.query("delete from members where org_id=$1 and user_id=$2", [f.actor.orgId, f.actor.userId]);
      return { id, name: id, state: "stopped", providerState: "stopped", labels: {} };
    };
    await f.retirement.runOne();
    expect(f.deleted).toEqual([]);
    expect(f.snapshots.has(f.old)).toBe(true);
    expect((await db.query("select state,reason,delete_started from golden_snapshot_retirements")).rows).toEqual([
      { state: "deferred", reason: "authority_or_reference_changed", delete_started: false },
    ]);
  } finally {
    await db.close();
  }
});

test.each(["explicit", "missing", "changed"])(
  "private Modal history uses explicit immutable authority (%s)",
  async (mode) => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const f = await fixture(db, "modal", "private");
      await seedHistory(f);
      const admin = crypto.randomUUID();
      await db.query("insert into auth.users(id) values($1)", [admin]);
      await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [f.actor.orgId, admin]);
      await db.query("update members set role='member' where org_id=$1 and user_id=$2", [
        f.actor.orgId,
        f.actor.userId,
      ]);
      if (mode === "missing") delete f.snapshots.get(f.old)!.managementAuthority;
      if (mode === "changed") f.snapshots.get(f.old)!.managementAuthority = { scope: "user", ownerId: admin };
      const dry = await f.retirement.forCaller(f.actor.userId, [f.actor.orgId], f.golden.id, 10);
      if (mode === "explicit") {
        expect(dry.results[0]).toMatchObject({
          outcome: "eligible",
          proof: { authority: { scope: "user", ownerId: f.actor.userId } },
        });
        const receipts = dry.results.flatMap((r) => (r.receipt ? [r.receipt] : []));
        await f.retirement.forCaller(f.actor.userId, [f.actor.orgId], f.golden.id, 10, true, receipts);
        await f.retirement.runOne();
        expect(f.deleted).toEqual([f.old]);
        expect(f.snapshots.has(f.next)).toBe(true);
      } else {
        expect(dry.results[0]?.outcome).toBe("deferred");
        expect((await db.query("select id from golden_snapshot_retirements")).rows).toEqual([]);
        expect(f.deleted).toEqual([]);
      }
      await expect(f.retirement.forCaller(admin, [f.actor.orgId], f.golden.id, 10)).rejects.toMatchObject({
        code: "not_found",
      });
    } finally {
      await db.close();
    }
  },
);

test.each(["resolve", "backend", "authority"])(
  "operator reconciliation sanitizes prerequisite failure at %s",
  async (stage) => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const f = await fixture(db);
      const failure = () => {
        throw new ProviderError({
          provider: "boat",
          code: "unavailable",
          message: "sensitive-outbound-detail",
          retryable: true,
        });
      };
      const unavailable = new GoldenSnapshotRetirements({
        sql: db,
        encryptionKey: KEY,
        provider: async () => {
          if (stage === "resolve") return failure();
          return {
            ...f.provider,
            backendIdentity: stage === "backend" ? async () => failure() : f.provider.backendIdentity!,
            managementIdentity: stage === "authority" ? async () => failure() : f.provider.managementIdentity!,
          };
        },
      });
      const result = await unavailable.forCaller(f.actor.userId, [f.actor.orgId], f.golden.id, 10);
      expect(result).toEqual({ results: [{ outcome: "deferred", reason: "authority_unavailable" }] });
      expect(JSON.stringify(result)).not.toContain("sensitive-outbound-detail");
      expect(f.deleted).toEqual([]);
    } finally {
      await db.close();
    }
  },
);

test("known current-revision fence does not pin an unrelated old saved handle", async () => {
  const db = await openDatabase();
  let release: (() => Promise<void>) | undefined;
  try {
    await applyMigrations(db);
    const f = await fixture(db);
    await f.publish();
    release = await beginGoldenOperation(db, f.golden.id, { snapshotId: f.next, sandboxId: null, kind: "launch" });
    await f.retirement.runOne();
    expect(f.deleted).toEqual([f.old]);
    expect(f.snapshots.has(f.next)).toBe(true);
  } finally {
    await release?.();
    await db.close();
  }
});

test.each(["known-build", "unknown-build", "unknown-fence"])(
  "retirement distinguishes precise current dependencies from legacy unknown %s",
  async (mode) => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const f = await fixture(db);
      await f.publish();
      if (mode === "unknown-fence")
        await db.query(
          "insert into golden_operation_fences(golden_id,expected_snapshot_id,expected_sandbox_id) values($1,$2,null)",
          [f.golden.id, f.next],
        );
      else {
        const reservation = await sqlGoldenBackendSlots(db).reserveExisting({
          provider: "boat",
          backendId: f.backend,
          capacity: 1,
          goldenId: f.golden.id,
        });
        await db.query(
          `insert into golden_build_jobs(id,reservation_id,org_id,owner_id,name,visibility,idempotency_key,request_hash,payload_enc,provider,golden_id,expected_snapshot_id,revision_known)
        values(gen_random_uuid(),$1,$2,$3,'retire','org',$4,'hash',$5,'boat',$6,$7,$8)`,
          [
            reservation,
            f.actor.orgId,
            f.actor.userId,
            crypto.randomUUID(),
            await encryptSecret(
              JSON.stringify({
                existingGolden: { ...f.golden, providerSnapshotId: f.next },
                provider: "boat",
                visibility: "org",
              }),
              KEY,
            ),
            f.golden.id,
            mode === "known-build" ? f.next : null,
            mode === "known-build",
          ],
        );
      }
      await f.retirement.runOne();
      if (mode === "known-build") {
        expect(f.deleted).toEqual([f.old]);
        expect(f.snapshots.has(f.next)).toBe(true);
        expect((await db.query("select state from golden_build_jobs")).rows).toEqual([{ state: "queued" }]);
        expect(
          (await db.query<{ build_id: string | null }>("select build_id from golden_backend_slots")).rows[0]?.build_id,
        ).not.toBeNull();
      } else {
        expect(f.deleted).toEqual([]);
        expect(f.snapshots.has(f.old)).toBe(true);
      }
    } finally {
      await db.close();
    }
  },
);

test("historical reconciliation uses immutable publication witnesses after an intermediate handle is retired", async () => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    const f = await fixture(db);
    const middle = "middle-" + crypto.randomUUID();
    f.snapshots.set(middle, {
      name: middle,
      status: "ready",
      sourceSandboxId: "builder-" + middle,
      artifactId: "disk-" + middle,
    });
    await seedHistory(f, middle);
    const first = await f.retirement.forCaller(f.actor.userId, [f.actor.orgId], f.golden.id, 1);
    await f.retirement.forCaller(
      f.actor.userId,
      [f.actor.orgId],
      f.golden.id,
      1,
      true,
      first.results.flatMap((r) => (r.receipt ? [r.receipt] : [])),
    );
    await f.retirement.runOne();
    expect(f.deleted).toEqual([middle]);
    const rest = await f.retirement.forCaller(f.actor.userId, [f.actor.orgId], f.golden.id, 20);
    expect(rest.results.find((r) => r.oldSnapshot === f.old)).toMatchObject({
      outcome: "eligible",
      proof: { replacement: { snapshot: middle, artifactId: "disk-" + middle } },
    });
    await f.retirement.forCaller(
      f.actor.userId,
      [f.actor.orgId],
      f.golden.id,
      20,
      true,
      rest.results.flatMap((r) => (r.receipt ? [r.receipt] : [])),
    );
    await f.retirement.runOne();
    expect(f.deleted).toEqual([middle, f.old]);
    expect(f.snapshots.has(f.next)).toBe(true);
  } finally {
    await db.close();
  }
});

test.skipIf(!postgres)(
  "PostgreSQL image reference predicate preserves retained recovery IDs through the production SQL adapter",
  async () => {
    const client = new SQL(postgres!, { max: 2 });
    const { sqlOver } = await import("../../mcp-server/src/sql.ts");
    const { createSqlModalStore } = await import("../../provider-modal/src/store.ts");
    const sql = sqlOver(client);
    try {
      const f = await fixture(sql),
        id = "logical-ref-" + crypto.randomUUID(),
        retained = "im_retained_" + crypto.randomUUID();
      const images = createSqlModalStore(sql, {
        orgId: f.actor.orgId,
        userId: f.actor.userId,
        visibility: "private",
        binding: { workspace: "local-test", environment: "main", appId: "ap_local_ref" },
      });
      await images.reserve("ref-" + crypto.randomUUID(), {
        info: { id, name: id, state: "stopped", providerState: "stopped", labels: {} },
        generation: 3,
        phase: "stopped",
        golden: false,
        ttlSeconds: 60,
        physicalName: "metadata-only-fixture",
        imageId: "im_current_" + id,
        recoveryImageId: "im_current_recovery_" + id,
        retainedRecoveryIds: [retained],
      });
      expect(await images.imageReferenced(retained)).toBe(true);
      await images.lease(id, async (row, save) => {
        row.retainedRecoveryIds = [];
        await save(row);
      });
      expect(await images.imageReferenced(retained)).toBe(false);
    } finally {
      await client.close();
    }
  },
);
