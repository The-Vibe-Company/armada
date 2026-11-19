import { ProviderError } from "@armada/core";
import { modalError, refusal } from "./errors.ts";
import type { createImageCollection } from "./image-collection.ts";
import type { ModalManagementProvenance, ModalStore, SavedImage } from "./ports.ts";

export function createSnapshotTombstones(
  store: ModalStore,
  canMutateSnapshotScope: boolean,
  snapshotBackend: () => Promise<void>,
  assertAuthority: (record: { managementAuthority?: ModalManagementProvenance }) => void,
  {
    collectAfterRetirement,
    collectRetiredSnapshot,
  }: Pick<ReturnType<typeof createImageCollection>, "collectAfterRetirement" | "collectRetiredSnapshot">,
) {
  return {
    async deleteSnapshot(name: string) {
      if (!canMutateSnapshotScope)
        throw refusal(
          "forbidden",
          "Snapshot mutation requires the golden-source provider scope, not a private-fork adapter.",
        );
      await snapshotBackend();
      let image: SavedImage;
      try {
        image = await store.image(name);
        assertAuthority(image);
      } catch (error) {
        if (modalError(error).code !== "not_found") throw error;
        await collectAfterRetirement(name);
        return;
      }
      let sourceLeaseAcquired = false;
      try {
        await store.lease(image.sourceId, async () => {
          sourceLeaseAcquired = true;
          const current = await store.image(name);
          await store.removeImage(current.info.name);
        });
      } catch (error) {
        if (!sourceLeaseAcquired && modalError(error).providerCode === "lifecycle_lease_busy")
          throw new ProviderError({
            provider: "modal",
            code: "conflict",
            providerCode: "snapshot_source_busy",
            message:
              "The Modal snapshot source is busy. The snapshot was not deleted; retry after the current operation.",
            retryable: true,
          });
        throw error;
      }
      await collectAfterRetirement(name, image.sourceId);
    },
    async collectRetiredSnapshot(name: string) {
      if (!canMutateSnapshotScope)
        throw refusal(
          "forbidden",
          "Snapshot collection requires the golden-source provider scope, not a private-fork adapter.",
        );
      await snapshotBackend();
      return collectRetiredSnapshot(name);
    },
  };
}
