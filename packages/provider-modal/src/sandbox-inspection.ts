import type { Provider } from "@armada/core";
import type { ModalClient } from "modal";
import { refusal } from "./errors.ts";
import { lookupModalCompute, observeModalCompute } from "./machine.ts";
import type { Machine, ModalResourceReceipt, ModalStore, Scope } from "./ports.ts";

interface SandboxInspectionOptions {
  store: ModalStore;
  client: Pick<ModalClient, "sandboxes">;
  bound(): Promise<unknown>;
  assertMachineSource(row: Machine): void;
  scope: Scope;
  appName: string;
  storedReads: boolean;
}

export function createSandboxInspection({
  store,
  client,
  bound,
  assertMachineSource,
  scope,
  appName,
  storedReads,
}: SandboxInspectionOptions) {
  function sandboxInfo(row: Machine) {
    const { physicalGeneration: _ignored, ...info } = row.info;
    return { ...info, ...(row.physicalId ? { physicalGeneration: String(row.generation) } : {}) };
  }
  async function resourceReceipt(observed: Machine) {
    const durable = await store.get(observed.info.id).catch(() => undefined);
    const row = durable ?? observed;
    const images = await store.images(row.info.id).catch(() => []);
    const snapshots = [
      ...(row.snapshotImages ?? []),
      ...(observed.snapshotImages ?? []),
      ...images.flatMap((x) => (x.imageId ? [{ name: x.info.name, imageId: x.imageId }] : [])),
    ];
    const snapshotImages = [
      ...new Map(snapshots.map((x) => [`${x.name}:${x.imageId}`, { name: x.name, imageId: x.imageId }])).values(),
    ];
    const physicalId = row.physicalId ?? observed.physicalId,
      imageId = row.imageId ?? observed.imageId;
    return {
      sandboxId: row.info.id,
      phase: row.phase,
      observedPhase: observed.phase,
      registryConfirmed: !!durable,
      generation: row.generation,
      physicalName: row.physicalName,
      ...(physicalId ? { physicalId } : {}),
      ...(imageId ? { imageId } : {}),
      recoveryImageIds: [
        ...new Set([
          ...(row.retainedRecoveryIds ?? []),
          ...(observed.retainedRecoveryIds ?? []),
          ...(row.recoveryImageId ? [row.recoveryImageId] : []),
          ...(observed.recoveryImageId ? [observed.recoveryImageId] : []),
        ]),
      ],
      snapshotImages,
      ...(row.sourceImage ? { sourceImage: { ...row.sourceImage } } : {}),
      ...(row.managementAuthority ? { managementAuthority: { ...row.managementAuthority } } : {}),
      binding: { ...scope.binding },
      appName,
    } satisfies ModalResourceReceipt;
  }
  const get: Provider["get"] = async (id) => {
    if (!storedReads) await bound();
    const row = await store.get(id);
    assertMachineSource(row);
    if (row.phase === "deleted") throw refusal("not_found", "Sandbox was deleted.");
    let exited = false;
    if (row.phase === "active" && !storedReads) {
      if (!row.physicalId) throw refusal("sandbox_not_ready", "No current physical machine.");
      const observation = await observeModalCompute(
        { sandboxId: id, generation: row.generation, machineId: row.physicalId },
        await lookupModalCompute(client, row.physicalId),
      );
      exited = observation.phase === "stopped";
    }
    if (exited)
      return {
        ...sandboxInfo(row),
        state: "failed",
        providerState: "exited",
        physicalExitConfirmed: true,
        error: "Physical machine exited without a new verified checkpoint.",
      };
    return { ...sandboxInfo(row), providerState: row.phase };
  };
  const inspection = {
    get,
  } satisfies Pick<Provider, "get">;
  return { sandboxInfo, resourceReceipt, inspection };
}
