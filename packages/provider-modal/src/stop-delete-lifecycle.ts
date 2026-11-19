import type { Provider } from "@armada/core";
import type { boundModalApp, modalConnection } from "./client.ts";
import { lifecycleStep, ModalOperationError, modalError, refusal } from "./errors.ts";
import type { createImageCollection } from "./image-collection.ts";
import type { createPhysicalLifecycle } from "./physical-lifecycle.ts";
import type { Machine, ModalResourceReceipt, ModalStore, RunnerDistribution, RunnerTransport } from "./ports.ts";

const CLEANUP_RETRY_MS = [1_000, 5_000];

export function createStopDeleteLifecycle(deps: {
  client: ReturnType<typeof modalConnection>;
  store: ModalStore;
  runner: RunnerTransport;
  distribution: RunnerDistribution;
  bound: () => ReturnType<typeof boundModalApp>;
  physicalLifecycle: Pick<ReturnType<typeof createPhysicalLifecycle>, "physical" | "namedOwned" | "boundNotAbsence">;
  assertMachineSource(row: Machine): void;
  resourceReceipt(row: Machine): Promise<ModalResourceReceipt>;
  collectImages: ReturnType<typeof createImageCollection>["collectImages"];
  detachCollection(work: () => Promise<void>): void;
  cleanupSleep: ((milliseconds: number) => Promise<void>) | undefined;
}) {
  const {
    client,
    store,
    runner,
    distribution,
    bound,
    physicalLifecycle: { physical, namedOwned, boundNotAbsence },
    assertMachineSource,
    resourceReceipt,
    collectImages,
    detachCollection,
    cleanupSleep,
  } = deps;

  async function checkpoint(row: Machine, save: (row: Machine) => Promise<void>) {
    const result = await runner.call<{ watermark: number; acknowledgedSequence: number; generation: string }>(
      row,
      "checkpoint",
      {},
    );
    if (
      result.generation !== String(row.generation) ||
      !Number.isSafeInteger(result.watermark) ||
      result.watermark < 0 ||
      result.acknowledgedSequence !== result.watermark ||
      (await store.watermark(row.info.id, row.generation)) !== result.watermark
    )
      throw refusal("conflict", "Checkpoint lacks a matching durably acknowledged event watermark; source retained.");
    row.checkpointWatermark = result.watermark;
    await save(row);
  }
  async function stopLeased(row: Machine, save: (row: Machine) => Promise<void>) {
    if (row.phase === "stopped") return;
    if (row.commonRuntime) {
      assertMachineSource(row);
      if (!row.physicalId && row.phase !== "reserved") {
        const reconciled = await namedOwned(row);
        row.physicalId = reconciled.sandboxId;
        await save(row);
      }
      if (row.recoveryImageId) row.retainedRecoveryIds = [...(row.retainedRecoveryIds ?? []), row.recoveryImageId];
      delete row.recoveryImageId;
      delete row.runtimeCheckpoint;
      row.phase = "terminate";
      row.info.state = "stopping";
      await save(row);
      if (row.physicalId) {
        const sb = await physical(row);
        await sb.terminate({ wait: true });
        if ((await sb.poll()) === null) throw refusal("unavailable", "Termination has not completed.");
      }
      row.phase = "stopped";
      row.info.state = "stopped";
      row.info.providerState = "stopped";
      row.info.stoppedAt = new Date();
      await save(row);
      return;
    }
    const sb = await physical(row);
    if (row.phase !== "terminate") {
      if (!["active", "checkpoint"].includes(row.phase))
        throw refusal("conflict", "Snapshot outcome unknown; source retained for reconciliation.");
      row.phase = "checkpoint";
      row.info.state = "stopping";
      await save(row);
      if (!row.quiesced) {
        await lifecycleStep("modal_checkpoint_runner", () => checkpoint(row, save));
        await lifecycleStep("modal_checkpoint_scrub", () => distribution.prepareSnapshot(sb, row));
        row.quiesced = true;
      }
      row.phase = "snapshot";
      await save(row);
      const image = await lifecycleStep("modal_checkpoint_snapshot", () => sb.snapshotFilesystem({ ttlMs: null }));
      if (row.recoveryImageId) row.retainedRecoveryIds = [...(row.retainedRecoveryIds ?? []), row.recoveryImageId];
      row.recoveryImageId = image.imageId;
      row.phase = "terminate";
      await save(row);
    }
    await lifecycleStep("modal_checkpoint_terminate", () => sb.terminate({ wait: true }));
    if ((await sb.poll()) === null) throw refusal("unavailable", "Termination has not completed.");
    row.phase = "stopped";
    row.info.state = "stopped";
    row.info.providerState = "stopped";
    row.info.stoppedAt = new Date();
    await save(row);
  }

  async function cleanupStep(sandboxId: string, step: () => Promise<void>) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await step();
      } catch (error) {
        const safe = modalError(error);
        const delay = CLEANUP_RETRY_MS[attempt - 1];
        console.warn(
          JSON.stringify({
            event: "modal_delete_image_cleanup_failed",
            sandboxId,
            attempt,
            code: safe.code,
            ...(safe.providerCode ? { providerCode: safe.providerCode } : {}),
            retrying: delay !== undefined,
          }),
        );
        if (delay === undefined) throw error;
        await (cleanupSleep ?? Bun.sleep)(delay);
      }
    }
  }
  const operations = {
    async stop({ sandboxId, requireRetention = false }) {
      await bound();
      let observed: Machine | undefined;
      try {
        await store.lease(sandboxId, async (row, save) => {
          observed = row;
          if (
            requireRetention &&
            (row.commonRuntime ||
              row.info.stopNote === "checkpoint_failed_disk_not_retained" ||
              (row.phase === "terminate" && !row.recoveryImageId))
          )
            throw refusal(
              "conflict",
              "Retained workspace is not proven; automatic idle stop refuses compute-only cleanup.",
            );
          if (!row.golden && row.phase !== "stopped") {
            if (row.ordinaryStopAttempted && row.phase !== "terminate" && !requireRetention) {
              row.info.stopNote = "checkpoint_failed_disk_not_retained";
              if (row.recoveryImageId)
                row.retainedRecoveryIds = [...(row.retainedRecoveryIds ?? []), row.recoveryImageId];
              delete row.recoveryImageId;
              row.phase = "terminate";
              await save(row);
            } else {
              row.ordinaryStopAttempted = true;
              await save(row);
            }
          }
          await stopLeased(row, save);
        });
      } catch (error) {
        if (observed) throw new ModalOperationError(error, await resourceReceipt(observed));
        throw error;
      }
    },
    async delete({ sandboxId }) {
      await boundNotAbsence();
      await store.lease(sandboxId, async (row, save) => {
        if (row.phase === "deleted") return;
        assertMachineSource(row);
        if (row.phase === "stopped" || (row.phase === "reserved" && !row.physicalId))
          row.deletePhysicalExitGeneration = row.generation;
        const exitConfirmed = row.deletePhysicalExitGeneration === row.generation;
        if (!exitConfirmed && !row.physicalId) {
          const reconciled = await namedOwned(row);
          row.physicalId = reconciled.sandboxId;
          await save(row);
        }
        row.phase = "deleting";
        await save(row);
        if (!exitConfirmed && row.physicalId) {
          await boundNotAbsence();
          try {
            const sb = await client.sandboxes.fromId(row.physicalId);
            await sb.terminate({ wait: true });
            if ((await sb.poll()) === null)
              throw refusal("unavailable", "Owned machine termination is not complete; delete remains pending.");
          } catch (error) {
            if (modalError(error).code !== "not_found") throw error;
          }
          row.deletePhysicalExitGeneration = row.generation;
          await save(row);
        }
        for (const imageId of new Set([
          ...(row.retainedRecoveryIds ?? []),
          ...(row.recoveryImageId ? [row.recoveryImageId] : []),
        ])) {
          await cleanupStep(sandboxId, async () => {
            try {
              await client.images.delete(imageId);
            } catch (error) {
              if (modalError(error).code !== "not_found") throw error;
            }
          });
        }
        row.phase = "deleted";
        await save(row);
      });
      detachCollection(() =>
        collectImages().catch((error) => {
          const safe = modalError(error);
          console.warn(
            JSON.stringify({
              event: "modal_delete_retired_collection_deferred",
              sandboxId,
              code: safe.code,
              ...(safe.providerCode ? { providerCode: safe.providerCode } : {}),
            }),
          );
        }),
      );
      return { status: "deleted" };
    },
  } satisfies Pick<Provider, "stop" | "delete">;
  return { checkpoint, ...operations };
}
