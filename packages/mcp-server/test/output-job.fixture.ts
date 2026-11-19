import type { Sql } from "@armada/core/server";
import { createJobsRunner } from "../src/jobs/runner.ts";
import { createJobsStore } from "../src/jobs/store.ts";
import { createSandboxOutputs, OUTPUTS_CAPTURE } from "../src/sandbox-outputs.ts";

export function outputJobFixture(sql: Sql, ...args: Tail<Parameters<typeof createSandboxOutputs>>) {
  const service = createSandboxOutputs(sql, ...args);
  const jobs = createJobsStore(sql);
  let tick: AbortSignal;
  const runner = createJobsRunner(jobs, {
    [OUTPUTS_CAPTURE]: {
      ...service.captureJob,
      run(job, context) {
        return service.captureJob.run(job, { ...context, signal: AbortSignal.any([tick, context.signal]) });
      },
    },
  });
  return {
    ...service,
    stopAdmission: runner.stopAdmission,
    async reconcileOne(signal: AbortSignal) {
      tick = signal;
      await service.enqueueCaptures(jobs, signal);
      return runner.reconcileOne(signal);
    },
    async drain() {
      await runner.drain();
      await service.drain();
    },
  };
}

type Tail<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never;
