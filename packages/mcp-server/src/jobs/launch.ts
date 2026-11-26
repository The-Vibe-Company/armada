import type { JobKind } from "./runner.ts";
import type { createJobsStore } from "./store.ts";

export function enqueueLaunch(
  store: ReturnType<typeof createJobsStore>,
  ...args: Parameters<typeof store.enqueueWithDisposition> extends [string, ...infer Args] ? Args : never
) {
  return store.enqueueWithDisposition("launch", ...args);
}

export function createLaunchJob(handlers: { modal?: JobKind; boat?: JobKind["run"]; docker?: JobKind["run"] }) {
  return {
    concurrency: handlers.modal?.concurrency ?? 8,
    async run(job, context) {
      const { outcome, payload } = job;
      const docker = typeof outcome === "object" && outcome !== null && "docker_actor_epoch" in outcome;
      const boat = typeof payload === "object" && payload !== null && "boat" in payload;
      const run = docker ? handlers.docker : boat ? handlers.boat : handlers.modal?.run;
      if (!run && boat && !docker) throw new Error("Boat launch worker is unavailable.");
      return run?.(job, context) ?? { status: "fail", reason: "launch_provider_unavailable" };
    },
    ...(handlers.modal?.drain ? { drain: () => handlers.modal!.drain!() } : {}),
  } satisfies JobKind;
}
