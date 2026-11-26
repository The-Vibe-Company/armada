import { expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { migratedDatabase } from "./support/database.ts";

const database = migratedDatabase();
const org = crypto.randomUUID();
const owner = crypto.randomUUID();
const successor = crypto.randomUUID();

async function sandboxWithStop(db: PGlite) {
  const golden = crypto.randomUUID();
  const sandbox = crypto.randomUUID();
  await db.query("insert into auth.users(id) values ($1)", [owner]);
  await db.query("insert into orgs(id, name) values ($1, 'Jobs')", [org]);
  await db.query(
    "insert into goldens(id, org_id, name, boat_snapshot_id, visibility, owner_id) values ($1, $2, 'fixture', 'snapshot', 'org', $3)",
    [golden, org, owner],
  );
  await db.query(
    `insert into sandboxes (id, boat_id, golden_id, org_id, owner_id, harness, status)
     values ($1, 'fixture', $2, $3, $4, 'codex', 'ready')`,
    [sandbox, golden, org, owner],
  );
  await enqueue(db, sandbox, "stop");
  return sandbox;
}

async function enqueue(db: PGlite, sandbox: string, kind: string) {
  await db.query(
    `insert into jobs (kind, sandbox_id, org_id, generation, idem_key, deadline_at, max_attempts)
     values ($1, $2, $3, 1, $1, now() + interval '5 minutes', 3)`,
    [kind, sandbox, org],
  );
}

function claim(db: PGlite, kind: string, worker = owner, concurrency = 2) {
  return db.query<{ id: string; lease_epoch: number; attempts: number }>(
    "select id, lease_epoch, attempts from claim_job($1, $2, 60, $3)",
    [kind, worker, concurrency],
  );
}

function claimNext(db: PGlite, kinds: readonly string[], limits: readonly number[], worker = owner, leaseSeconds = 60) {
  return db.query<{ id: string; kind: string; lease_epoch: number; attempts: number }>(
    "select id, kind, lease_epoch, attempts from claim_next_job($1::text[], $2::integer[], $3, $4)",
    [kinds, limits, worker, leaseSeconds],
  );
}

function complete(db: PGlite, id: string, worker: string, epoch: number) {
  return db.query<{ complete_job: boolean }>("select complete_job($1, $2, $3, 1, 'done', '{}')", [id, worker, epoch]);
}

test("one lifecycle claim per sandbox, including across different job kinds", async () => {
  const db = database();
  const sandbox = await sandboxWithStop(db);
  await enqueue(db, sandbox, "delete");
  await db.exec("set role service_role");
  const stop = (await claim(db, "stop")).rows[0]!;
  expect(stop.lease_epoch).toBe(1);
  expect((await claim(db, "delete", successor)).rows).toEqual([]);
  expect((await complete(db, stop.id, owner, 1)).rows).toEqual([{ complete_job: true }]);
  expect((await claim(db, "delete", successor)).rows).toHaveLength(1);
});

test("takeover uses the same job and only the current epoch can complete it", async () => {
  const db = database();
  const sandbox = await sandboxWithStop(db);
  await enqueue(db, sandbox, "delete");
  const stop = (await claim(db, "stop")).rows[0]!;
  await db.query("update jobs set lease_until = '-infinity' where id = $1", [stop.id]);
  expect((await claim(db, "delete", successor)).rows).toEqual([]);
  expect((await claim(db, "stop")).rows).toEqual([{ id: stop.id, lease_epoch: 2, attempts: 2 }]);
  expect((await complete(db, stop.id, owner, 1)).rows).toEqual([{ complete_job: false }]);
  expect((await complete(db, stop.id, owner, 2)).rows).toEqual([{ complete_job: true }]);
});

test("renewal keeps the deadline and stops when the sandbox generation changes", async () => {
  const db = database();
  const sandbox = await sandboxWithStop(db);
  const stop = (await claim(db, "stop")).rows[0]!;
  const readLease = () =>
    db.query<{ deadline_at: string; lease_until: string }>("select deadline_at, lease_until from jobs where id = $1", [
      stop.id,
    ]);
  const before = await readLease();
  const renew = () => db.query("select renew_job($1, $2, 1, 1, 120)", [stop.id, owner]);
  expect((await renew()).rows).toEqual([{ renew_job: true }]);
  const after = await readLease();
  expect(after.rows[0]?.deadline_at).toEqual(before.rows[0]?.deadline_at);
  expect(after.rows[0]?.lease_until).not.toEqual(before.rows[0]?.lease_until);

  await db.query("update sandboxes set lifecycle_generation = 2 where id = $1", [sandbox]);
  expect((await renew()).rows).toEqual([{ renew_job: false }]);
  expect((await complete(db, stop.id, owner, 1)).rows).toEqual([{ complete_job: false }]);
});

test("the capacity ceiling holds across workers and retry cannot be claimed early", async () => {
  const db = database();
  await db.query(
    `insert into jobs (kind, org_id, idem_key, run_after, max_attempts)
     values ('webhook', $1, 'first', '-infinity', 2), ('webhook', $1, 'second', now(), 2)`,
    [org],
  );
  const first = (await db.query<{ id: string }>("select id from jobs where idem_key = 'first'")).rows[0]!;
  expect((await claim(db, "webhook", owner, 1)).rows[0]?.id).toBe(first.id);
  expect((await claim(db, "webhook", successor, 1)).rows).toEqual([]);
  expect(
    (await db.query("select complete_job($1, $2, 1, null, 'queued', '{}', 'infinity')", [first.id, owner])).rows,
  ).toEqual([{ complete_job: true }]);
  const second = (await claim(db, "webhook", successor, 1)).rows[0]!;
  expect(second.id).not.toBe(first.id);
  await db.query("select complete_job($1, $2, 1, null, 'done', '{}')", [second.id, successor]);
  expect((await claim(db, "webhook")).rows).toEqual([]);
});

test("claim_next_job respects kind priority order and per-kind concurrency limits in one query", async () => {
  const db = database();
  await db.query(
    `insert into jobs (kind, org_id, idem_key, run_after, max_attempts)
     values
       ('webhook', $1, 'webhook-1', now() - interval '2 seconds', 2),
       ('webhook', $1, 'webhook-2', now() - interval '1 second', 2),
       ('maintenance', $1, 'maint-1', now() - interval '3 seconds', 2),
       ('pr_scan', $1, 'scan-1', now(), 2)`,
    [org],
  );
  await db.exec("set role service_role");

  const first = (await claimNext(db, ["webhook", "maintenance", "pr_scan"], [1, 1, 1])).rows[0];
  expect(first).toMatchObject({ kind: "webhook", lease_epoch: 1, attempts: 1 });

  const second = (await claimNext(db, ["webhook", "maintenance", "pr_scan"], [1, 1, 1], successor)).rows[0];
  expect(second).toMatchObject({ kind: "maintenance", lease_epoch: 1, attempts: 1 });

  const third = (await claimNext(db, ["pr_scan", "webhook"], [1, 2], successor)).rows[0];
  expect(third).toMatchObject({ kind: "pr_scan", lease_epoch: 1, attempts: 1 });

  const fourth = (await claimNext(db, ["maintenance", "pr_scan", "webhook"], [1, 1, 2], successor)).rows[0];
  expect(fourth).toMatchObject({ kind: "webhook", lease_epoch: 1, attempts: 1 });
  expect((await claimNext(db, ["webhook", "maintenance", "pr_scan"], [2, 2, 2], successor)).rows).toEqual([]);
});

test("claim_next_job preserves sandbox lifecycle exclusivity and boat_runtime_extend lease semantics", async () => {
  const db = database();
  const sandbox = await sandboxWithStop(db);
  await enqueue(db, sandbox, "delete");
  await db.query(
    `insert into jobs (kind, sandbox_id, org_id, generation, idem_key, deadline_at, max_attempts)
     values ('boat_runtime_extend', $1, $2, 1, 'extend', now() + interval '5 seconds', 1)`,
    [sandbox, org],
  );
  await db.query("update sandboxes set activity_until = now() + interval '1 minute' where id = $1", [sandbox]);
  await db.query(
    `insert into jobs (kind, org_id, idem_key, max_attempts)
     values ('webhook', $1, 'fallback-webhook', 1)`,
    [org],
  );

  const claimedStop = (await claimNext(db, ["boat_runtime_extend", "stop", "delete", "webhook"], [1, 1, 1, 1]))
    .rows[0]!;
  expect(claimedStop).toMatchObject({ kind: "stop", lease_epoch: 1, attempts: 1 });

  const claimedWebhook = (await claimNext(db, ["delete", "boat_runtime_extend", "webhook"], [1, 1, 1], successor))
    .rows[0]!;
  expect(claimedWebhook).toMatchObject({ kind: "webhook", lease_epoch: 1, attempts: 1 });

  expect((await complete(db, claimedStop.id, owner, 1)).rows).toEqual([{ complete_job: true }]);
  await db.query("update sandboxes set activity_until = null where id = $1", [sandbox]);
  const claimedExtend = (await claimNext(db, ["boat_runtime_extend"], [1], successor, 600)).rows[0]!;
  expect(claimedExtend).toMatchObject({ kind: "boat_runtime_extend", lease_epoch: 1, attempts: 1 });
  const { rows: leaseCheck } = await db.query<{ capped: boolean }>(
    "select lease_until = deadline_at as capped from jobs where id = $1",
    [claimedExtend.id],
  );
  expect(leaseCheck).toEqual([{ capped: true }]);
});

test("claim_next_job validates parameters and accepts empty kind arrays", async () => {
  const db = database();
  expect((await claimNext(db, [], [])).rows).toEqual([]);
  await expect(claimNext(db, ["stop"], [1, 2])).rejects.toThrow("invalid job claim parameters");
  await expect(claimNext(db, ["stop"], [0])).rejects.toThrow("invalid job claim parameters");
  await expect(claimNext(db, [""], [1])).rejects.toThrow("invalid job claim parameters");
  await expect(claimNext(db, ["stop"], [1], owner, 0)).rejects.toThrow("invalid job claim parameters");
});

test.each(["anon", "authenticated"] as const)("%s cannot read jobs or execute the queue functions", async (role) => {
  const db = database();
  await db.exec(`set role ${role}`);
  await expect(db.query("select * from public.jobs")).rejects.toThrow("permission denied for table jobs");
  await expect(claim(db, "stop")).rejects.toThrow("permission denied for function claim_job");
  await expect(claimNext(db, ["stop"], [1])).rejects.toThrow("permission denied for function claim_next_job");
  await expect(db.query("select public.renew_job($1, $2, 1, 1, 60)", [org, owner])).rejects.toThrow(
    "permission denied for function renew_job",
  );
  await expect(complete(db, org, owner, 1)).rejects.toThrow("permission denied for function complete_job");
});
