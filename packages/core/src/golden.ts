import { boatSnapshotName } from "./boat-snapshot-name.ts";
import type { Visibility } from "./contract.ts";
import type { MemberRole } from "./database.types.ts";
import {
  cloneCommand,
  GOLDEN_BUILD_TTL_SECONDS,
  GOLDEN_POLL_MS,
  GOLDEN_SANDBOX_POLLS,
  GOLDEN_SNAPSHOT_POLLS,
  type GoldenConfig,
  GoldenError,
  initCommand,
  parseGoldenName,
} from "./golden-config.ts";
import type { MachineSizePolicy } from "./machine-size.ts";
import {
  isNonMutatingProviderRefusal,
  type Provider,
  ProviderError,
  type SandboxInfo,
  type SnapshotInfo,
} from "./provider.ts";
import { isSandboxProvider, type ModalBinding, SANDBOX_PROVIDERS, type SandboxProviderId } from "./sandbox-provider.ts";

export interface GoldenActor {
  userId: string;
  orgId: string;
  role: MemberRole;
}

/** A golden the caller is allowed to see. `config` is the parsed, secret-free file. */
export interface GoldenRecord {
  sizePolicy?: MachineSizePolicy | null;
  id: string;
  orgId: string;
  name: string;
  visibility: Visibility;
  ownerId: string;
  /** The sandbox provider it is built on. Fixed for its whole life. */
  provider: SandboxProviderId;
  /** The provider's id of the sandbox it is built in. Null until create starts it. */
  providerSandboxId: string | null;
  /** The provider's snapshot reference (a boat saved-snapshot name). Null until snapshot. */
  providerSnapshotId: string | null;
  /** Where a Modal golden's images live. Null on any other provider. */
  modal: ModalBinding | null;
  config: GoldenConfig;
  createdAt: string;
}

export interface GoldenOperation {
  (): Promise<void>;
  retain?(receipt: { kind: "connect" | "snapshot"; sandboxId: string | null; snapshotId: string }): Promise<void>;
}

export interface GoldenStore {
  setSizePolicy?(golden: GoldenRecord, actor: GoldenActor, policy: MachineSizePolicy): Promise<void>;
  /** Durable admission; a crashed operation remains fenced for explicit reconciliation. */
  beginOperation?(id: string): Promise<GoldenOperation>;
  reconcileOperations?(golden: GoldenRecord, actor: GoldenActor): Promise<void>;
  /** Recheck live mutation authority, including after long provider operations/readback recovery. */
  assertMutation?(golden: GoldenRecord, actor: GoldenActor): Promise<void>;
  /** Server-side account binding guard. No adoption of legacy rows. */
  assertBackendBinding?(golden: GoldenRecord, provider: Provider): Promise<void>;
  list(orgId: string): Promise<GoldenRecord[]>;
  /**
   * Every visible golden of this name, on every provider. An org golden and the caller's private one can
   * share it, and so can goldens of different providers.
   */
  findByName(orgId: string, name: string): Promise<GoldenRecord[]>;
  insert(input: {
    orgId: string;
    name: string;
    visibility: Visibility;
    ownerId: string;
    provider: SandboxProviderId;
    /** Required exactly when `provider` is modal. */
    modal: ModalBinding | null;
    config: GoldenConfig;
  }): Promise<GoldenRecord>;
  /** Replaces the config of a golden whose sandbox has not been recorded yet. */
  setConfig(id: string, config: GoldenConfig): Promise<void>;
  setSandbox(id: string, providerSandboxId: string): Promise<void>;
  setSnapshot(id: string, providerSnapshotId: string): Promise<void>;
  /** Publish a verified immutable Modal image and retire its stopped master atomically. */
  compareAndSetSnapshot?(id: string, expected: string | null, next: string, expectedSandbox: string): Promise<boolean>;
  recordSnapshot?(id: string, expectedSandbox: string | null, snapshot: string): Promise<boolean>;
  /** Authorized compare-and-swap for a restored/rebuilt master, never a blind identity overwrite. */
  replaceSandbox?(
    id: string,
    expectedSandbox: string | null,
    expectedSnapshot: string,
    replacement: string,
  ): Promise<boolean>;
}

