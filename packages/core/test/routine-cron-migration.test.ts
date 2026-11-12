import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { migrationsDir, openDatabase } from "../../../scripts/db/apply.ts";

// Owns the deployed interval -> cron data upgrade, not fresh-schema behavior or
// parser internals. These persisted rows predate the new columns and migration.
test("cron migration preserves UTC phase, paused state, unsupported intervals and historical occurrence keys", async () => {
  const db = await openDatabase();
  const migration = "20261112073106_routine_cron_schedule.sql";
  try {
    await db.exec(await Bun.file(join(migrationsDir, "../../scripts/db/supabase-prereq.sql")).text());
    for (const filename of readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql") && file < migration)
      .sort())
      await db.exec(await Bun.file(join(migrationsDir, filename)).text());
    const owner = crypto.randomUUID(),
      org = crypto.randomUUID(),
      template = crypto.randomUUID();
    await db.query("insert into auth.users(id) values($1)", [owner]);
    await db.query("insert into orgs(id,name) values($1,'cron upgrade')", [org]);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [org, owner]);
    await db.query(
      "insert into launch_templates(id,org_id,owner_id,scope,name) values($1,$2,$3,'personal','upgrade template')",
      [template, org, owner],
    );
    await db.query(
      "insert into launch_template_revisions(template_id,revision,definition,digest,created_by) values($1,1,'{}',repeat('a',64),$2)",
      [template, owner],
    );
    const converted = [
      { name: "hourly", hours: 1, due: "2030-01-06T23:59:59.123Z", cron: "0 * * * *", next: "2030-01-07T00:00:00Z" },
      { name: "daily", hours: 24, due: "2030-01-06T17:17:00Z", cron: "17 17 * * *", next: "2030-01-06T17:17:00Z" },
      { name: "divisor", hours: 8, due: "2030-01-06T17:17:03Z", cron: "18 1-23/8 * * *", next: "2030-01-06T17:18:00Z" },
      { name: "weekly", hours: 168, due: "2030-01-06T23:59:59.123Z", cron: "0 0 * * 1", next: "2030-01-07T00:00:00Z" },
      { name: "paused", hours: 12, due: null, cron: "10 8-23/12 * * *", next: null },
    ];
    const ids = new Map<string, string>();
    for (const row of [
      ...converted,
      ...[7, 25, 48].map((hours) => ({ name: `legacy-${hours}`, hours, due: "2030-01-06T17:17:03.321Z" })),
    ]) {
      const id = crypto.randomUUID();
      ids.set(row.name, id);
      await db.query(
        `insert into routines(id,org_id,owner_id,scope,name,template_id,template_revision,prompt,interval_hours,max_runs_per_day,ttl_seconds,status,version,next_due_at,created_at,updated_at)
        values($1,$2,$3,'personal',$4,$5,1,'Keep the exact prompt', $6,24,3600,$7,4,$8,'2030-01-05T20:09:30Z','2026-01-01T00:00:00Z')`,
        [id, org, owner, row.name, template, row.hours, row.name === "paused" ? "paused" : "enabled", row.due],
      );
    }
    const run = crypto.randomUUID(),
      requestKey = "routine:before-cron:2030-01-06T22:59:59.123Z";
    await db.query(
      `insert into routine_runs(id,routine_id,org_id,owner_id,scheduled_due_at,configuration_version,state,reason,request_key,missed_intervals)
      values($1,$2,$3,$4,'2030-01-06T22:59:59.123Z',4,'skipped','previous_run_alive',$5,2)`,
      [run, ids.get("hourly"), org, owner, requestKey],
    );
    const historyBefore = (
      await db.query(
        "select id,routine_id,scheduled_due_at,configuration_version,state,reason,request_key,missed_intervals from routine_runs",
      )
    ).rows;
    const fallbackBefore = (
      await db.query(
        "select id,interval_hours,status,version,next_due_at,updated_at from routines where interval_hours in (7,25,48) order by interval_hours",
      )
    ).rows;

    await db.exec(await Bun.file(join(migrationsDir, migration)).text());

    for (const row of converted) {
      expect(
        (
          await db.query("select cron,timezone,status,version,next_due_at from routines where id=$1", [
            ids.get(row.name),
          ])
        ).rows,
      ).toEqual([
        {
          cron: row.cron,
          timezone: "UTC",
          status: row.name === "paused" ? "paused" : "enabled",
          version: 5,
          next_due_at: row.next ? new Date(row.next) : null,
        },
      ]);
    }
    expect(
      (
        await db.query(
          "select id,interval_hours,status,version,next_due_at,updated_at from routines where interval_hours in (7,25,48) order by interval_hours",
        )
      ).rows,
    ).toEqual(fallbackBefore);
    expect((await db.query("select cron,timezone from routines where interval_hours in (7,25,48)")).rows).toEqual(
      Array.from({ length: 3 }, () => ({ cron: null, timezone: "UTC" })),
    );
    expect(
      (
        await db.query(
          "select id,routine_id,scheduled_due_at,configuration_version,state,reason,request_key,missed_intervals from routine_runs",
        )
      ).rows,
    ).toEqual(historyBefore);
    expect((await db.query("select missed_count_capped from routine_runs where id=$1", [run])).rows).toEqual([
      { missed_count_capped: false },
    ]);
  } finally {
    await db.close();
  }
});
