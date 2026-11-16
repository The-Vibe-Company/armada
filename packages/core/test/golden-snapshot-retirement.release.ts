// This contract must never silently skip in release validation.
if (!process.env.ARMADA_TEST_POSTGRES_URL) throw new Error("ARMADA_TEST_POSTGRES_URL is required");

// Release-only PostgreSQL contracts; retained unit cases stay in the sibling test file.
import { expect, test } from "bun:test";
import { SQL } from "bun";

import { fakeBoat } from "../../mcp-server/test/support.ts";
import { sqlGoldenBackendSlots } from "../src/golden-create.ts";
import {
  captureGoldenPublication,
  enqueueGoldenRetirement,
  GoldenSnapshotRetirements,
  recordGoldenPublication,
} from "../src/golden-snapshot-retirement.ts";
import { beginGoldenOperation, createSqlGoldenStore, type Sql } from "../src/golden-store.ts";
import { type Provider, ProviderError, type SnapshotInfo } from "../src/provider.ts";

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

const postgres = process.env.ARMADA_TEST_POSTGRES_URL;
test("PostgreSQL serializes retirement replicas, stale admission and pointer resurrection while deletion is in flight", async () => {
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
    await expect(beginGoldenOperation(sqlB, f.golden.id, { snapshotId: f.old, sandboxId: null })).rejects.toMatchObject(
      { code: "conflict" },
    );
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
    expect((await createSqlGoldenStore(sqlB).findByName(f.actor.orgId, "retire"))[0]?.providerSnapshotId).toBe(f.next);
  } finally {
    release();
    await running;
    await Promise.all([a.close(), b.close()]);
  }
});

test("PostgreSQL image reference predicate preserves retained recovery IDs through the production SQL adapter", async () => {
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
});
