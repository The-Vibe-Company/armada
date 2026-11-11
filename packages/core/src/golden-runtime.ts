import { boatSnapshotName } from "./boat-snapshot-name.ts";
import type { Visibility } from "./contract.ts";
import {
  assertGoldenMutation,
  type CreatedGolden,
  connectGolden,
  type GoldenActor,
  type GoldenLimits,
  type GoldenRecord,
  type GoldenStore,
  goldenForSettings,
  providerIdOf,
  type SnapshottedGolden,
  waitReady,
  waitSnapshot,
} from "./golden.ts";
import {
  cloneCommand,
  GOLDEN_BUILD_TTL_SECONDS,
  type GoldenConfig,
  GoldenError,
  initCommand,
  parseGoldenName,
} from "./golden-config.ts";
import { isNonMutatingProviderRefusal, type Provider, ProviderError } from "./provider.ts";
import type { ModalBinding, SandboxProviderId } from "./sandbox-provider.ts";

/**
 * Builds the master sandbox, clones each repo and runs init. Model credentials are not passed:
 * the provider creates the sandbox with no account environment.
 * A retry after a lost sandbox id uses the golden's id as the idempotency key.
 */
export async function createGolden(
  provider: Provider,
  store: GoldenStore,
  actor: GoldenActor,
  input: { name: string; visibility: Visibility; config: GoldenConfig; modal?: ModalBinding },
  limits: GoldenLimits = {},
): Promise<CreatedGolden> {
  const name = parseGoldenName(input.name);
  const providerId = providerIdOf(provider);
  const modal = input.modal ?? null;
  if ((providerId === "modal") !== (modal !== null)) {
    throw new GoldenError(
      "invalid_config",
      providerId === "modal"
        ? "A Modal golden needs its Modal workspace, environment and App pinned."
        : "Only a Modal golden is pinned to a Modal App.",
    );
  }
  if (input.visibility === "org" && actor.role !== "admin") {
    throw new GoldenError(
      "forbidden",
      "Only an admin can create an org golden. Pass --private for one only you can see.",
    );
  }
  const existing = (await store.findByName(actor.orgId, name)).filter(
    (row) => row.visibility === input.visibility && row.provider === providerId,
  );
  const golden = await goldenRow(
    store,
    actor,
    { name, visibility: input.visibility, provider: providerId, modal },
    input.config,
    existing,
  );
  if (golden.providerSandboxId) {
    throw new GoldenError(
      "conflict",
      `Golden '${name}' already exists. Run 'armada golden connect ${name}' or 'armada golden snapshot ${name}'.`,
    );
  }
  const snapshotName = boatSnapshotName({
    orgId: actor.orgId,
    ownerId: actor.userId,
    visibility: input.visibility,
    name,
  });
  const sandbox = await provider.createGolden({
    name,
    ttlSeconds: GOLDEN_BUILD_TTL_SECONDS,
    idempotencyKey: golden.id,
    labels: {
      armada: "golden",
      org: actor.orgId,
      owner: actor.userId,
      visibility: input.visibility,
      golden: name,
      snapshot: snapshotName,
    },
  });
  await store.setSandbox(golden.id, sandbox.id);
  const ready = ["ready", "running"].includes(sandbox.state) ? sandbox : await waitReady(provider, sandbox.id, limits);
  await setup(provider, ready.id, input.config);
  return {
    golden: { ...golden, providerSandboxId: sandbox.id },
    sandboxId: sandbox.id,
    snapshotName,
  };
}

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
    const modal = golden.provider === "modal";
    if (modal) {
      if (!store.compareAndSetSnapshot)
        throw new GoldenError("conflict", "Modal snapshot publication requires a compare-and-swap store.");
      golden = (await connectGolden(provider, store, actor, name, limits)).golden;
    }
    const master = golden.providerSandboxId;
    if (!master) throw new GoldenError("conflict", `Golden '${golden.name}' has no sandbox yet. Create it first.`);
    const requested = modal
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
      if (modal) actual = info.name;
    } catch (error) {
      if (isNonMutatingProviderRefusal(error)) uncertain = false;
      if (modal) throw retained(error);
      if (!saveInProgress(error)) throw error;
    }
    if (modal) {
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
        if (modal) throw retained(error);
        throw error;
      }
    }
    if (info.status !== "ready") {
      uncertain = false;
      throw new GoldenError("snapshot_failed", info.error ?? `Snapshot of '${golden.name}' failed.`);
    }
    if (modal && (info.name !== actual || info.sourceSandboxId !== master))
      throw new GoldenError("snapshot_failed", "Ready snapshot source could not be verified. Last-good retained.");
    if (modal) actual = info.name;
    await releaseOperation?.retain?.({ kind: "snapshot", sandboxId: modal ? null : master, snapshotId: actual });
    if (modal) {
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
              row.provider === "modal" &&
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

async function goldenRow(
  store: GoldenStore,
  actor: GoldenActor,
  identity: { name: string; visibility: Visibility; provider: SandboxProviderId; modal: ModalBinding | null },
  config: GoldenConfig,
  existing: GoldenRecord[],
): Promise<GoldenRecord> {
  const { name, visibility } = identity;
  if (existing.length > 1) {
    throw new GoldenError("conflict", `More than one ${visibility} golden is named '${name}'.`);
  }
  const row = existing[0];
  if (!row) return store.insert({ orgId: actor.orgId, ownerId: actor.userId, ...identity, config });
  assertGoldenMutation(actor, row);
  if (!sameBinding(row.modal, identity.modal)) {
    throw new GoldenError("conflict", `Golden '${name}' is pinned to another Modal App. Use another name.`);
  }
  if (!row.providerSandboxId) {
    await store.setConfig(row.id, config);
    return { ...row, config };
  }
  return row;
}

function sameBinding(a: ModalBinding | null, b: ModalBinding | null): boolean {
  return a?.workspace === b?.workspace && a?.environment === b?.environment && a?.appId === b?.appId;
}

async function setup(provider: Provider, sandboxId: string, config: GoldenConfig): Promise<void> {
  for (const repo of config.repos) {
    const command = cloneCommand(repo);
    await runCommand(provider, sandboxId, command.command, command.cwd, command.timeoutSeconds, `clone ${repo.url}`);
  }
  for (const [index, command] of config.init.entries()) {
    const spec = initCommand(command);
    await runCommand(provider, sandboxId, spec.command, spec.cwd, spec.timeoutSeconds, `init command ${index + 1}`);
  }
}

async function runCommand(
  provider: Provider,
  sandboxId: string,
  command: string,
  cwd: string,
  timeoutSeconds: number,
  label: string,
): Promise<void> {
  const result = await provider.exec({ sandboxId, command, cwd, timeoutSeconds });
  if (result.detached) {
    throw new GoldenError("setup_failed", `${label} started in the background.`);
  }
  if (result.timedOut) throw new GoldenError("setup_failed", `${label} timed out.`);
  if (result.exitCode !== 0) {
    const detail = clip(result.stderr || result.stdout);
    throw new GoldenError(
      "setup_failed",
      detail ? `${label} failed (exit ${result.exitCode}): ${detail}` : `${label} failed (exit ${result.exitCode}).`,
    );
  }
}

function saveInProgress(error: unknown): boolean {
  return error instanceof ProviderError && error.code === "conflict" && error.providerCode === "save_in_progress";
}

function clip(value: string): string {
  const oneLine = value.replaceAll(/\s+/g, " ").trim();
  if (oneLine === "") return "";
  return oneLine.length <= 400 ? oneLine : `${oneLine.slice(0, 400)}...`;
}
