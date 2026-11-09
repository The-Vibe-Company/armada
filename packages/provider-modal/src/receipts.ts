import type { ModalResourceReceipt } from "./ports.ts";

/** Keep every observed Image/physical reference when a later durable read lacks a failed commit's
 * metadata. Only receipt fields are exported; no upstream error/request object is merged. */
export function mergeModalResourceReceipts(receipts: readonly ModalResourceReceipt[]): ModalResourceReceipt[] {
  const merged = new Map<string, ModalResourceReceipt>();
  for (const current of receipts) {
    const key = JSON.stringify([
      current.binding.workspace,
      current.binding.environment,
      current.binding.appId,
      current.sandboxId,
    ]);
    const old = merged.get(key);
    const physicalId = current.physicalId ?? old?.physicalId,
      imageId = current.imageId ?? old?.imageId;
    const sourceImage = current.sourceImage ?? old?.sourceImage,
      authority = current.managementAuthority ?? old?.managementAuthority;
    const snapshots = [...(old?.snapshotImages ?? []), ...current.snapshotImages];
    merged.set(key, {
      sandboxId: current.sandboxId,
      phase: current.phase,
      observedPhase: current.observedPhase,
      registryConfirmed: current.registryConfirmed,
      generation: current.generation,
      physicalName: current.physicalName,
      ...(physicalId ? { physicalId } : {}),
      ...(imageId ? { imageId } : {}),
      recoveryImageIds: [...new Set([...(old?.recoveryImageIds ?? []), ...current.recoveryImageIds])],
      snapshotImages: [
        ...new Map(snapshots.map((x) => [`${x.name}:${x.imageId}`, { name: x.name, imageId: x.imageId }])).values(),
      ],
      ...(sourceImage ? { sourceImage: { ...sourceImage } } : {}),
      ...(authority ? { managementAuthority: { ...authority } } : {}),
      binding: { ...current.binding },
      appName: current.appName,
    });
  }
  return [...merged.values()];
}
