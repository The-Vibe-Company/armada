import { createHash } from "node:crypto";
import type { ResumeStageObserver, SandboxInfo, Sql } from "@armada/core";
import type { Machine as MachineContract, MachineIdentity } from "@armada/core/server";
import type { Sandbox } from "modal";
import { abortable, withModalStopSignal } from "./client.ts";
import { ModalOperationError, refusal } from "./errors.ts";
import { observeModalCompute, stopModalCompute, terminateModalCompute } from "./machine.ts";
import type { Machine, ModalResourceReceipt, ModalStore, RunnerDistribution } from "./ports.ts";
import type { ModalProvider } from "./provider.ts";
import { bootstrapModalRuntime, type RuntimeTicket, validateRuntimeTicket } from "./runtime-bootstrap.ts";

export type ModalRuntimeResume = (binding: {
  recordId: string;
  sandboxId: string;
  generation: number;
  checkpoint: { epoch: string; watermark: number };
  deadlineAt?: number;
  write(work: (tx: Sql) => Promise<void>): Promise<void>;
  authorize(): Promise<void>;
  ticket(request: Parameters<MachineContract["bootstrap"]>[0]): Promise<RuntimeTicket | null>;
}) => Promise<
  Pick<MachineContract, "resume" | "bootstrap"> & {
    predecessor: Parameters<MachineContract["resume"]>[0]["predecessor"];
  }
>;

type PhysicalTarget = Pick<MachineIdentity, "machineId" | "generation">;

export type ModalRuntimeStop = (binding: {
  recordId: string;
  sandboxId: string;
  generation: number;
  physical?: PhysicalTarget | undefined;
  checkpoint: { epoch: string; watermark: number } | null;
  write(work: (tx: Sql) => Promise<void>): Promise<void>;
  reconcileOnly?: boolean;
  signal?: AbortSignal;
  deadlineAt?: number | undefined;
}) => Promise<{
  physical: PhysicalTarget;
  machine: Pick<MachineContract, "stop">;
  stopped: boolean;
}>;

interface RuntimeLifecycleDependencies {
  store: ModalStore;
  distribution: Pick<RunnerDistribution, "prepareSnapshot">;
  bound(): Promise<unknown>;
  assertMachineSource(row: Machine): void;
  physical(row: Machine, signal?: AbortSignal): Promise<Sandbox>;
  namedOwned(row: Machine): Promise<Sandbox>;
  resourceReceipt(row: Machine): Promise<ModalResourceReceipt>;
  create(
    row: Machine,
    save: (row: Machine) => Promise<void>,
    onResumeStage?: ResumeStageObserver,
    beforeAllocate?: () => Promise<void>,
  ): Promise<SandboxInfo>;
}

