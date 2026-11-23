import { createHash } from "node:crypto";
import type { ResumeStageObserver, SandboxInfo } from "@armada/core";
import type { Sandbox } from "modal";
import { ModalOperationError, refusal } from "./errors.ts";
import { observeModalCompute, stopModalCompute, terminateModalCompute } from "./machine.ts";
import type { Machine, ModalResourceReceipt, ModalStore, RunnerDistribution } from "./ports.ts";
import type { ModalProvider } from "./provider.ts";
import { bootstrapModalRuntime, validateRuntimeTicket } from "./runtime-bootstrap.ts";

interface RuntimeLifecycleDependencies {
  store: ModalStore;
  distribution: Pick<RunnerDistribution, "prepareSnapshot">;
  bound(): Promise<unknown>;
  assertMachineSource(row: Machine): void;
  physical(row: Machine, signal?: AbortSignal): Promise<Sandbox>;
  resourceReceipt(row: Machine): Promise<ModalResourceReceipt>;
  create(
    row: Machine,
    save: (row: Machine) => Promise<void>,
    env: Readonly<Record<string, string>>,
    onResumeStage?: ResumeStageObserver,
  ): Promise<SandboxInfo>;
  sandboxInfo(row: Machine): SandboxInfo;
}

export function createRuntimeLifecycle({
  store,
  distribution,
  bound,
  assertMachineSource,
  physical,
  resourceReceipt,
  create,
  sandboxInfo,
}: RuntimeLifecycleDependencies) {
  return {
    async startRuntime(input) {
      const serverUrl = validateRuntimeTicket(input);
      await store.lease(input.sandboxId, async (row, save) => {
        assertMachineSource(row);
        if (
          !row.commonRuntime ||
          row.golden ||
          !row.physicalId ||
          row.phase !== "active" ||
          row.runtimeStartAttempted ||
          row.runtimeResumeGeneration !== input.resumeGeneration
        )
          throw refusal("conflict", "Enrolled runtime bootstrap requires a fresh host-only incarnation.");
        const sb = await physical(row);
        const { phase } = await observeModalCompute(
          { sandboxId: input.sandboxId, generation: row.generation, machineId: row.physicalId },
          sb,
        );
        if (phase === "stopped") throw refusal("sandbox_not_ready", "Physical machine has exited.");
        row.runtimeStartAttempted = true;
        await save(row);
        await bootstrapModalRuntime(
          sb,
          row.physicalId,
          serverUrl,
          input,
          "Enrolled Modal bootstrap failed; spawn outcome must be reconciled.",
        );
      });
    },
    async stopRuntime(input) {
      if (!/^[1-9][0-9]{0,18}$/.test(input.epoch) || !Number.isSafeInteger(input.watermark) || input.watermark < 0)
        throw refusal("invalid_request", "A durable common checkpoint epoch and watermark are required.");
      await bound();
      let observed: Machine | undefined;
      try {
        await store.lease(input.sandboxId, async (row, save) => {
          observed = row;
          assertMachineSource(row);
          if (
            !row.commonRuntime ||
            row.golden ||
            !row.physicalId ||
            input.physicalGeneration !== String(row.generation)
          )
            throw refusal("conflict", "Retained stop requires the exact enrolled physical incarnation.");
          const expected = {
            epoch: input.epoch,
            watermark: input.watermark,
            physicalId: row.physicalId,
            generation: row.generation,
          };
          const prior = row.runtimeCheckpoint;
          if (
            prior &&
            prior.generation === row.generation &&
            (prior.epoch !== expected.epoch ||
              prior.watermark !== expected.watermark ||
              prior.physicalId !== expected.physicalId)
          )
            throw refusal("conflict", "Retained stop belongs to another checkpoint.");
          if (row.phase === "stopped") {
            if (!row.recoveryImageId || !prior) throw refusal("conflict", "No retained common checkpoint exists.");
            return;
          }
          if (!["active", "checkpoint", "terminate"].includes(row.phase))
            throw refusal("conflict", "Snapshot outcome is unknown; retain the physical source for reconciliation.");
          const sb = await physical(row);
          const needsSnapshot = row.phase !== "terminate";
          if (!needsSnapshot && (!row.recoveryImageId || !prior || !row.quiesced))
            throw refusal("conflict", "Termination lacks a retained common checkpoint.");
          await stopModalCompute(sb, {
            ...(needsSnapshot && {
              checkpoint: {
                async prepare() {
                  if ((await sb.poll()) !== null) throw refusal("sandbox_not_ready", "Checkpoint source has exited.");
                  delete row.runtimeResumeGeneration;
                  row.runtimeCheckpoint = expected;
                  row.phase = "checkpoint";
                  row.info.state = "stopping";
                  await save(row);
                  if (!row.quiesced) {
                    await distribution.prepareSnapshot(sb, row);
                    row.quiesced = true;
                    await save(row);
                  }
                },
                async recordIntent() {
                  row.phase = "snapshot";
                  await save(row);
                },
                async recordImage(recoveryImageId) {
                  if (row.recoveryImageId)
                    row.retainedRecoveryIds = [...(row.retainedRecoveryIds ?? []), row.recoveryImageId];
                  row.recoveryImageId = recoveryImageId;
                  row.phase = "terminate";
                  await save(row);
                },
              },
            }),
          });
          row.phase = "stopped";
          row.info.state = "stopped";
          row.info.providerState = "stopped";
          row.info.stoppedAt = new Date();
          await save(row);
        });
      } catch (error) {
        if (observed) throw new ModalOperationError(error, await resourceReceipt(observed));
        throw error;
      }
    },
    async resumeRuntime(input, signal, onResumeStage) {
      const { epoch, watermark } = input.checkpoint;
      if (
        !/^[1-9][0-9]{0,18}$/.test(epoch) ||
        !Number.isSafeInteger(watermark) ||
        watermark < 0 ||
        !Number.isSafeInteger(input.generation) ||
        input.generation < 1 ||
        !Number.isInteger(input.ttlSeconds) ||
        input.ttlSeconds < 1 ||
        input.ttlSeconds > 86400
      )
        throw refusal("invalid_request", "Common resume requires a checkpoint and a valid physical TTL.");
      signal?.throwIfAborted();
      await bound();
      let observed: Machine | undefined;
      try {
        return await store.lease(input.sandboxId, async (row, save) => {
          signal?.throwIfAborted();
          observed = row;
          assertMachineSource(row);
          const checkpoint = row.runtimeCheckpoint;
          if (
            !row.commonRuntime ||
            row.golden ||
            !row.recoveryImageId ||
            !checkpoint ||
            checkpoint.epoch !== epoch ||
            checkpoint.watermark !== watermark
          )
            throw refusal("conflict", "No matching retained common checkpoint is available.");
          if (row.phase === "stopped") {
            if (row.runtimeResumeGeneration !== undefined && input.generation <= row.runtimeResumeGeneration)
              throw refusal("conflict", "Resume generation has already been rolled back.");
            if (checkpoint.generation !== row.generation || checkpoint.physicalId !== row.physicalId)
              throw refusal("conflict", "Retained source incarnation does not match.");
            row.generation++;
            row.runtimeResumeGeneration = input.generation;
            row.ttlSeconds = input.ttlSeconds;
            row.imageId = row.recoveryImageId;
            row.phase = "reserved";
            row.info.state = "starting";
            row.quiesced = false;
            row.physicalName = `armada-${createHash("sha256").update(row.info.id).digest("hex").slice(0, 32)}-${row.generation}`;
            delete row.physicalId;
            delete row.processBaseline;
            delete row.runtimeStartAttempted;
            delete row.info.stopNote;
            delete row.info.stoppedAt;
            await save(row);
          }
          if (
            row.runtimeResumeGeneration !== input.generation ||
            row.generation !== checkpoint.generation + 1 ||
            row.imageId !== row.recoveryImageId ||
            row.ttlSeconds !== input.ttlSeconds
          )
            throw refusal("conflict", "Common resume belongs to another activation.");
          signal?.throwIfAborted();
          if (["reserved", "creating", "booting"].includes(row.phase)) return create(row, save, {}, onResumeStage);
          if (row.phase === "active") {
            const sb = await physical(row);
            const { phase } = await observeModalCompute(
              { sandboxId: input.sandboxId, generation: row.generation, machineId: sb.sandboxId },
              sb,
            );
            if (phase === "running") return sandboxInfo(row);
          }
          throw refusal("conflict", "Resume activation outcome is unavailable; do not allocate again.");
        });
      } catch (error) {
        if (observed) throw new ModalOperationError(error, await resourceReceipt(observed));
        throw error;
      }
    },
    async rollbackRuntimeResume({ sandboxId, generation }) {
      await bound();
      await store.lease(sandboxId, async (row, save) => {
        assertMachineSource(row);
        const checkpoint = row.runtimeCheckpoint;
        if (
          !row.commonRuntime ||
          row.runtimeResumeGeneration !== generation ||
          !row.recoveryImageId ||
          row.imageId !== row.recoveryImageId ||
          !checkpoint ||
          !row.physicalId
        )
          throw refusal("conflict", "Rollback requires the exact retained resume.");
        if (
          row.phase === "stopped" &&
          checkpoint.generation === row.generation &&
          checkpoint.physicalId === row.physicalId
        )
          return;
        if (row.generation !== checkpoint.generation + 1 || !["active", "terminate"].includes(row.phase))
          throw refusal("conflict", "Rollback requires the exact replacement incarnation.");
        if (row.phase !== "terminate") {
          row.phase = "terminate";
          row.info.state = "stopping";
          await save(row);
        }
        await terminateModalCompute(await physical(row));
        row.runtimeCheckpoint = { ...checkpoint, physicalId: row.physicalId, generation: row.generation };
        row.phase = "stopped";
        row.info.state = "stopped";
        row.info.providerState = "stopped";
        row.info.stoppedAt = new Date();
        await save(row);
      });
    },
  } satisfies Pick<ModalProvider, "startRuntime" | "stopRuntime" | "resumeRuntime" | "rollbackRuntimeResume">;
}
