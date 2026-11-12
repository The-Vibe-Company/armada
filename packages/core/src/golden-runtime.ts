import { boatSnapshotName } from "./boat-snapshot-name.ts";
import {
  assertGoldenMutation,
  connectGolden,
  type GoldenActor,
  type GoldenLimits,
  type GoldenRecord,
  type GoldenStore,
  goldenForSettings,
  providerIdOf,
  type SnapshottedGolden,
  waitSnapshot,
} from "./golden.ts";
import { GoldenError } from "./golden-config.ts";
import { isNonMutatingProviderRefusal, type Provider, ProviderError } from "./provider.ts";
import { HOST_CAPABILITIES } from "./sandbox-provider.ts";

/**
 * Boat keeps its stable replacement name. Modal saves a new immutable version per attempt;
 * only the provider's verified ready reference can replace the last-good SQL pointer.
 */
export async function snapshotGolden(
  provider: Provider,
  store: GoldenStore,
  actor: GoldenActor,
  name: string,
  limits: GoldenLimits = {},
): Promise<SnapshottedGolden> {
  let golden = await goldenForSettings(store, actor, name, providerIdOf(provider));
  assertGoldenMutation(actor, golden);
  await store.assertMutation?.(golden, actor);
  await store.reconcileOperations?.(golden, actor);
  const releaseOperation = await store.beginOperation?.(golden.id, {
    kind: "snapshot",
    snapshotId: golden.providerSnapshotId,
    sandboxId: golden.providerSandboxId,
  });
  let uncertain = false;
  let failed = false;
  try {
    await store.assertBackendBinding?.(golden, provider);
    const immutablePublication = HOST_CAPABILITIES[golden.provider].goldenSnapshotPublication === "publish-immutable";
    if (immutablePublication) {
      if (!store.compareAndSetSnapshot)
        throw new GoldenError("conflict", "Modal snapshot publication requires a compare-and-swap store.");
      golden = (await connectGolden(provider, store, actor, name, limits)).golden;
    }
    const master = golden.providerSandboxId;
    if (!master) throw new GoldenError("conflict", `Golden '${golden.name}' has no sandbox yet. Create it first.`);
    const requested = immutablePublication
      ? `golden-${golden.id}-${crypto.randomUUID()}`
      : boatSnapshotName({
          orgId: golden.orgId,
          ownerId: golden.ownerId,
          visibility: golden.visibility,
          name: golden.name,
        });
    let actual = requested;
    const retained = (error: unknown): ProviderError =>
      new ProviderError({
        provider: "modal",
        code: error instanceof ProviderError ? error.code : "conflict",
        retryable: false,
        message: `Modal snapshot attempt '${actual}' could not be completed or confirmed. Source ${master} and any attempt artifact are retained; reconcile before retrying or removing either.`,
        details: {
          ...(error instanceof ProviderError && error.details?.resourceReceipt
            ? { resourceReceipt: error.details.resourceReceipt }
            : {}),
          keepSource: true,
          sourceSandboxId: master,
          snapshotId: actual,
        },
      });
    let info: Awaited<ReturnType<Provider["snapshot"]>> | undefined;
    try {
      uncertain = true;
      info = await provider.snapshot({ sandboxId: master, name: requested });
      if (immutablePublication) actual = info.name;
    } catch (error) {
      if (isNonMutatingProviderRefusal(error)) uncertain = false;
      if (immutablePublication) throw retained(error);
      if (!saveInProgress(error)) throw error;
    }
    if (immutablePublication) {
      if (!actual || actual === golden.providerSnapshotId)
        throw new GoldenError("snapshot_failed", "Provider returned an unsafe snapshot reference. Last-good retained.");
      if (info?.sourceSandboxId !== undefined && info.sourceSandboxId !== master)
        throw new GoldenError(
          "snapshot_failed",
          "Snapshot source does not match the authorized master. Last-good retained.",
        );
      if (info?.sourceSandboxId === undefined) {
        try {
          info = await provider.getSnapshot(actual);
        } catch (error) {
          throw retained(error);
        }
      }
      if (info?.name !== actual || info.sourceSandboxId !== master)
        throw new GoldenError("snapshot_failed", "Snapshot source could not be verified. Last-good retained.");
    }
    if (!info || info.status === "saving") {
      try {
        info = await waitSnapshot(provider, actual, limits);
      } catch (error) {
        if (immutablePublication) throw retained(error);
        throw error;
      }
    }
    if (info.status !== "ready") {
      uncertain = false;
      throw new GoldenError("snapshot_failed", info.error ?? `Snapshot of '${golden.name}' failed.`);
    }
    if (immutablePublication && (info.name !== actual || info.sourceSandboxId !== master))
      throw new GoldenError("snapshot_failed", "Ready snapshot source could not be verified. Last-good retained.");
    if (immutablePublication) actual = info.name;
    await releaseOperation?.retain?.({
      kind: "snapshot",
      sandboxId: immutablePublication ? null : master,
      snapshotId: actual,
    });
    if (immutablePublication) {
      try {
        await provider.stop({ sandboxId: master });
      } catch (error) {
        throw retained(error);
      }
      let published: boolean;
      try {
        published = await store.compareAndSetSnapshot!(golden.id, golden.providerSnapshotId, actual, master);
      } catch {
        // A matching read can confirm a winner; a missing/nonmatching read cannot prove rollback.
        let committed: GoldenRecord | undefined;
        try {
          committed = (await store.findByName(actor.orgId, golden.name)).find(
            (row) =>
              row.id === golden.id &&
              row.provider === golden.provider &&
              row.providerSnapshotId === actual &&
              row.providerSandboxId === null,
          );
        } catch {
          /* Unknown outcome: retain everything. */
        }
        if (committed) {
          await store.assertMutation?.(committed, actor);
          uncertain = false;
          return { golden: committed, snapshotName: actual };
        }
        throw retained(new GoldenError("conflict", "Snapshot publication outcome is unknown."));
      }
      uncertain = false;
      if (!published)
        throw new GoldenError(
          "conflict",
          `Golden changed while saving '${actual}'. Source ${master} and immutable Image retained for reconciliation.`,
        );
      return { golden: { ...golden, providerSnapshotId: actual, providerSandboxId: null }, snapshotName: actual };
    }
    if (store.recordSnapshot) {
      const published = await store.recordSnapshot(golden.id, master, actual);
      uncertain = false;
      if (!published) throw new GoldenError("conflict", "The golden changed while snapshotting; retry snapshot.");
    } else await store.setSnapshot(golden.id, actual);
    uncertain = false;
    return { golden: { ...golden, providerSnapshotId: actual }, snapshotName: actual };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (!uncertain)
      await releaseOperation?.().catch((error) => {
        // Preserve an original provider/publication failure if release also loses transport.
        if (!failed) throw error;
      });
  }
}

function saveInProgress(error: unknown): boolean {
  return error instanceof ProviderError && error.code === "conflict" && error.providerCode === "save_in_progress";
}
