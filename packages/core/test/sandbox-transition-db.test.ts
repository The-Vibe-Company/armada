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
     values ($1, 'machine', $2, $3, $4, 'codex', $5, $6, case when $5 = 'stopped' then now() end)`,
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
    (await transition(db, ["starting", "running"], "stopping", "owner", [{ ...resume, kind: "stop" }])).rows,
  ).toEqual([{ applied: true, generation: 1 }]);
  expect((await history(db)).rows).toEqual([
    { from_status: "running", to_status: "stopping", actor: "owner", code: "test_transition", generation: 1 },
  ]);
  expect((await db.query("select idem_key from jobs")).rows).toEqual([{ idem_key: key }]);
});

test.each(["anon", "authenticated"])("%s cannot execute the transition", async (role) => {
  const db = database();
  await db.exec(`set role ${role}`);
  await expect(transition(db, ["stopped"], "starting", "resume_admission", [resume])).rejects.toThrow(
    "permission denied for function sandbox_transition",
  );
});
