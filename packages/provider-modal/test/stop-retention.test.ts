import { expect, test } from "bun:test";
import type { ModalClient } from "modal";
import {
  createModalProvider,
  type Machine,
  type ModalStore,
  type RunnerDistribution,
  type SavedImage,
  type Scope,
  settleDetachedModalCollections,
} from "../src/index.ts";

/** Stop-policy boundary: real adapter, injected persistence/SDK ports; no SQL startup. */
function fixture(stage: "scrub" | "snapshot", { productionDetach = false } = {}) {
  const scope: Scope = {
    orgId: "org",
    userId: "owner",
    visibility: "private",
    binding: { workspace: "workspace", environment: "main", appId: "app" },
  };
  let stored: Machine = {
    info: { id: "logical", name: "worker", state: "running", providerState: "active", labels: {} },
    generation: 1,
    phase: "active",
    physicalId: "physical",
    physicalName: "owned-worker",
    golden: false,
    ttlSeconds: 3600,
    managementAuthority: { credentialScope: "user", credentialOwnerId: "owner" },
    recoveryImageId: "prior-recovery",
  };
  let failing = true,
    terminated = 0,
    snapshots = 0;
  let rejectImageDelete = false;
  const deniedImages = new Set<string>();
  const heldImages = new Map<string, { entered: () => void; released: Promise<void> }>();
  const deletedImages: string[] = [];
  const cleanupDelays: number[] = [];
  let images: SavedImage[] = [];
  const store = {
    get: async () => structuredClone(stored),
    lease: async <T>(
      _id: string,
      work: (row: Machine, save: (value: Machine) => Promise<void>) => Promise<T>,
    ): Promise<T> =>
      work(structuredClone(stored), async (value) => {
        stored = structuredClone(value);
      }),
    saveImage: async (image: SavedImage) => {
      images = [...images.filter((x) => x.info.name !== image.info.name), structuredClone(image)];
    },
    images: async () => structuredClone(images),
    purgeImage: async (name: string) => {
      images = images.filter((x) => x.info.name !== name || !x.deleted);
    },
    claimImage: async (name: string) => {
      images = images.map((x) => (x.info.name === name && x.deleted ? { ...x, collecting: true } : x));
    },
    imageReferenced: async () => false,
    tombstoneSources: async () => (images.some((x) => x.deleted) ? [stored.info.id] : []),
    watermark: async () => 1,
  } as unknown as ModalStore;
  const sandbox = {
    snapshotFilesystem: async () => {
      snapshots++;
      if (failing && stage === "snapshot") throw Error("snapshot outcome unknown");
      return { imageId: "fresh-recovery" };
    },
    terminate: async () => {
      if (terminated) throw Error("terminated machine is unavailable for another stop");
      terminated++;
    },
    poll: async () => (terminated ? 0 : null),
  };
  let appLookups = 0,
    missingAppAt = 0;
  const client = {
    apps: {
      fromName: async () => {
        if (++appLookups === missingAppAt) throw Object.assign(Error("app missing"), { name: "NotFoundError" });
        return { appId: "app" };
      },
    },
    sandboxes: { fromId: async () => sandbox },
    images: {
      delete: async (id: string) => {
        const held = heldImages.get(id);
        if (held) {
          held.entered();
          await held.released;
        }
        if (rejectImageDelete) {
          rejectImageDelete = false;
          throw Object.assign(new Error("image cleanup unavailable"), { name: "TimeoutError" });
        }
        if (deniedImages.has(id))
          throw Object.assign(new Error("permission denied"), { name: "PermissionDeniedError" });
        deletedImages.push(id);
      },
    },
  } as unknown as ModalClient;
  const distribution = {
    capabilities: {},
    prepareSnapshot: async () => {
      if (failing && stage === "scrub") throw Error("scrub refused");
    },
  } as unknown as RunnerDistribution;
  const detached: (() => Promise<void>)[] = [];
  const provider = createModalProvider({
    scope,
    appName: "bound",
    client,
    store,
    distribution,
    runner: { call: async <T>() => ({ generation: "1", watermark: 1, acknowledgedSequence: 1 }) as T },
    cleanupSleep: async (milliseconds) => {
      cleanupDelays.push(milliseconds);
    },
    ...(productionDetach
      ? {}
      : {
          detachCollection: (work: () => Promise<void>) => {
            detached.push(work);
          },
        }),
  });
  return {
    provider,
    state: () => stored,
    snapshots: () => snapshots,
    terminated: () => terminated,
    deletedImages,
    cleanupDelays,
    runDetached: async () => {
      for (let work = detached.shift(); work; work = detached.shift()) await work();
    },
    images: () => images,
    missAppOnLookup: (lookup: number) => {
      missingAppAt = appLookups + lookup;
    },
    rejectNextImageDelete: () => {
      rejectImageDelete = true;
    },
    holdImageDelete: (imageId: string) => {
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      heldImages.set(imageId, { entered: entered.resolve, released: released.promise });
      return { entered: entered.promise, release: released.resolve };
    },
    retireImage: (imageId: string, { denied }: { denied: boolean }) => {
      if (!images.some((x) => x.imageId === imageId))
        images.push({
          info: { name: `retired-${imageId}` } as SavedImage["info"],
          imageId,
          sourceId: stored.info.id,
          managementAuthority: { credentialScope: "user", credentialOwnerId: "owner" },
          deleted: true,
        });
      if (denied) deniedImages.add(imageId);
      else deniedImages.delete(imageId);
    },
    recover: () => {
      failing = false;
    },
  };
}

