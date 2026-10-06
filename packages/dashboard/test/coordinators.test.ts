import { afterAll, beforeAll, expect, test } from "bun:test";
import { serveFleet } from "@armada/core/read";
import { type Database, DB_MIGRATIONS, migrateDatabase, pgliteDatabase } from "../lib/db.ts";
import {
  fleetStore,
  getRuntimeHandle,
  listCoordinators,
  listSessions,
  pendingLaunches,
  recordCoordinatorSeen,
  transferTickets,
  upsertProject,
} from "../lib/fleet-store.ts";
import { createLaunch } from "../lib/workers.ts";
import { addOrganizations, tempDatabase } from "./support.ts";

const project = { slug: "named", name: "Widgets", repository: "acme/widgets", programRoot: "WID-1" };
const at = (minutes: number) => new Date(Date.parse("2026-03-04T10:00:00Z") + minutes * 60_000);
let db: Database;
beforeAll(async () => {
  db = await tempDatabase();
  await addOrganizations(db, "org-named");
  await upsertProject(db, project, at(0));
  await db.query("UPDATE projects SET organization_id = $2 WHERE slug = $1", [project.slug, "org-named"]);
});
afterAll(() => db.end());

test("migration preserves legacy presence under default and leaves old claims unowned", async () => {
  const legacy = await pgliteDatabase();
  try {
    const migration = DB_MIGRATIONS.find((entry) =>
      entry.statements.some((sql) => sql.includes("CREATE TABLE coordinators (")),
    );
    if (!migration) throw new Error("missing coordinator migration");
    for (const entry of DB_MIGRATIONS.filter((entry) => entry.version < migration.version))
      for (const statement of entry.statements) await legacy.query(statement);
    await legacy.query("CREATE TABLE armada_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL)");
    for (const entry of DB_MIGRATIONS.filter((entry) => entry.version < migration.version))
      await legacy.query("INSERT INTO armada_migrations VALUES ($1, $2)", [entry.version, at(0)]);
    await upsertProject(legacy, project, at(0));
    await legacy.query(
      "INSERT INTO coordinator_presence (project, handle, started_at, seen_at, inbox_seen_at, harness, model, cli_version) VALUES ($1, 'machine/tty', $2, $3, $3, 'codex', 'synthetic-model', '0.1.0')",
      [project.slug, at(0), at(1)],
    );
    await legacy.query(
      "INSERT INTO runtime_handles (project, ticket, runtime, handle, claimed_at) VALUES ($1, 'WID-2', 'conductor', 'workspace/session', $2)",
      [project.slug, at(0)],
    );
    await migrateDatabase(legacy, at(2));
    expect(await listCoordinators(legacy, project.slug)).toMatchObject([
      {
        name: "default",
        handle: "machine/tty",
        seenAt: at(1).toISOString(),
        sessions: [{ handle: "machine/tty" }],
        tickets: [],
      },
    ]);
    expect((await getRuntimeHandle(legacy, project.slug, "WID-2"))?.coordinator).toBeNull();
    expect(
      (await legacy.query("SELECT handle FROM coordinator_presence WHERE project = $1", [project.slug])).rows[0]
        ?.handle,
    ).toBe("machine/tty");
    await migrateDatabase(legacy, at(3));
  } finally {
    await legacy.end();
  }
});

test("presence retains different named roles and multiple sessions in one role", async () => {
  for (const [name, handle, minute] of [
    ["default", "machine/tty", 0],
    ["front", "workspace/a", 1],
    ["front", "workspace/b", 2],
  ] as const)
    await recordCoordinatorSeen(db, {
      project: project.slug,
      name,
      facts: { harness: "conductor-cloud", handle, model: "synthetic-model", cliVersion: "0.1.0" },
      at: at(minute),
    });
  const roles = await listCoordinators(db, project.slug);
  expect(roles.map((role) => role.name)).toEqual(["default", "front"]);
  expect(roles.find((role) => role.name === "front")?.sessions.map((session) => session.handle)).toEqual([
    "workspace/b",
    "workspace/a",
  ]);
  expect(
    (await db.query("SELECT handle FROM coordinator_presence WHERE project = $1", [project.slug])).rows[0]?.handle,
  ).toBe("machine/tty");
});

