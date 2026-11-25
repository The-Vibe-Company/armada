import type { Provider, Sql } from "@armada/core/server";
import { createStopJob } from "../src/jobs/stop.ts";
import { createJobsStore } from "../src/jobs/store.ts";
import { ENCRYPTION_KEY } from "./support.ts";

export async function runClaimedStop(sql: Sql, provider: () => Promise<Provider>, settle = true) {
  const jobs = createJobsStore(sql, ENCRYPTION_KEY);
  const owner = crypto.randomUUID();
  const job = await jobs.claim("stop", owner, 30, 8);
  if (!job) throw new Error("No stop job was admitted.");
  const result = await createStopJob(sql, ENCRYPTION_KEY, undefined, Date.now, provider).run(job, {
    signal: new AbortController().signal,
    canDispatch: async (tx) => (await jobs.inspect(job, owner, tx)) === "dispatch",
    handoffGeneration: (handoff) => jobs.handoffGeneration(job, owner, handoff),
  });
  if (settle && !(await jobs.complete(job, owner, result))) throw new Error("Stop job could not settle.");
  return { job, result };
}
