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
  machineId?: string;
  generation: number;
  runtimeEpoch?: string;
  onlyIfIdle?: boolean;
  exitPending?: true;
  retryAfter?: string;
  daemonGeneration?: string;
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
      const expired = "expired" in intent;
      const finish = {
        status: "done",
        async commit(tx) {
          const settled = expired
            ? await transitionSandbox(tx, {
                sandboxId,
                expectedGeneration: generation,
                fromStates: ["starting", "ready", "running", "stopping", "stopped", "failed"],
                toState: "stopped",
                actor: "docker_host",
                code: "docker_expiry_observed",
                effects: [],
              })
            : await recordDockerCleanupReceipt(tx, sandboxId, Number(generation), "stop");
          if (settled.kind !== "applied") throw new Error("Docker stop settlement changed generation.");
          await enqueueStopOutput(
            tx,
            jobs,
            sandboxId,
            expired ? intent.orgId : intent.actor.orgId,
            expired ? generation : settled.generation,
          );
        },
      } satisfies JobResult;
      if (expired) return finish;
      const { signal } = context;
      const retry = (delay = 2_000) => ({ status: "retry", after: new Date(now() + delay) }) satisfies JobResult;
      const advanced = generation !== String(intent.generation);
      if (advanced || intent.exitPending) {
        const outcome = await hosts.stopOutcome(sandboxId, generation, intent);
        signal.throwIfAborted();
        if (outcome === "stopped") return finish;
        if (outcome === "refused") return { status: "fail", reason: "stop_receipt_refused" };
      }
      const mayDispatch = await context.canDispatch();
      if (advanced || (intent.exitPending && !mayDispatch)) return retry(mayDispatch ? 2_000 : 30_000);
      if (!mayDispatch) return { status: "fail", reason: "stop_dispatch_deadline" };
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
      let target: Awaited<ReturnType<typeof hosts.lockStop>>;
      const lockPrerequisites = async (tx: Sql) => {
        target = await hosts.lockStop(tx, sandboxId, intent);
      };
      const dispatch = async (tx: Sql) => {
        try {
          await createDockerHostStore(scopedRuntimeSql(tx), key)
            .machineCleanup(intent.actor, intent)
            .stop({
              sandboxId,
              ...target,
              retain: true,
              signal,
            });
        } catch (error) {
          if (!(error instanceof DockerMachinePending)) throw error;
        }
      };
      try {
        if (intent.exitPending) {
          await withJobLease(
            sql,
            job,
            async (tx) => {
              if (await context.canDispatch(tx)) await dispatch(tx);
            },
            lockPrerequisites,
          );
        } else {
          await context.handoffGeneration({
            lockPrerequisites,
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
              await dispatch(tx);
            },
          });
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof DockerMachinePending) return retry();
        if (error instanceof DockerHostDenied) return { status: "fail", reason: "stop_authority_changed" };
        throw error;
      }
      return retry();
    },
  } satisfies JobKind;
}
