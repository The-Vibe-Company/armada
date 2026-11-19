import { expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { migratedDatabase } from "./support/database.ts";

const database = migratedDatabase();
const migration = new URL(
  "../../../supabase/migrations/20261119174837_golden_build_job_admission.sql",
  import.meta.url,
);
const org = "00000000-0000-4000-8000-000000000001";
const owner = "00000000-0000-4000-8000-000000000002";
const queued = "00000000-0000-4000-8000-000000000003";
const running = "00000000-0000-4000-8000-000000000004";
const recovering = "00000000-0000-4000-8000-000000000005";
const failed = "00000000-0000-4000-8000-000000000006";

async function seed(db: PGlite) {
  await db.query("insert into auth.users(id) values ($1)", [owner]);
  await db.query("insert into public.orgs(id, name) values ($1, 'Golden builds')", [org]);
}

const admit = `
  insert into public.golden_build_jobs
    (id, org_id, owner_id, name, visibility, idempotency_key, request_hash, payload_enc, provider)
  values ($1, $2, $3, 'fixture', 'org', $1::uuid::text, 'digest', 'sealed'::bytea, 'modal')`;

test("a golden build receipt and its shared job commit or roll back together", async () => {
  const db = database();
  await seed(db);
  await db.exec("set role service_role");
  const rollback = new Error("rollback admission");
  await expect(
    db.transaction(async (tx) => {
      await tx.query(admit, [queued, org, owner]);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect((await db.query("select id from public.golden_build_jobs")).rows).toEqual([]);
  expect((await db.query("select id from public.jobs")).rows).toEqual([]);

  await db.query(admit, [queued, org, owner]);
  await db.query(`${admit} on conflict (owner_id, org_id, idempotency_key) do nothing`, [queued, org, owner]);
  expect(
    (
      await db.query(`select id, kind, org_id, idem_key, state, sandbox_id, generation, payload_enc, max_attempts, deadline_at
                      from public.jobs`)
    ).rows,
  ).toEqual([
    {
      id: queued,
      kind: "golden_build",
      org_id: org,
      idem_key: JSON.stringify(["internal", org, "golden_build", null, null, queued]),
      state: "queued",
      sandbox_id: null,
      generation: null,
      payload_enc: null,
      max_attempts: 1,
      deadline_at: null,
    },
  ]);
});

test("golden build backfill enqueues each outstanding receipt and skips terminal receipts", async () => {
  const db = database();
  await seed(db);
  const checked = new Error("restore migration fixture");
  await expect(
    db.transaction(async (tx) => {
      await tx.exec(`
        drop trigger golden_build_job_on_admission on public.golden_build_jobs;
        drop function public.enqueue_golden_build_job();
      `);
      for (const id of [queued, running, recovering, failed]) {
        await tx.query(admit, [id, org, owner]);
      }
      await tx.query(
        `update public.golden_build_jobs
         set state = 'running', phase = 'builder', fence = id, lease_until = 'infinity', deadline = 'infinity'
         where id = $1`,
        [running],
      );
      await tx.query(
        "update public.golden_build_jobs set state = 'recovery_required', error_code = 'build_failed' where id = $1",
        [recovering],
      );
      await tx.query(
        "update public.golden_build_jobs set state = 'failed', error_code = 'build_failed' where id = $1",
        [failed],
      );
      await tx.exec(await Bun.file(migration).text());
      expect((await tx.query("select id, max_attempts, deadline_at from public.jobs order by id")).rows).toEqual([
        { id: queued, max_attempts: 1, deadline_at: null },
        { id: running, max_attempts: 1, deadline_at: null },
        { id: recovering, max_attempts: 1, deadline_at: null },
      ]);
      throw checked;
    }),
  ).rejects.toBe(checked);
});
