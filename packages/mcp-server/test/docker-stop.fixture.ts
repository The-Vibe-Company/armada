import { randomUUID } from "node:crypto";
import type { Sql } from "@armada/core";
import type { createDockerHostStore } from "../src/docker-host-store.ts";
import { createStopJob } from "../src/jobs/stop.ts";
import { createJobsStore } from "../src/jobs/store.ts";

export async function runDockerStop(sql: Sql, key: string, sandboxId: string, completionSql = sql) {
  await sql.query(
    "update jobs set run_after='-infinity' where sandbox_id=$1 and kind='stop' and state in ('queued','leased')",
    [sandboxId],
  );
  const jobs = createJobsStore(sql, key);
  const owner = randomUUID();
  const job = await jobs.claim("stop", owner, 30, 8);
  if (job?.sandbox_id !== sandboxId) throw new Error("No Docker stop job to run for this sandbox.");
  const handler = createStopJob(sql, key, () => ({}));
  const result = await handler.run(job, {
    signal: new AbortController().signal,
    canDispatch: async (tx) => (await jobs.inspect(job, owner, tx)) === "dispatch",
    handoffGeneration: (handoff) => jobs.handoffGeneration(job, owner, handoff),
  });
  if (!(await createJobsStore(completionSql, key).complete(job, owner, result)))
    throw new Error("Docker stop lost its claim.");
  if (result.status === "retry")
    await sql.query("update public.jobs set run_after=clock_timestamp() where id=$1", [job.id]);
  return result;
}

export async function reportDockerExpiry(
  sql: Sql,
  key: string,
  hosts: ReturnType<typeof createDockerHostStore>,
  hostToken: string,
  installationId: string,
  report: { requestId: string },
  completionSql = sql,
) {
  if ((await hosts.expired(hostToken, installationId, report)) === false) {
    const {
      rows: [binding],
    } = await sql.query<{ sandboxId: string }>(
      'select bound_sandbox_id as "sandboxId" from docker_host_jobs where request_id=$1',
      [report.requestId],
    );
    await runDockerStop(sql, key, binding!.sandboxId, completionSql);
    if ((await hosts.expired(hostToken, installationId, report)) === false)
      throw new Error("Docker expiry is still pending after settlement.");
  }
}

export const stopFixtureMachineId = "d".repeat(64);

export async function bindDockerStopFixture(sql: Sql, sandboxId: string) {
  await sql.query(
    `insert into docker_machine_bindings(sandbox_id,machine_generation,host_id,installation_id,daemon_generation)
     select id,lifecycle_generation,docker_host_id,docker_installation_id,docker_generation from sandboxes where id=$1`,
    [sandboxId],
  );
  await sql.query(
    `update docker_host_jobs j set result_machine_id=$2, request_id=s.docker_generation
     from sandboxes s where s.id=$1 and j.bound_sandbox_id=s.id and j.bound_operation='create'`,
    [sandboxId, stopFixtureMachineId],
  );
}
