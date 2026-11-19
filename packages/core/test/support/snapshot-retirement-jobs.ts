import { createJobsStore } from "../../../mcp-server/src/jobs/store.ts";
import type { GoldenSnapshotRetirements } from "../../src/golden-snapshot-retirement.ts";
import type { Sql } from "../../src/golden-store.ts";

export async function runRetirementJob(sql: Sql, retirement: GoldenSnapshotRetirements, now = Date.now) {
  const store = createJobsStore(sql);
  const owner = crypto.randomUUID();
  const job = await store.claim("snapshot_retirement", owner, 30, 4);
  if (!job) return false;
  const result = await retirement.runJob(
    job.id,
    {
      signal: new AbortController().signal,
      canDispatch: async (tx) => (await store.inspect(job, owner, tx)) === "dispatch",
    },
    now,
  );
  await store.complete(job, owner, result);
  return true;
}
