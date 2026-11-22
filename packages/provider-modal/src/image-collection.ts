import { randomUUID } from "node:crypto";
import type { ModalClient } from "modal";
import { matchesManagementAuthority } from "./authority.ts";
import { modalError } from "./errors.ts";
import type { ModalManagementProvenance, ModalStore, SavedImage } from "./ports.ts";

const detachedCollections = new Set<Promise<void>>();
export function trackDetachedCollection(work: () => Promise<void>) {
  const run = work().finally(() => detachedCollections.delete(run));
  detachedCollections.add(run);
}
export async function settleDetachedModalCollections() {
  while (detachedCollections.size) await Promise.allSettled([...detachedCollections]);
}
export function createImageCollection(
  client: Pick<ModalClient, "images">,
  store: ModalStore,
  managementAuthority: ModalManagementProvenance,
  detachCollection: (work: () => Promise<void>) => void,
) {
  async function collectImages(sources?: string[], name?: string) {
    let failure: { error: unknown } | undefined;
    for (const sourceId of sources ?? (await store.tombstoneSources())) {
      const source = await store.get(sourceId);
      if (!matchesManagementAuthority(source.managementAuthority, managementAuthority)) continue;
      const retired = async () =>
        (await store.images(source.info.id)).filter(
          (x): x is SavedImage & { imageId: string } =>
            Boolean(x.deleted && x.imageId) &&
            (name === undefined || x.info.name === name) &&
            matchesManagementAuthority(x.managementAuthority, managementAuthority),
        );
      let claimable = false;
      for (const image of await retired())
        if (!image.collecting && !(await store.imageReferenced(image.imageId))) {
          claimable = true;
          break;
        }
      if (claimable) {
        await store
          .lease(source.info.id, async () => {
            for (const image of await retired())
              if (!image.collecting && !(await store.imageReferenced(image.imageId)))
                await store.claimImage(image.info.name, image.sourceId, image.imageId);
          })
          .catch((error) => {
            if (modalError(error).providerCode !== "lifecycle_lease_busy") throw error;
          });
      }
      for (const image of await retired()) {
        if (!image.collecting || (await store.imageReferenced(image.imageId))) continue;
        const token = randomUUID();
        if (!(await store.takeImage(image.info.name, image.sourceId, image.imageId, token))) continue;
        try {
          await client.images.delete(image.imageId);
        } catch (error) {
          if (modalError(error).code !== "not_found") {
            failure ??= { error };
            await store.releaseImage(image.info.name, image.sourceId, image.imageId, token).catch(() => {});
            continue;
          }
        }
        await store.purgeImage(image.info.name, image.sourceId, image.imageId);
      }
    }
    if (failure) throw failure.error;
  }
  function logDeferredCollection(context: Record<string, string>) {
    return (error: unknown) => {
      const safe = modalError(error);
      console.warn(
        JSON.stringify({
          event: "modal_retired_collection_deferred",
          ...context,
          code: safe.code,
          ...(safe.providerCode ? { providerCode: safe.providerCode } : {}),
        }),
      );
    };
  }
  async function collectAfterRetirement(snapshot: string, sourceId?: string) {
    await collectImages(sourceId ? [sourceId] : undefined, snapshot).catch(logDeferredCollection({ snapshot }));
    detachCollection(() => collectImages().catch(logDeferredCollection({ snapshot, scope: "unrelated" })));
  }
  async function collectRetiredSnapshot(name: string) {
    const owner = async () => {
      for (const sourceId of await store.tombstoneSources())
        if ((await store.images(sourceId)).some((image) => image.deleted && image.info.name === name)) return sourceId;
    };
    const sourceId = await owner();
    if (!sourceId) return "collected" as const;
    await collectImages([sourceId], name);
    return (await owner()) ? ("pending" as const) : ("collected" as const);
  }
  return { collectAfterRetirement, collectImages, collectRetiredSnapshot };
}
