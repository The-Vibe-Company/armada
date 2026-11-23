import type { Provider, SnapshotInfo } from "@armada/core";
import type { boundModalApp } from "./client.ts";
import { ModalOperationError, refusal } from "./errors.ts";
import type { createPhysicalLifecycle } from "./physical-lifecycle.ts";
import type {
  Machine,
  ModalManagementProvenance,
  ModalResourceReceipt,
  ModalStore,
  RunnerDistribution,
} from "./ports.ts";

export function createSnapshotLifecycle({
  store,
  sourceStore,
  managementAuthority,
  bound,
  snapshotBackend,
  assertAuthority,
  assertMachineSource,
  physical,
  distribution,
  resourceReceipt,
}: {
  store: ModalStore;
  sourceStore: ModalStore;
  managementAuthority: ModalManagementProvenance;
  bound: () => ReturnType<typeof boundModalApp>;
  snapshotBackend(): Promise<void>;
  assertAuthority(record: { managementAuthority?: ModalManagementProvenance }): void;
  assertMachineSource(row: Machine): void;
  physical: ReturnType<typeof createPhysicalLifecycle>["physical"];
  distribution: Pick<RunnerDistribution, "prepareSnapshot">;
  resourceReceipt(row: Machine): Promise<ModalResourceReceipt>;
}) {
  return {
    async snapshot(r) {
      await bound();
      let observed: Machine | undefined;
      try {
        return await store.lease(r.sandboxId, async (row, save) => {
          observed = row;
          assertMachineSource(row);
          if (!row.golden || row.phase !== "active")
            throw refusal("conflict", "Only active credential-free builders can become golden snapshots.");
          try {
            await store.image(r.name);
            throw refusal("conflict", "Snapshot name is immutable.");
          } catch (e) {
            if (!(e instanceof Error && "code" in e && e.code === "not_found")) throw e;
          }
          const info: SnapshotInfo = {
            name: r.name,
            status: "saving",
            sourceSandboxId: r.sandboxId,
            managementAuthority: {
              scope: managementAuthority.credentialScope,
              ownerId: managementAuthority.credentialOwnerId,
            },
            createdAt: new Date(),
          };
          await store.saveImage({ info, sourceId: r.sandboxId, managementAuthority: { ...managementAuthority } });
          const sb = await physical(row);
          row.phase = "checkpoint";
          row.info.state = "stopping";
          await save(row);
          await distribution.prepareSnapshot(sb, row);
          row.quiesced = true;
          row.phase = "snapshot";
          await save(row);
          const image = await sb.snapshotFilesystem({ ttlMs: null });
          row.snapshotImages = [...(row.snapshotImages ?? []), { name: r.name, imageId: image.imageId }];
          await save(row);
          info.status = "ready";
          info.artifactId = image.imageId;
          await store.saveImage({
            info,
            sourceId: r.sandboxId,
            imageId: image.imageId,
            goldenClean: true,
            managementAuthority: { ...managementAuthority },
          });
          row.phase = "checkpoint";
          row.info.state = "stopping";
          await save(row);
          return info;
        });
      } catch (error) {
        if (observed) throw new ModalOperationError(error, await resourceReceipt(observed));
        throw error;
      }
    },
    async getSnapshot(name) {
      await snapshotBackend();
      const image = await sourceStore.image(name);
      assertAuthority(image);
      const { artifactId: _artifact, managementAuthority: _authority, sourceSandboxId: _source, ...info } = image.info;
      return {
        ...info,
        sourceSandboxId: image.sourceId,
        ...(image.imageId ? { artifactId: image.imageId } : {}),
        ...(image.managementAuthority
          ? {
              managementAuthority: {
                scope: image.managementAuthority.credentialScope,
                ownerId: image.managementAuthority.credentialOwnerId,
              },
            }
          : {}),
      };
    },
  } satisfies Pick<Provider, "snapshot" | "getSnapshot">;
}