test("a confirmed Modal stop is deleted without another termination, even across an image timeout", async () => {
  const f = fixture("snapshot");
  f.recover();
  await f.provider.stop({ sandboxId: "logical" });
  f.rejectNextImageDelete();
  // The transient timeout is retried inside the same delete.
  await expect(f.provider.delete({ sandboxId: "logical" })).resolves.toEqual({ status: "deleted" });
  expect(f.cleanupDelays).toEqual([1_000]);
  expect(f.state().phase).toBe("deleted");
  expect(f.terminated()).toBe(1);
  expect(f.deletedImages).toEqual(["prior-recovery", "fresh-recovery"]);
});

test("a missing App during termination never publishes deletion of a live machine", async () => {
  const f = fixture("snapshot");
  // The first lookup admits the delete; the one before termination finds no App.
  f.missAppOnLookup(2);
  await expect(f.provider.delete({ sandboxId: "logical" })).rejects.toMatchObject({ code: "unavailable" });
  expect(f.state().phase).toBe("deleting");
  expect(f.state().deletePhysicalExitGeneration).toBeUndefined();
  expect(f.terminated()).toBe(0);
  expect(f.deletedImages).toEqual([]);
  await expect(f.provider.delete({ sandboxId: "logical" })).resolves.toEqual({ status: "deleted" });
  expect(f.terminated()).toBe(1);
});

test("a missing App during name reconciliation never publishes deletion of an unknown create", async () => {
  const f = fixture("snapshot");
  // The create response was lost: no physical ID, outcome unknown.
  f.state().phase = "creating";
  delete f.state().physicalId;
  // The first lookup admits the delete; the one inside name reconciliation finds no App.
  f.missAppOnLookup(2);
  await expect(f.provider.delete({ sandboxId: "logical" })).rejects.toMatchObject({ code: "unavailable" });
  expect(f.state().phase).toBe("creating");
  expect(f.state().physicalId).toBeUndefined();
  expect(f.terminated()).toBe(0);
  expect(f.deletedImages).toEqual([]);
});

test("a failing retired image never withholds the receipt of a completed delete", async () => {
  const f = fixture("snapshot");
  f.recover();
  await f.provider.stop({ sandboxId: "logical" });
  f.retireImage("retired-elsewhere", { denied: true });
  await expect(f.provider.delete({ sandboxId: "logical" })).resolves.toEqual({ status: "deleted" });
  expect(f.state().phase).toBe("deleted");
  // The detached collection fails once on the denied image; the receipt was already published.
  await f.runDetached();
  expect(f.deletedImages).toEqual(["prior-recovery", "fresh-recovery"]);
  // Another source's failure is not retried inside this delete.
  expect(f.cleanupDelays).toEqual([]);
  // The tombstone keeps its durable retry record for the next collection in scope.
  expect(
    f
      .images()
      .filter((x) => x.deleted)
      .map((x) => x.imageId),
  ).toEqual(["retired-elsewhere"]);
  f.retireImage("retired-elsewhere", { denied: false });
  await f.provider.collectGarbage();
  expect(f.deletedImages).toContain("retired-elsewhere");
});

test.each(["scrub", "snapshot"] as const)(
  "retention-required idle stop never discards workspace after %s failure",
  async (stage) => {
    const f = fixture(stage);
    await expect(f.provider.stop({ sandboxId: "logical", requireRetention: true })).rejects.toThrow();
    await expect(f.provider.stop({ sandboxId: "logical", requireRetention: true })).rejects.toThrow();
    expect(f.terminated()).toBe(0);
    expect(f.state().phase).toBe(stage === "scrub" ? "checkpoint" : "snapshot");
    expect(f.state().recoveryImageId).toBe("prior-recovery");
    expect(f.state().info.stopNote).toBeUndefined();
    expect(f.snapshots()).toBe(stage === "snapshot" ? 1 : 0);
    if (stage === "scrub") {
      f.recover();
      await f.provider.stop({ sandboxId: "logical", requireRetention: true });
      expect(f.terminated()).toBe(1);
      expect(f.state().phase).toBe("stopped");
      expect(f.state().recoveryImageId).toBe("fresh-recovery");
      expect(f.state().info.stopNote).toBeUndefined();
    }
  },
);

test.each(["common-runtime", "lost-workspace", "unretained-terminate"] as const)(
  "retention policy refuses compute-only state (%s)",
  async (mode) => {
    const f = fixture("snapshot");
    if (mode === "common-runtime") f.state().commonRuntime = true;
    if (mode === "lost-workspace") f.state().info.stopNote = "checkpoint_failed_disk_not_retained";
    if (mode === "unretained-terminate") {
      f.state().phase = "terminate";
      delete f.state().recoveryImageId;
    }
    await expect(f.provider.stop({ sandboxId: "logical", requireRetention: true })).rejects.toThrow();
    expect(f.terminated()).toBe(0);
    expect(f.snapshots()).toBe(0);
  },
);

test("server shutdown settles a detached retired-image collection before SQL closes", async () => {
  const f = fixture("snapshot", { productionDetach: true });
  f.recover();
  await f.provider.stop({ sandboxId: "logical" });
  f.retireImage("retired-elsewhere", { denied: false });
  const held = f.holdImageDelete("retired-elsewhere");
  await expect(f.provider.delete({ sandboxId: "logical" })).resolves.toEqual({ status: "deleted" });
  await held.entered;
  let settled = false;
  const settling = settleDetachedModalCollections().then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  held.release();
  await settling;
  expect(f.deletedImages).toContain("retired-elsewhere");
  expect(f.images().filter((x) => x.deleted)).toEqual([]);
});
