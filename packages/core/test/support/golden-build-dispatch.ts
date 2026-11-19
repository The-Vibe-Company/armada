import type { GoldenBuildJobs } from "../../src/golden-build-jobs.ts";
import type { Sql } from "../../src/golden-store.ts";

export async function dispatchGoldenBuild(sql: Sql, builds: GoldenBuildJobs) {
  await builds.expireRunningReceipts();
  const owner = crypto.randomUUID();
  const { rows } = await sql.query<{ id: string; epoch: string }>(
    "select id, lease_epoch::text as epoch from public.claim_job('golden_build',$1,30,1)",
    [owner],
  );
  const job = rows[0];
  if (!job) return false;
  const result = await builds.dispatchReceipt(job.id, job.epoch);
  await sql.query("select public.complete_job($1,$2,$3,null,$4,null,$5)", [
    job.id,
    owner,
    job.epoch,
    result.pending ? "queued" : "done",
    result.pending ? new Date(Date.now() + 60_000).toISOString() : null,
  ]);
  return result.processed;
}
