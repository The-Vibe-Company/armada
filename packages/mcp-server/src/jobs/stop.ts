import type { Sql } from "@armada/core";
import { createDockerHostStore, DockerHostDenied } from "../docker-host-store.ts";
import { DockerMachinePending } from "../docker-machine-adapter.ts";
import { createDockerOutputReader } from "../docker-outputs.ts";
import { scopedRuntimeSql } from "../runtime-enrolment.ts";
import { recordDockerCleanupReceipt, transitionSandbox } from "../sandbox-lifecycle.ts";
import { captureFinalOutputs, enqueueStopOutput, type StagedOutput } from "../sandbox-outputs.ts";
import type { JobKind, JobResult } from "./runner.ts";
import { createJobsStore, recordStopCapture, withJobLease } from "./store.ts";
export interface DockerStopIntent {
  actor: { userId: string; orgId: string };
  actorEpoch: string;
  checkpoint?: string;
  workMerged?: boolean;
  machineId: string;
  generation: number;
  runtimeEpoch?: string;
  onlyIfIdle?: boolean;
  exitPending?: true;
  daemonGeneration: string;
  hostId: string;
  installationId: string;
  captureUntil: number;
}
type DockerExpiry = { expired: true; orgId: string };
export function createStopJob(sql: Sql, key: string, readOutputs = createDockerOutputReader(sql, key), now = Date.now) {
  const hosts = createDockerHostStore(sql, key);
  const jobs = createJobsStore(sql, key);
  return {
    concurrency: 8,
    async run(job, context) {
      const intent = job.payload as DockerStopIntent | DockerExpiry | null;
      if (!job.sandbox_id || !job.generation || !intent) return { status: "fail", reason: "stop_intent_missing" };
      const sandboxId = job.sandbox_id;
      const generation = job.generation;
      if ("expired" in intent)
        return {
          status: "done",
          async commit(tx) {
            const result = await transitionSandbox(tx, {
              sandboxId,
              expectedGeneration: generation,
              fromStates: ["starting", "ready", "running", "stopping", "stopped", "failed"],
              toState: "stopped",
              actor: "docker_host",
              code: "docker_expiry_observed",
              effects: [],
            });
            if (result.kind !== "applied") throw new Error("Docker expiry settlement changed generation.");
            await enqueueStopOutput(tx, jobs, sandboxId, intent.orgId, generation);
          },
        };
      const { signal } = context;
      const retry = (delay = 2_000) => ({ status: "retry", after: new Date(now() + delay) }) satisfies JobResult;
      const advanced = generation !== String(intent.generation);
      if (advanced || intent.exitPending) {
        const outcome = await hosts.stopOutcome(sandboxId, generation, intent);
        signal.throwIfAborted();
        if (outcome === "stopped")
          return {
            status: "done",
            async commit(tx) {
              const settled = await recordDockerCleanupReceipt(tx, sandboxId, Number(generation), "stop");
              if (settled.kind !== "applied") throw new Error("Docker stop settlement changed generation.");
              await enqueueStopOutput(tx, jobs, sandboxId, intent.actor.orgId, settled.generation);
            },
          };
        if (outcome === "refused") return { status: "fail", reason: "stop_receipt_refused" };
        if (advanced || !(await context.canDispatch())) return retry((await context.canDispatch()) ? 2_000 : 30_000);
      }
      if (!(await context.canDispatch())) return { status: "fail", reason: "stop_dispatch_deadline" };
      if (!job.outcome && !intent.exitPending) {
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
      const dispatch = async (tx: Sql, machineGeneration: number) => {
        try {
          await createDockerHostStore(scopedRuntimeSql(tx), key).machineCleanup(intent.actor, intent).stop({
            sandboxId,
            generation: machineGeneration,
            machineId: intent.machineId,
            retain: true,
            signal,
          });
        } catch (error) {
          if (!(error instanceof DockerMachinePending)) throw error;
        }
      };
      try {
        if (intent.exitPending) {
          let machineGeneration = 0;
          await withJobLease(
            sql,
            job,
            async (tx) => {
              if (await context.canDispatch(tx)) await dispatch(tx, machineGeneration);
            },
            async (tx) => {
              machineGeneration = await hosts.lockStop(tx, sandboxId, intent);
            },
          );
        } else {
          await context.handoffGeneration({
            lockPrerequisites: async (tx) => {
              await hosts.lockStop(tx, sandboxId, intent);
            },
            async advance(tx) {
              const result = await transitionSandbox(tx, {
                sandboxId,
                expectedGeneration: intent.generation,
                fromStates: ["starting", "ready", "running"],
                toState: "stopping",
                actor: intent.checkpoint ? "idle" : "owner",
                code: intent.checkpoint
                  ? intent.workMerged
                    ? "docker_work_merged"
                    : "docker_idle_paused"
                  : "docker_stop_admitted",
                effects: [],
              });
              if (result.kind === "conflict") throw new Error("Docker stop target changed.");
              await dispatch(tx, intent.generation);
            },
          });
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof DockerHostDenied) return { status: "fail", reason: "stop_authority_changed" };
        throw error;
      }
      return retry();
    },
  } satisfies JobKind;
}