export function createRuntimeLifecycle({
  store,
  distribution,
  bound,
  assertMachineSource,
  physical,
  namedOwned,
  resourceReceipt,
  create,
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
    async runtimeStopMachine({
      recordId,
      sandboxId: logicalId,
      generation,
      physical: savedTarget,
      checkpoint,
      write,
      reconcileOnly,
      deadlineAt,
      signal: leaseSignal,
    }: Parameters<ModalRuntimeStop>[0]) {
      const pinned = await store.get(recordId);
      const source = pinned.runtimeCheckpoint;
      const image = pinned.recoveryImageId;
      if (source && image && pinned.runtimeResumeGeneration === generation && !pinned.physicalId) {
        if (pinned.phase === "reserved") {
          pinned.generation = source.generation;
          pinned.physicalId = source.physicalId;
          pinned.phase = "stopped";
          pinned.info.state = "stopped";
          pinned.info.providerState = "stopped";
          pinned.info.stoppedAt = new Date();
        } else if (pinned.phase === "creating") {
          const observed = await withModalStopSignal(leaseSignal, undefined, () => namedOwned(pinned));
          pinned.physicalId = observed.sandboxId;
          pinned.phase = "booting";
        }
        leaseSignal?.throwIfAborted();
        if (pinned.physicalId) await write((tx) => store.saveResume(tx, pinned, source.generation, image));
      }
      if (!pinned.physicalId) throw refusal("conflict", "No current Modal physical incarnation.");
      const target = savedTarget ?? { machineId: pinned.physicalId, generation: pinned.generation };
      return {
        stopped: pinned.phase === "stopped",
        physical: target,
        machine: {
          stop: (request) =>
            withModalStopSignal(request.signal, deadlineAt, async () => {
              const { machineId, sandboxId, retain, signal } = request;
              if (sandboxId !== logicalId || request.generation !== generation || machineId !== target.machineId)
                throw refusal("conflict", "The stop job incarnation changed.");
              if (
                retain &&
                !reconcileOnly &&
                (!checkpoint ||
                  !/^[1-9][0-9]{0,18}$/.test(checkpoint.epoch) ||
                  !Number.isSafeInteger(checkpoint.watermark) ||
                  checkpoint.watermark < 0)
              )
                throw refusal("invalid_request", "A durable common checkpoint is required.");
              signal?.throwIfAborted();
              const row = await store.get(recordId);
              assertMachineSource(row);
              if (
                !row.commonRuntime ||
                row.golden ||
                row.physicalId !== machineId ||
                row.generation !== target.generation
              )
                throw refusal("conflict", "Stop requires the exact enrolled physical incarnation.");
              const save = () => write((tx) => store.saveStop(tx, row));
              const expected =
                retain && checkpoint ? { ...checkpoint, generation: target.generation, physicalId: machineId } : null;
              const prior = row.runtimeCheckpoint;
              if (
                !reconcileOnly &&
                row.phase !== "stopped" &&
                prior &&
                prior.generation === target.generation &&
                (!expected ||
                  prior.epoch !== expected.epoch ||
                  prior.watermark !== expected.watermark ||
                  prior.physicalId !== machineId)
              )
                throw refusal("conflict", "Retained stop belongs to another checkpoint.");
              const retained = () =>
                retain &&
                expected &&
                row.recoveryImageId &&
                row.runtimeCheckpoint?.generation === target.generation &&
                row.runtimeCheckpoint.physicalId === machineId &&
                row.runtimeCheckpoint.epoch === expected.epoch &&
                row.runtimeCheckpoint.watermark === expected.watermark
                  ? { sandboxId, generation, kind: "image" as const, ref: row.recoveryImageId }
                  : null;
              const forgetRecovery = () => {
                if (row.recoveryImageId)
                  row.retainedRecoveryIds = [...(row.retainedRecoveryIds ?? []), row.recoveryImageId];
                delete row.recoveryImageId;
                delete row.runtimeCheckpoint;
              };
              const settle = async (receipt: ReturnType<typeof retained>) => {
                if (!receipt) forgetRecovery();
                row.phase = "stopped";
                row.info.state = "stopped";
                row.info.providerState = "stopped";
                row.info.stoppedAt = new Date();
                await save();
                return receipt;
              };
              try {
                if (row.phase === "stopped") return retained();
                const sb = await physical(row, signal);
                const reuseRetained =
                  expected &&
                  prior &&
                  row.recoveryImageId &&
                  row.runtimeResumeGeneration === generation &&
                  row.generation === prior.generation + 1 &&
                  prior.epoch === expected.epoch &&
                  prior.watermark === expected.watermark;
                if (reuseRetained && !reconcileOnly) {
                  row.runtimeCheckpoint = expected;
                  row.phase = "terminate";
                  row.quiesced = true;
                  await save();
                }
                if ((await sb.poll()) !== null) return settle(row.phase === "terminate" ? retained() : null);
                if (reconcileOnly)
                  throw refusal("unavailable", "The Modal machine still runs; observation will retry.");
                const livePhases: Machine["phase"][] = expected
                  ? ["active", "checkpoint"]
                  : ["active", "booting", "creating"];
                if (row.phase !== "terminate" && !livePhases.includes(row.phase))
                  throw refusal("conflict", "Stop outcome is unknown; retain the physical source for reconciliation.");
                if (row.phase === "terminate" && retain && (!retained() || !row.quiesced))
                  throw refusal("conflict", "Termination lacks a retained common checkpoint.");
                if (!retain && row.phase !== "terminate") {
                  forgetRecovery();
                  row.phase = "terminate";
                  row.info.state = "stopping";
                  await save();
                }
                await stopModalCompute(sb, {
                  wait: false,
                  signal,
                  ...(expected &&
                    row.phase !== "terminate" && {
                      checkpoint: {
                        async prepare() {
                          if ((await sb.poll()) !== null)
                            throw refusal("sandbox_not_ready", "Checkpoint source has exited.");
                          delete row.runtimeResumeGeneration;
                          row.runtimeCheckpoint = expected;
                          row.phase = "checkpoint";
                          row.info.state = "stopping";
                          await save();
                          if (!row.quiesced) {
                            signal?.throwIfAborted();
                            await abortable(distribution.prepareSnapshot(sb, row), signal);
                            row.quiesced = true;
                            await save();
                          }
                        },
                        async recordIntent() {
                          row.phase = "snapshot";
                          await save();
                        },
                        async recordImage(recoveryImageId) {
                          if (row.recoveryImageId)
                            row.retainedRecoveryIds = [...(row.retainedRecoveryIds ?? []), row.recoveryImageId];
                          row.recoveryImageId = recoveryImageId;
                          row.phase = "terminate";
                          await save();
                        },
                      },
                    }),
                });
                return settle(retained());
              } catch (error) {
                throw new ModalOperationError(error, await resourceReceipt(row));
              }
            }),
        },
      } satisfies Awaited<ReturnType<ModalRuntimeStop>>;
    },
    async runtimeResumeMachine({ recordId, sandboxId, generation, checkpoint, deadlineAt, write, authorize, ticket }) {
      const source = await store.get(recordId);
      const predecessor = source.runtimeCheckpoint;
      const image = source.recoveryImageId;
      if (
        !predecessor ||
        !image ||
        predecessor.epoch !== checkpoint.epoch ||
        predecessor.watermark !== checkpoint.watermark
      )
        throw refusal("conflict", "No matching retained common checkpoint is available.");
      const sourceGeneration = predecessor.generation;
      return {
        predecessor: { sandboxId, generation: generation - 1, kind: "image", ref: image },
        async resume(request) {
          const { computeTtlSeconds, signal } = request;
          if (
            request.sandboxId !== sandboxId ||
            request.generation !== generation ||
            request.predecessor.sandboxId !== sandboxId ||
            request.predecessor.generation !== generation - 1 ||
            request.predecessor.kind !== "image" ||
            request.predecessor.ref !== image
          )
            throw refusal("conflict", "Modal resume source changed.");
          if (!Number.isInteger(computeTtlSeconds) || computeTtlSeconds < 1 || computeTtlSeconds > 86400)
            throw refusal("invalid_request", "Invalid Modal resume TTL.");
          const row = await store.get(recordId);
          const save = (record: Machine) => write((tx) => store.saveResume(tx, record, sourceGeneration, image));
          const { epoch, watermark } = checkpoint;
          signal?.throwIfAborted();
          assertMachineSource(row);
          const retained = row.runtimeCheckpoint;
          if (
            !row.commonRuntime ||
            row.golden ||
            !row.recoveryImageId ||
            !retained ||
            retained.epoch !== epoch ||
            retained.watermark !== watermark
          )
            throw refusal("conflict", "No matching retained common checkpoint is available.");
          if (row.phase === "stopped") {
            if (row.runtimeResumeGeneration !== undefined && generation <= row.runtimeResumeGeneration)
              throw refusal("conflict", "Resume generation has already been rolled back.");
            if (retained.generation !== row.generation || retained.physicalId !== row.physicalId)
              throw refusal("conflict", "Retained source incarnation does not match.");
            row.generation++;
            row.runtimeResumeGeneration = generation;
            row.ttlSeconds = computeTtlSeconds;
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
            row.runtimeResumeGeneration !== generation ||
            row.generation !== retained.generation + 1 ||
            row.imageId !== row.recoveryImageId ||
            row.ttlSeconds !== computeTtlSeconds
          )
            throw refusal("conflict", "Common resume belongs to another activation.");
          signal?.throwIfAborted();
          if (["reserved", "creating", "booting"].includes(row.phase))
            await withModalStopSignal(signal, deadlineAt, () => create(row, save, undefined, authorize));
          if (row.phase === "active") {
            const sb = await physical(row);
            const { phase } = await observeModalCompute(
              { sandboxId, generation: row.generation, machineId: sb.sandboxId },
              sb,
              signal,
            );
            if (phase === "running") return { sandboxId, generation, machineId: sb.sandboxId };
          }
          throw refusal("conflict", "Resume activation outcome is unavailable; do not allocate again.");
        },
        async bootstrap(request) {
          const row = await store.get(recordId);
          assertMachineSource(row);
          if (
            request.sandboxId !== sandboxId ||
            request.generation !== generation ||
            row.runtimeResumeGeneration !== generation ||
            row.phase !== "active" ||
            row.physicalId !== request.machineId
          )
            throw refusal("conflict", "Modal bootstrap source changed.");
          const descriptor = await ticket(request);
          if (!descriptor) return;
          const server = validateRuntimeTicket(descriptor);
          const sb = await physical(row, request.signal);
          await authorize();
          request.signal?.throwIfAborted();
          await withModalStopSignal(request.signal, deadlineAt, () =>
            bootstrapModalRuntime(
              sb,
              request.machineId,
              server,
              descriptor,
              "Modal resume bootstrap must be reconciled.",
            ),
          );
        },
      };
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
  } satisfies Pick<
    ModalProvider,
    "startRuntime" | "runtimeStopMachine" | "runtimeResumeMachine" | "rollbackRuntimeResume"
  >;
}