test("authenticated launches own claims; guarded handover preserves phase and survives a stale resume", async () => {
  const store = fleetStore(db);
  const launcher = { kind: "session" as const, id: "synthetic-person", label: "Ada Example" };
  const active = await createLaunch(db, {
    organization: "org-named",
    project: project.slug,
    ticket: "WID-4",
    coordinator: "front",
    launcher,
    now: at(3),
  });
  const pending = await createLaunch(db, {
    organization: "org-named",
    project: project.slug,
    ticket: "WID-5",
    coordinator: "front",
    launcher,
    now: at(3),
  });
  const claim = {
    ticket: "WID-4",
    runtime: "conductor",
    handle: "workspace/worker",
    branch: null,
    phase: "planning",
    resuming: false,
    profile: null,
    coordinatorName: "spoof",
  };
  const caller = { kind: "worker" as const, ticket: "WID-4", sessionId: active.worker.id, coordinator: "front" };
  expect((await serveFleet(store, { op: "claim", project, caller, input: claim }, { now: () => at(4) })).status).toBe(
    200,
  );
  expect((await getRuntimeHandle(db, project.slug, "WID-4"))?.coordinator).toBe("front");
  expect(
    await transferTickets(db, {
      project: project.slug,
      tickets: ["WID-4", "WID-5"],
      from: "wrong",
      to: "back",
      at: at(5),
    }),
  ).toBe(false);
  expect(await transferTickets(db, { project: project.slug, tickets: ["WID-4"], to: "back", at: at(5) })).toBe(false);
  expect(
    await transferTickets(db, {
      project: project.slug,
      tickets: ["WID-4", "WID-999"],
      from: "front",
      to: "back",
      at: at(5),
    }),
  ).toBe(false);
  expect((await getRuntimeHandle(db, project.slug, "WID-4"))?.coordinator).toBe("front");
  const results = await Promise.all(
    ["back", "other"].map((to) =>
      transferTickets(db, { project: project.slug, tickets: ["WID-4", "WID-5"], from: "front", to, at: at(6) }),
    ),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  const owner = (await getRuntimeHandle(db, project.slug, "WID-4"))?.coordinator;
  expect(
    (await pendingLaunches(db, project.slug, at(0))).find((launch) => launch.ticket === "WID-5")?.coordinator,
  ).toBe(owner);
  expect(
    (await db.query('SELECT "coordinator" FROM "armada_worker" WHERE "id" = $1', [pending.worker.id])).rows[0]
      ?.coordinator,
  ).toBe(owner);
  // A request authenticated before the transfer must not overwrite its newer ownership.
  await serveFleet(store, { op: "claim", project, caller, input: { ...claim, resuming: true } }, { now: () => at(7) });
  expect((await getRuntimeHandle(db, project.slug, "WID-4"))?.coordinator).toBe(owner);
  expect(
    (await listSessions(db, project.slug, { since: at(0) })).find((session) => session.ticket === "WID-4")?.coordinator,
  ).toBe(owner);
  expect((await store.latestEvents(project.slug))["WID-4"]).toMatchObject({ kind: "claim", phase: "planning" });
  expect(
    (await db.query("SELECT ticket FROM events WHERE project = $1 AND kind = 'handover'", [project.slug])).rows,
  ).toHaveLength(2);
});

test("first claim reads the pending handover owner after acquiring the project lock", async () => {
  const launch = await createLaunch(db, {
    organization: "org-named",
    project: project.slug,
    ticket: "WID-6",
    coordinator: "front",
    launcher: { kind: "session", id: "synthetic-person", label: "Ada Example" },
    now: at(8),
  });
  expect(
    await transferTickets(db, { project: project.slug, tickets: ["WID-6"], from: "front", to: "back", at: at(9) }),
  ).toBe(true);
  const statements: string[] = [];
  const traced: Database = {
    query: db.query.bind(db),
    end: db.end.bind(db),
    connect: async () => {
      const connection = await db.connect();
      return {
        release: connection.release.bind(connection),
        query: async (sql, params) => {
          statements.push(sql);
          return connection.query(sql, params);
        },
      };
    },
  };
  const result = await serveFleet(
    fleetStore(traced),
    {
      op: "claim",
      project,
      caller: { kind: "worker", ticket: "WID-6", sessionId: launch.worker.id, coordinator: "front" },
      input: {
        ticket: "WID-6",
        runtime: "conductor",
        handle: "workspace/first-claim",
        branch: null,
        phase: "planning",
        resuming: false,
        profile: null,
      },
    },
    { now: () => at(10) },
  );
  expect(result.status).toBe(200);
  expect((await getRuntimeHandle(db, project.slug, "WID-6"))?.coordinator).toBe("back");
  // PostgreSQL gives each statement its own read-committed snapshot: the owner
  // lookup must start after the lock wait, rather than sharing its snapshot.
  const lock = statements.findIndex((sql) => sql === "SELECT slug FROM projects WHERE slug = $1 FOR UPDATE");
  const write = statements.findIndex((sql) => sql.includes("INSERT INTO runtime_handles"));
  expect(lock).toBeGreaterThan(0);
  expect(write).toBeGreaterThan(lock);
  // Session revalidation may run between the lock and claim write, inside this transaction.
  expect(statements.slice(lock, write)).not.toContain("COMMIT");
  const begin = statements.lastIndexOf("BEGIN", lock);
  const commit = statements.indexOf("COMMIT", write);
  const owner = statements.findIndex((sql) => sql.includes('SELECT "coordinator" FROM "armada_worker"'));
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(owner).toBeGreaterThan(lock);
  expect(write).toBeGreaterThanOrEqual(owner);
  expect(commit).toBeGreaterThan(write);
});