export interface GoldenLimits {
  sleep?: (ms: number) => Promise<void>;
  sandboxPolls?: number;
  snapshotPolls?: number;
}

export interface CreatedGolden {
  golden: GoldenRecord;
  sandboxId: string;
  snapshotName: string;
}

export interface SnapshottedGolden {
  golden: GoldenRecord;
  snapshotName: string;
}

const READY = new Set<SandboxInfo["state"]>(["ready", "running"]);

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
  const ready = READY.has(sandbox.state) ? sandbox : await waitReady(provider, sandbox.id, limits);
  await setup(provider, ready.id, input.config);
  return {
    golden: { ...golden, providerSandboxId: sandbox.id },
    sandboxId: sandbox.id,
    snapshotName,
  };
}

/** The running master sandbox, so a person can place `.env` files before the snapshot. */
export async function connectGolden(
  provider: Provider,
  store: GoldenStore,
  actor: GoldenActor,
  name: string,
  limits: GoldenLimits = {},
): Promise<{ golden: GoldenRecord; sandbox: SandboxInfo }> {
  const golden = await oneVisible(store, actor.orgId, parseGoldenName(name), providerIdOf(provider));
  assertGoldenMutation(actor, golden);
  await store.assertMutation?.(golden, actor);
  await store.reconcileOperations?.(golden, actor);
  const releaseOperation = await store.beginOperation?.(golden.id);
  let uncertain = false;
  let failed = false;
  try {
    if (golden.provider === "modal" && !store.assertMutation)
      throw new GoldenError("forbidden", "Current Modal mutation authority cannot be verified.");
    await store.assertMutation?.(golden, actor);
    await store.assertBackendBinding?.(golden, provider);
    let current: SandboxInfo | undefined;
    if (golden.providerSandboxId) {
      try {
        current = await provider.get(golden.providerSandboxId);
      } catch (error) {
        if (!(error instanceof ProviderError) || error.code !== "not_found") throw error;
      }
    }
    if (current && current.state !== "stopped") {
      const sandbox = await waitReady(provider, current.id, limits);
      await store.assertMutation?.(golden, actor);
      return { golden, sandbox };
    }
    if (!golden.providerSnapshotId) {
      throw new GoldenError("conflict", `Golden '${golden.name}' has no saved snapshot to restore.`);
    }
    if (!store.replaceSandbox) throw new GoldenError("conflict", "Golden restore persistence is not configured.");
    if (golden.provider === "modal" && !provider.restoreGoldenMaster)
      throw new GoldenError(
        "conflict",
        "This Modal adapter requires the authorized golden restore port. No worker fork was created.",
      );
    const restoreSnapshot = golden.providerSnapshotId;
    uncertain = true;
    const restored = await (async () => {
      try {
        return golden.provider === "modal"
          ? await provider.restoreGoldenMaster!({
              snapshotId: restoreSnapshot,
              ...(golden.providerSandboxId ? { sandboxId: golden.providerSandboxId } : {}),
            })
          : await provider.fork({ from: restoreSnapshot, noEnv: true });
      } catch (error) {
        if (isNonMutatingProviderRefusal(error)) uncertain = false;
        throw error;
      }
    })();
    await releaseOperation?.retain?.({
      kind: "connect",
      sandboxId: restored.id,
      snapshotId: golden.providerSnapshotId,
    });
    let outcome: "unpublished" | "unknown" | "published" = "unpublished";
    try {
      const sandbox = await waitReady(provider, restored.id, limits);
      await store.assertMutation?.(golden, actor);
      // Once sent, a failed response does not establish whether the database committed the CAS.
      outcome = "unknown";
      let published: boolean;
      try {
        published = await store.replaceSandbox(
          golden.id,
          golden.providerSandboxId,
          golden.providerSnapshotId,
          restored.id,
        );
      } catch {
        let canonical: GoldenRecord | undefined;
        try {
          canonical = (await store.findByName(actor.orgId, golden.name)).find(
            (row) =>
              row.id === golden.id &&
              row.provider === golden.provider &&
              row.providerSandboxId === restored.id &&
              (golden.provider !== "modal" || row.providerSnapshotId === golden.providerSnapshotId),
          );
        } catch {
          // Loss of read access or database availability is not evidence that publication failed.
        }
        if (canonical) {
          assertGoldenMutation(actor, canonical);
          if (!store.assertMutation)
            throw new GoldenError("forbidden", "Current mutation authority cannot be verified.");
          await store.assertMutation(canonical, actor);
          outcome = "published";
          uncertain = false;
          return { golden: canonical, sandbox };
        }
        // Even a nonmatching read may race an in-flight commit. Only an acknowledged false CAS
        // is a known loser. Retain a potential winner rather than deleting a canonical master.
        throw new GoldenError(
          "conflict",
          `Could not confirm golden restore publication. Retained sandbox ${restored.id}; retry golden connect '${golden.name}' to reconcile before removing any retained sandbox.`,
        );
      }
      outcome = published ? "published" : "unpublished";
      uncertain = false;
      if (!published) {
        if (golden.provider === "modal") {
          // The dedicated restore port is idempotent and may return the same source to concurrent
          // callers. A false CAS is not ownership proof that this shared master is disposable.
          let canonical: GoldenRecord | undefined;
          try {
            canonical = (await store.findByName(actor.orgId, golden.name)).find(
              (row) =>
                row.id === golden.id &&
                row.provider === "modal" &&
                row.providerSandboxId === restored.id &&
                row.providerSnapshotId === golden.providerSnapshotId,
            );
          } catch {
            /* Retain the shared source when lookup is unavailable. */
          }
          if (canonical) {
            assertGoldenMutation(actor, canonical);
            if (!store.assertMutation)
              throw new GoldenError("forbidden", "Current mutation authority cannot be verified.");
            await store.assertMutation(canonical, actor);
            outcome = "published";
            uncertain = false;
            return { golden: canonical, sandbox };
          }
          throw new GoldenError(
            "conflict",
            `Golden changed during restore. Retained shared Modal master ${restored.id}; retry connect to reconcile before removing any source.`,
          );
        }
        throw new GoldenError("conflict", "The golden changed while restoring it; retry connect.");
      }
      return { golden: { ...golden, providerSandboxId: restored.id }, sandbox };
    } finally {
      // Only fresh Boat forks are disposable. Modal restores reuse a shared image-owned source.
      // Never delete that source on a losing/failed CAS or readiness ambiguity.
      if (outcome === "unpublished" && golden.provider === "boat") {
        // Publication lost, but cleanup is not yet known: either transport below may fail.
        uncertain = true;
        // A successful delete call is not a terminal physical observation.
        await provider.delete({ sandboxId: restored.id });
        const terminal = await provider.get(restored.id).catch((error) => {
          if (error instanceof ProviderError && error.code === "not_found") return null;
          throw error;
        });
        uncertain = terminal !== null;
      }
    }
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
  let golden = await oneVisible(store, actor.orgId, parseGoldenName(name), providerIdOf(provider));
  assertGoldenMutation(actor, golden);
  await store.assertMutation?.(golden, actor);
  await store.reconcileOperations?.(golden, actor);
  const releaseOperation = await store.beginOperation?.(golden.id);
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

/**
 * The golden a launch may fork. A private golden of someone else is absent, same as a missing name.
 * Launch (#462) and the MCP server (#464) call this under the caller's own database role. When the name
 * exists on several providers the caller names one; it is never guessed.
 */
/** Visible metadata, even before a snapshot exists. No provider access. */
export async function goldenForSettings(
  store: GoldenStore,
  actor: GoldenActor,
  name: string,
  provider?: SandboxProviderId,
): Promise<GoldenRecord> {
  return oneVisible(store, actor.orgId, parseGoldenName(name), provider);
}

export async function goldenForLaunch(
  store: GoldenStore,
  actor: GoldenActor,
  name: string,
  provider?: SandboxProviderId,
): Promise<GoldenRecord> {
  const golden = await oneVisible(store, actor.orgId, parseGoldenName(name), provider);
  if (!golden.providerSnapshotId) {
    throw new GoldenError("conflict", `Golden '${golden.name}' has no snapshot yet.`);
  }
  return golden;
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

async function oneVisible(
  store: GoldenStore,
  orgId: string,
  name: string,
  provider: SandboxProviderId | undefined,
): Promise<GoldenRecord> {
  const all = await store.findByName(orgId, name);
  const rows = provider === undefined ? all : all.filter((row) => row.provider === provider);
  const row = rows[0];
  if (!row) {
    throw new GoldenError("not_found", `No ${provider === undefined ? "" : `${provider} `}golden named '${name}'.`);
  }
  const providers = [...new Set(rows.map((item) => item.provider))];
  if (providers.length > 1) {
    throw new GoldenError(
      "conflict",
      `Golden '${name}' exists on ${providers.join(" and ")}. Name the provider (${SANDBOX_PROVIDERS.join(" or ")}).`,
    );
  }
  if (rows.length > 1) {
    throw new GoldenError(
      "conflict",
      `More than one golden is named '${name}'. The org one and your private one need different names.`,
    );
  }
  return row;
}

/** The provider an adapter is, as a record names it. */
export function providerIdOf(provider: Provider): SandboxProviderId {
  if (!isSandboxProvider(provider.id)) {
    throw new GoldenError("invalid_config", `'${provider.id}' is not a sandbox provider Armada records.`);
  }
  return provider.id;
}

function sameBinding(a: ModalBinding | null, b: ModalBinding | null): boolean {
  return a?.workspace === b?.workspace && a?.environment === b?.environment && a?.appId === b?.appId;
}

export function assertGoldenMutation(
  actor: GoldenActor,
  golden: Pick<GoldenRecord, "orgId" | "visibility" | "ownerId" | "name">,
): void {
  if (actor.orgId !== golden.orgId) throw new GoldenError("not_found", "No such golden.");
  if (golden.visibility === "private") {
    if (golden.ownerId !== actor.userId) throw new GoldenError("not_found", `No golden named '${golden.name}'.`);
    return;
  }
  if (actor.role !== "admin") {
    throw new GoldenError("forbidden", "Only an admin can change an org golden.");
  }
}

export async function waitReady(provider: Provider, sandboxId: string, limits: GoldenLimits): Promise<SandboxInfo> {
  const sleep = limits.sleep ?? delay;
  const polls = limits.sandboxPolls ?? GOLDEN_SANDBOX_POLLS;
  for (let attempt = 0; attempt < polls; attempt++) {
    const info = await provider.get(sandboxId);
    if (READY.has(info.state)) return info;
    if (info.state !== "starting") {
      throw new GoldenError(
        "setup_failed",
        `Sandbox ${sandboxId} is ${info.state}${info.error ? `: ${info.error}` : ""}.`,
      );
    }
    await sleep(GOLDEN_POLL_MS);
  }
  throw new GoldenError("setup_failed", `Sandbox ${sandboxId} is still starting.`);
}

/** Polls `getSnapshot` until it settles. Shared with the disposable-builder flow (`GoldenCreateService`). */
export async function waitSnapshot(
  provider: Provider,
  name: string,
  limits: GoldenLimits,
): Promise<SnapshotInfo & { status: "ready" | "failed" }> {
  const sleep = limits.sleep ?? delay;
  const polls = limits.snapshotPolls ?? GOLDEN_SNAPSHOT_POLLS;
  for (let attempt = 0; attempt < polls; attempt++) {
    const info = await provider.getSnapshot(name);
    if (info.status === "ready") return { ...info, status: "ready" };
    if (info.status === "failed") return { ...info, status: "failed" };
    await sleep(GOLDEN_POLL_MS);
  }
  throw new GoldenError("snapshot_failed", `Snapshot '${name}' is still saving.`);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clip(value: string): string {
  const oneLine = value.replaceAll(/\s+/g, " ").trim();
  if (oneLine === "") return "";
  return oneLine.length <= 400 ? oneLine : `${oneLine.slice(0, 400)}...`;
}
