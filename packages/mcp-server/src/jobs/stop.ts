import type { Sql } from "@armada/core";
import { createDockerHostStore, DockerHostDenied } from "../docker-host-store.ts";
import { DockerMachinePending } from "../docker-machine-adapter.ts";
import { createDockerOutputReader } from "../docker-outputs.ts";
import { scopedRuntimeSql } from "../runtime-enrolment.ts";
import { recordDockerCleanupReceipt, transitionSandbox } from "../sandbox-lifecycle.ts";
import { captureFinalOutputs, enqueueStopOutput, type StagedOutput } from "../sandbox-outputs.ts";
import type { JobKind, JobResult } from "./runner.ts";
import { createJobsStore, recordStopCapture } from "./store.ts";

export interface DockerStopIntent {
  actor: { userId: string; orgId: string };
  actorEpoch: string;
  checkpoint: string;
  workMerged: boolean;
  machineId: string;
  generation: number;
  runtimeEpoch: string;
  daemonGeneration: string;
  hostId: string;
  installationId: string;
  captureUntil: number;
}
export function createStopJob(sql: Sql, key: string, readOutputs = createDockerOutputReader(sql, key), now = Date.now) {
  const hosts = createDockerHostStore(sql, key);
  const jobs = createJobsStore(sql, key);
  return {
    concurrency: 8,
    async run(job, context) {
      const intent = job.payload as DockerStopIntent | null;
      if (!job.sandbox_id || !job.generation || !intent) return { status: "fail", reason: "stop_intent_missing" };
      const sandboxId = job.sandbox_id;
      const target = { sandboxId, generation: intent.generation, machineId: intent.machineId };
      const { signal } = context;
      const retry = (delay = 2_000) => ({ status: "retry", after: new Date(now() + delay) }) satisfies JobResult;
      const finish = {
        status: "done",
        async commit(tx) {
          const settled = await recordDockerCleanupReceipt(tx, sandboxId, Number(job.generation), "stop");
          if (settled.kind !== "applied") throw new Error("Docker stop settlement changed generation.");
          await enqueueStopOutput(tx, jobs, sandboxId, intent.actor.orgId, settled.generation);
        },
      } satisfies JobResult;
      if (job.generation !== String(intent.generation)) {
        const outcome = await hosts.checkpointedStopOutcome(sandboxId, intent);
        signal.throwIfAborted();
        if (outcome === "stopped") return finish;
        if (outcome === "refused") return { status: "fail", reason: "stop_receipt_refused" };
        return retry((await context.canDispatch()) ? 2_000 : 30_000);
      }

      if (!(await context.canDispatch())) return { status: "fail", reason: "stop_dispatch_deadline" };
      if (!job.outcome) {
        const stage = async (tx: Sql, output: StagedOutput) => {
          signal.throwIfAborted();
          if (!(await context.canDispatch(tx))) throw new Error("Stop capture claim changed.");
          await recordStopCapture(tx, job.id, output);
        };
        const remaining = intent.captureUntil - now();
        if (remaining > 0) {
          await captureFinalOutputs(sql, readOutputs(sandboxId, intent.runtimeEpoch), sandboxId, {
            key,
            signal: AbortSignal.any([signal, AbortSignal.timeout(remaining)]),
            generation: job.generation,
            stage,
          }).catch(() => {});
        }
      }
      signal.throwIfAborted();
      if (!(await context.canDispatch())) return { status: "fail", reason: "stop_dispatch_deadline" };
      try {
        await context.handoffGeneration({
          lockPrerequisites: (tx) => hosts.lockCheckpointedStop(tx, sandboxId, intent),
          async advance(tx) {
            const result = await transitionSandbox(tx, {
              sandboxId,
              expectedGeneration: intent.generation,
              fromStates: ["ready", "running"],
              toState: "stopping",
              actor: "idle",
              code: intent.workMerged ? "docker_work_merged" : "docker_idle_paused",
              effects: [],
            });
            if (result.kind === "conflict") throw new Error("Docker stop target changed.");
            const dispatch = createDockerHostStore(scopedRuntimeSql(tx), key).machineCleanup(intent.actor, intent);
            try {
              await dispatch.stop({ ...target, retain: true, signal });
            } catch (error) {
              if (!(error instanceof DockerMachinePending)) throw error;
            }
          },
        });
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof DockerHostDenied) return { status: "fail", reason: "stop_authority_changed" };
        throw error;
      }
      return retry();
    },
  } satisfies JobKind;
}
