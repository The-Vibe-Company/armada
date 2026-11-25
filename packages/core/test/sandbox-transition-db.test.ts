import { expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { migratedDatabase } from "./support/database.ts";

const database = migratedDatabase();
const org = crypto.randomUUID();
const owner = crypto.randomUUID();
const golden = crypto.randomUUID();
const sandbox = crypto.randomUUID();

const resume = {
  kind: "resume",
  idem_key: "wake_turn",
  max_attempts: 3,
  deadline_at: "2099-01-01T00:00:00Z",
};

async function seedSandbox(db: PGlite, status: string, reason: string | null = null) {
  await db.query("insert into auth.users(id) values ($1)", [owner]);
  await db.query("insert into orgs(id, name) values ($1, 'Transitions')", [org]);
  await db.query(
    "insert into goldens(id, org_id, name, boat_snapshot_id, visibility, owner_id) values ($1, $2, 'fixture', 'snapshot', 'org', $3)",
    [golden, org, owner],
  );
  await db.query(
    `insert into sandboxes (id, boat_id, golden_id, org_id, owner_id, harness, status, status_reason, stopped_at)
     values ($1, 'machine', $2, $3, $4, 'codex', $5::sandbox_status, $6, case when $5::sandbox_status = 'stopped' then now() end)`,
    [sandbox, golden, org, owner, status, reason],
  );
  await db.exec("set role service_role");
}

function transition(
  db: PGlite,
  from: string[],
  to: string,
  actor: string,
  effects: object[],
  options: { id?: string; generation?: number; code?: string } = {},
) {
  return db.query("select * from public.sandbox_transition($1, $2, $3, $4, $5, $6, $7)", [
    options.id ?? sandbox,
    options.generation ?? 1,
    from,
    to,
    actor,
    options.code ?? "test_transition",
    JSON.stringify(effects),
  ]);
}

function history(db: PGlite) {
  return db.query("select from_status, to_status, actor, code, generation from sandbox_transitions order by id");
}

function feed(db: PGlite) {
  return db.query<{ id: string; kind: string; ref: string; sequence: string | null }>(
    "select id::text, kind, ref::text, sequence::text from event_log order by event_log.id",
  );
}

function ingest(db: Pick<PGlite, "query">) {
  return db.query(
    `insert into runtime_events (sandbox_id, sequence, epoch, event_enc)
     values ($1, 1, 1, decode('01','hex')), ($1, 2, 1, decode('02','hex'))
     on conflict (sandbox_id, sequence) do nothing`,
    [sandbox],
  );
}

test("committed transition and runtime references share one increasing org cursor", async () => {
  const db = database();
  await seedSandbox(db, "starting");
  const notified: string[] = [];
  const unlisten = await db.listen("armada_events", (payload) => notified.push(payload));

  await transition(db, ["starting"], "running", "runtime_enrolment", []);
  await db.transaction(async (tx) => {
    await ingest(tx);
    expect((await tx.query("select id from event_log where kind = 'runtime_event'")).rows).toEqual([]);
  });
  await ingest(db);
  await unlisten();

  const journal = await db.query<{ id: string }>("select id::text from sandbox_transitions");
  const rows = (await feed(db)).rows;
  expect(rows.map(({ kind, ref, sequence }) => ({ kind, ref, sequence }))).toEqual([
    { kind: "transition", ref: journal.rows[0]!.id, sequence: null },
    { kind: "runtime_event", ref: "1", sequence: "1" },
    { kind: "runtime_event", ref: "2", sequence: "2" },
  ]);
  expect(BigInt(rows[0]!.id)).toBeLessThan(BigInt(rows[1]!.id));
  expect(BigInt(rows[1]!.id)).toBeLessThan(BigInt(rows[2]!.id));
  expect(notified).toEqual([sandbox, sandbox]);
  expect((await db.query("select distinct org_id, sandbox_id from event_log")).rows).toEqual([
    { org_id: org, sandbox_id: sandbox },
  ]);
});

test("rolling back an ingest removes the archive and its feed references", async () => {
  const db = database();
  await seedSandbox(db, "running");
  const notified: string[] = [];
  const unlisten = await db.listen("armada_events", (payload) => notified.push(payload));
  await expect(
    db.transaction(async (tx) => {
      await tx.query(
        "insert into runtime_events (sandbox_id, sequence, epoch, event_enc) values ($1, 1, 1, decode('01','hex'))",
        [sandbox],
      );
      throw new Error("projection failed");
    }),
  ).rejects.toThrow("projection failed");
  await unlisten();
  expect(notified).toEqual([]);
  expect((await db.query("select sequence from runtime_events")).rows).toEqual([]);
  expect((await feed(db)).rows).toEqual([]);
});

test("physical sandbox deletion expires the feed with the runtime archive", async () => {
  const db = database();
  await seedSandbox(db, "running");
  await ingest(db);
  expect((await feed(db)).rows).toHaveLength(2);
  await db.exec("reset role");
  await db.transaction(async (tx) => {
    await tx.query(
      "insert into runtime_events (sandbox_id, sequence, epoch, event_enc) values ($1, 3, 1, decode('03','hex'))",
      [sandbox],
    );
    await tx.query("delete from sandboxes where id = $1", [sandbox]);
  });
  expect((await db.query("select sequence from runtime_events")).rows).toEqual([]);
  expect((await feed(db)).rows).toEqual([]);
});

test.each(["anon", "authenticated"])("%s cannot read the event feed", async (role) => {
  const db = database();
  await seedSandbox(db, "running");
  await ingest(db);
  await db.exec(`set role ${role}`);
  await expect(feed(db)).rejects.toThrow("permission denied for table event_log");
});

test("resume journals one edge and enqueues against the new generation", async () => {
  const db = database();
  await seedSandbox(db, "stopped", "idle_paused");
  expect((await transition(db, ["stopped"], "starting", "resume_admission", [resume])).rows).toEqual([
    { applied: true, generation: 2 },
  ]);
  expect((await history(db)).rows).toEqual([
    {
      from_status: "stopped",
      to_status: "starting",
      actor: "resume_admission",
      code: "test_transition",
      generation: 2,
    },
  ]);
  expect((await db.query("select status, status_reason, lifecycle_generation from sandboxes")).rows).toEqual([
    { status: "starting", status_reason: null, lifecycle_generation: 2 },
  ]);
  expect((await db.query("select kind, sandbox_id, org_id, generation, idem_key from jobs")).rows).toEqual([
    {
      kind: "resume",
      sandbox_id: sandbox,
      org_id: org,
      generation: 2,
      idem_key: JSON.stringify(["internal", org, "resume", sandbox, 2, "wake_turn"]),
    },
  ]);
});

test("a missing row, wrong status, or stale generation returns conflict without writes", async () => {
  const db = database();
  await seedSandbox(db, "stopped");
  for (const [from, options] of [
    [["stopped"], { id: crypto.randomUUID() }],
    [["failed"], {}],
    [["stopped"], { generation: 2 }],
  ] as const) {
    expect((await transition(db, [...from], "starting", "resume_admission", [resume], options)).rows).toEqual([
      { applied: false, generation: null },
    ]);
  }
  expect((await db.query("select status, lifecycle_generation from sandboxes")).rows).toEqual([
    { status: "stopped", lifecycle_generation: 1 },
  ]);
  expect((await history(db)).rows).toEqual([]);
  expect((await db.query("select id from jobs")).rows).toEqual([]);
});

test("a bad second effect rolls back the status, journal, and first job", async () => {
  const db = database();
  await seedSandbox(db, "stopping");
  await expect(
    transition(db, ["stopping"], "stopped", "lifecycle_runner", [
      { ...resume, kind: "output_publication" },
      { ...resume, kind: "resume" },
    ]),
  ).rejects.toThrow("invalid sandbox transition effect");
  expect((await db.query("select status, stopped_at from sandboxes")).rows).toEqual([
    { status: "stopping", stopped_at: null },
  ]);
  expect((await history(db)).rows).toEqual([]);
  expect((await feed(db)).rows).toEqual([]);
  expect((await db.query("select id from jobs")).rows).toEqual([]);
});

test("rejects an unauthorized actor, illegal edge, same-state update, and unsafe code", async () => {
  const db = database();
  await seedSandbox(db, "starting");
  await expect(transition(db, ["starting"], "running", "owner", [])).rejects.toThrow("invalid sandbox transition");
  await expect(transition(db, ["starting"], "stopped", "lifecycle_runner", [])).rejects.toThrow(
    "invalid sandbox transition",
  );
  await expect(transition(db, ["starting"], "starting", "resume_admission", [resume])).rejects.toThrow(
    "invalid sandbox transition",
  );
  await expect(
    transition(db, ["starting"], "running", "runtime_enrolment", [], { code: "unsanitized text" }),
  ).rejects.toThrow("invalid sandbox transition");
});

test("existing same-generation stop intent is reused and the transition is journaled", async () => {
  const db = database();
  await seedSandbox(db, "running");
  const key = JSON.stringify(["internal", org, "stop", sandbox, 1, "wake_turn"]);
  await db.query(
    "insert into jobs(kind, sandbox_id, org_id, generation, idem_key, max_attempts, deadline_at) values ('stop', $1, $2, 1, $3, 3, $4)",
    [sandbox, org, key, resume.deadline_at],
  );
  expect(
    (
      await transition(db, ["starting", "running"], "stopping", "idle", [{ ...resume, kind: "stop" }], {
        code: "idle_paused",
      })
    ).rows,
  ).toEqual([{ applied: true, generation: 1 }]);
  expect((await history(db)).rows).toEqual([
    { from_status: "running", to_status: "stopping", actor: "idle", code: "idle_paused", generation: 1 },
  ]);
  expect((await db.query("select idem_key from jobs")).rows).toEqual([{ idem_key: key }]);
  expect((await db.query("select status_reason from sandboxes")).rows).toEqual([{ status_reason: "idle_paused" }]);
});

test("stop requires exactly one intent, including a handoff of an existing job", async () => {
  const db = database();
  await seedSandbox(db, "running");
  const stop = { ...resume, kind: "stop" };
  for (const effects of [[], [stop, { ...stop, idem_key: "second_stop" }]]) {
    await expect(transition(db, ["running"], "stopping", "owner", effects)).rejects.toThrow(
      "sandbox transition requires one lifecycle job",
    );
  }
  expect((await db.query("select status from sandboxes")).rows).toEqual([{ status: "running" }]);
});

test("a failed sandbox can be deleted only after reconciliation records physical exit", async () => {
  const db = database();
  await seedSandbox(db, "failed", "runtime_failure");
  const deleteSandbox = () => transition(db, ["failed"], "deleted", "retention_job", [], { code: "retention_elapsed" });
  await expect(deleteSandbox()).rejects.toThrow("failed sandbox exit is unconfirmed");
  expect((await history(db)).rows).toEqual([]);
  await db.query("update sandboxes set stopped_at = now() where id = $1 and lifecycle_generation = 1", [sandbox]);
  expect((await deleteSandbox()).rows).toEqual([{ applied: true, generation: 1 }]);
  expect((await db.query("select status, status_reason from sandboxes")).rows).toEqual([
    { status: "deleted", status_reason: "retention_elapsed" },
  ]);
});

test.each(["anon", "authenticated"])("%s cannot execute the transition", async (role) => {
  const db = database();
  await db.exec(`set role ${role}`);
  await expect(transition(db, ["stopped"], "starting", "resume_admission", [resume])).rejects.toThrow(
    "permission denied for function sandbox_transition",
  );
});
