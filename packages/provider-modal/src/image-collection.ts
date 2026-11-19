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
/** Settles every detached retired-image collection. The server awaits this before closing SQL,
 * so shutdown never interrupts a claim or purge mid-collection. */
export async function settleDetachedModalCollections(): Promise<void> {
  while (detachedCollections.size) await Promise.allSettled([...detachedCollections]);
}
export function createImageCollection(
  client: Pick<ModalClient, "images">,
  store: ModalStore,
  managementAuthority: ModalManagementProvenance,
  detachCollection: (work: () => Promise<void>) => void,
) {
  /** Collects retired images in scope, or only the tombstone `name` when given. Every image is
   * attempted: one failing image never blocks another, and the first failure is rethrown last. */
  async function collectImages(skipBusy = false, sources?: string[], name?: string) {
    let failure: { error: unknown } | undefined;
    // Visit only sources with retired images. Every scope machine ever launched stays in the
    // store, so a full scan made each sandbox deletion cost minutes of SQL round trips.
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
      // Lease a source only to claim a tombstone that can be removed now. A tombstone still
      // referenced by a live machine stays put, and leasing its source for nothing would refuse
      // that source's own lifecycle requests. The lease re-checks every condition before a claim.
      let claimable = false;
      for (const image of await retired())
        if (!image.collecting && !(await store.imageReferenced(image.imageId))) {
          claimable = true;
          break;
        }
      if (claimable) {
        const claim = store.lease(source.info.id, async () => {
          for (const image of await retired())
            if (!image.collecting && !(await store.imageReferenced(image.imageId)))
              await store.claimImage(image.info.name, image.sourceId, image.imageId);
        });
        // Another controller owns this source now (a golden prompt, snapshot, restore or a
        // concurrent delete). Its tombstones stay durable for the next collection in scope.
        await (skipBusy
          ? claim.catch((error) => {
              if (modalError(error).providerCode !== "lifecycle_lease_busy") throw error;
            })
          : claim);
      }
      // The source lease is released before any remote call: a slow or failing image deletion
      // never refuses the source's own lifecycle (delete, snapshot, fork). A claim survives a
      // failure or crash and is retried by the next collection in scope, again without the lease.
      // Only the holder of the exclusive dispatch claim issues the RPC: a concurrent sweep skips a
      // live claim instead of multiplying deletions of the same physical image.
      for (const image of await retired()) {
        if (!image.collecting || (await store.imageReferenced(image.imageId))) continue;
        const token = randomUUID();
        if (!(await store.takeImage(image.info.name, image.sourceId, image.imageId, token))) continue;
        try {
          await client.images.delete(image.imageId);
        } catch (error) {
          if (modalError(error).code !== "not_found") {
            failure ??= { error };
            // Best-effort: an unreleased claim expires, and must not stop the remaining images.
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
  /** After a tombstone is committed, the retirement has succeeded: nothing after it may fail the
   * call. Its own image is collected best-effort now (the retirement worker retries it through
   * collectRetiredSnapshot); other retired images are collected detached, once. */
  async function collectAfterRetirement(snapshot: string, sourceId?: string) {
    await collectImages(true, sourceId ? [sourceId] : undefined, snapshot).catch(logDeferredCollection({ snapshot }));
    detachCollection(() => collectImages(true).catch(logDeferredCollection({ snapshot, scope: "unrelated" })));
  }
  async function collectRetiredSnapshot(name: string): Promise<"collected" | "pending"> {
    const owner = async () => {
      for (const sourceId of await store.tombstoneSources())
        if ((await store.images(sourceId)).some((image) => image.deleted && image.info.name === name)) return sourceId;
    };
    const sourceId = await owner();
    if (!sourceId) return "collected";
    // Only this snapshot's own tombstone, for both claim and deletion: another retired image,
    // of this source or another, never blocks it. A busy source is skipped, not failed: the
    // caller (the retirement worker) retries later.
    await collectImages(true, [sourceId], name);
    return (await owner()) ? "pending" : "collected";
  }
  return { collectAfterRetirement, collectImages, collectRetiredSnapshot };
}
