import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ExecResult, Harness, Provider, ResumeStageObserver, SandboxInfo } from "@armada/core";
import { HARNESSES, isModelConnectionTestResult, OUTPUT_MAX_READ_BYTES, resolveModelChoice } from "@armada/core";
import {
  OUTPUT_COLLECTOR,
  OUTPUT_COLLECTOR_PROBE,
  outputEntryCollector,
  readCollectorChunk,
  readCollectorEntries,
  readCollectorProbeResult,
  readCollectorResult,
  type WorkPreservation,
} from "@armada/core/server";
import { chooseManagementAuthority, matchesManagementAuthority } from "./authority.ts";
import { abortable, boundModalApp, type ModalConnection, modalConnection } from "./client.ts";
import { ModalOperationError, modalError, refusal } from "./errors.ts";
import { executeGoldenCommand } from "./golden-exec.ts";
import { createImageCollection, trackDetachedCollection } from "./image-collection.ts";
import { createLaunchLifecycle } from "./launch-lifecycle.ts";
import { createPhysicalLifecycle } from "./physical-lifecycle.ts";
import type {
  Machine,
  McpConfiguration,
  ModalManagementProvenance,
  ModalResourceReceipt,
  ModalStore,
  RunnerDistribution,
  RunnerTransport,
  Scope,
  SshPreparation,
} from "./ports.ts";
import { createRuntimeLifecycle } from "./runtime-lifecycle.ts";
import { createSandboxInspection } from "./sandbox-inspection.ts";
import { createSnapshotLifecycle } from "./snapshot-lifecycle.ts";
import { createSnapshotTombstones } from "./snapshot-tombstones.ts";
import { createSshPreparation } from "./ssh.ts";
import { createStopDeleteLifecycle } from "./stop-delete-lifecycle.ts";
import { scopeKey } from "./store.ts";

export type ModalPromptPhase =
  | "modal_prepare"
  | "modal_before_prompt"
  | "modal_admit"
  | "modal_health"
  | "modal_rpc"
  | "modal_app_lookup"
  | "modal_image"
  | "modal_sandbox_create"
  | `modal_boot_${"binding" | "runtime" | "baseline" | "fresh" | "start" | "health" | "active_publication"}`;
export interface ModalProviderOptions extends ModalConnection {
  /** Stable, server-owned inventory tag for allocation. */
  deploymentId?: string;
  /** Trusted staging opt-in: allocate host only, never start the tunnel listener. */
  commonRuntime?: true;
  measure?<T>(phase: ModalPromptPhase, work: () => Promise<T>): Promise<T>;
  /** Server-owned history projection only. No live App/runner calls in get/events/getPrompt.
   * Never use this provider for admission or lifecycle decisions. */
  storedReads?: boolean;
  /** Scheduler for lifecycle admission backoff; defaults to the Bun timer. */
  admissionSleep?(milliseconds: number): Promise<void>;
  /** Scheduler for deletion image-cleanup retries; defaults to the Bun timer. */
  cleanupSleep?(milliseconds: number): Promise<void>;
  /** Runs the best-effort collection of other sources' retired images after a delete. Defaults to
   * a detached task, so neither the delete receipt nor the server's activity lease waits on it. */
  detachCollection?(work: () => Promise<void>): void;
  scope: Scope;
  /** Trusted immutable source credential selection; never a requested access visibility. */
  managementAuthority?: ModalManagementProvenance;
  /** Lookup hint only. Actual App ID must match the binding on every operation. */
  appName: string;
  store: ModalStore;
  /** Trusted authorized snapshot scope, distinct from target machine scope for org->private forks. */
  source?: { scope: Scope; store: ModalStore };
  runner: RunnerTransport;
  distribution: RunnerDistribution;
  ssh?: SshPreparation;
  /** Trusted server lifecycle hook. Runs after ready/restore OUTSIDE the store lease; may call
   * get/configureMcp. Failure prevents native submission; incarnation is fenced on reacquisition. */
  resumeRefused?(provider: ModalProvider, sandboxId: string): Promise<void>;
  beforeResume?(provider: ModalProvider, sandboxId: string): Promise<void>;
  beforePrompt?(provider: ModalProvider, sandboxId: string): Promise<void>;
}
export interface ModalProvider extends Provider {
  startRuntime(input: {
    sandboxId: string;
    serverUrl: string;
    enrolmentToken: string;
    resumeGeneration?: number;
    cacheDir: string;
    artifact: { sha256: string; bytes: number };
  }): Promise<void>;
  captureRuntimeWork(input: {
    sandboxId: string;
    physicalGeneration: string;
    signal: AbortSignal;
    context: NonNullable<Parameters<Provider["exec"]>[0]["preservationContext"]>;
    onWorkAtRisk?: () => void;
  }): Promise<WorkPreservation>;
  /** Trusted server only: common checkpoint has been durably sealed and ACKed. */
  stopRuntime(input: {
    sandboxId: string;
    physicalGeneration: string;
    epoch: string;
    watermark: number;
  }): Promise<void>;
  resumeRuntime(
    input: {
      sandboxId: string;
      generation: number;
      checkpoint: { epoch: string; watermark: number };
      ttlSeconds: number;
    },
    signal?: AbortSignal,
    onResumeStage?: ResumeStageObserver,
  ): Promise<SandboxInfo>;
  rollbackRuntimeResume(input: { sandboxId: string; generation: number }): Promise<void>;
  configureGitHub: NonNullable<Provider["configureGitHub"]>;
  findGoldenBuilder: NonNullable<Provider["findGoldenBuilder"]>;
  disposeGoldenBuilder: NonNullable<Provider["disposeGoldenBuilder"]>;
  prepareNativeHarnessCwd(request: { sandboxId: string; harness: Harness; cwd: string }): Promise<void>;
  configureMcp(request: { sandboxId: string; configuration: McpConfiguration }): Promise<{ revision: string }>;
  restoreGoldenMaster(request: { sandboxId?: string; snapshotId: string }): Promise<SandboxInfo>;
  resourceReceipts(): Promise<ModalResourceReceipt[]>;
  collectGarbage(): Promise<void>;
  collectRetiredSnapshot: NonNullable<Provider["collectRetiredSnapshot"]>;
  sshKey(request: {
    sandboxId: string;
    key: string;
  }): Promise<{ sshEndpoint: string; hostKey: string; username?: "user" | "root" }>;
}
/** Both scopes are assembled by the authenticated server, never by runner/request JSON. */
export function assertSourceTargetScopes(source: Scope, target: Scope): void {
  if (
    source.orgId !== target.orgId ||
    source.userId !== target.userId ||
    source.binding.workspace !== target.binding.workspace ||
    source.binding.environment !== target.binding.environment ||
    source.binding.appId !== target.binding.appId ||
    (source.visibility === "private" && target.visibility !== "private")
  )
    throw refusal("forbidden", "Source golden and target machine authority do not match.");
}
export function createModalProvider(options: ModalProviderOptions): ModalProvider {
  const { store, distribution } = options;
  const runner: RunnerTransport = {
    call(row, op, input) {
      if (row.commonRuntime)
        throw refusal("invalid_request", "Enrolled runtime commands require the common transport.");
      return options.runner.call(row, op, input);
    },
  };
  const detachCollection = options.detachCollection ?? trackDetachedCollection;
  const measure: NonNullable<ModalProviderOptions["measure"]> = options.measure ?? ((_phase, work) => work());
  const source = options.source ?? { scope: options.scope, store };
  assertSourceTargetScopes(source.scope, options.scope);
  const managementAuthority = chooseManagementAuthority(source.scope, options.managementAuthority);
  function assertAuthority(record: { managementAuthority?: ModalManagementProvenance }): void {
    if (!matchesManagementAuthority(record.managementAuthority, managementAuthority))
      throw refusal("forbidden", "Stored source management authority does not match this provider connection.");
  }
  const ssh = options.ssh ?? createSshPreparation();
  const client = modalConnection(options);
  const imageCollection = createImageCollection(client, source.store, managementAuthority, detachCollection);
  const deploymentId = options.deploymentId?.trim();
  const bound = () => measure("modal_app_lookup", () => boundModalApp(client, options.appName, options.scope.binding));
  async function snapshotBackend() {
    try {
      await bound();
    } catch (error) {
      const failure = modalError(error);
      if (failure.code === "not_found")
        throw refusal("provider_routing_unavailable", "Snapshot backend authority cannot be verified.");
      throw failure;
    }
  }
  const snapshotTombstones = createSnapshotTombstones(
    store,
    scopeKey(source.scope) === scopeKey(options.scope),
    snapshotBackend,
    assertAuthority,
    imageCollection,
  );
  const { collectImages } = imageCollection;
  function assertMachineSource(row: Machine) {
    assertAuthority(row);
    const origin = row.sourceImage?.scopeKey ?? scopeKey(options.scope);
    if (origin !== scopeKey(source.scope))
      throw refusal("forbidden", "Machine source golden authority does not match this provider connection.");
  }
  const { sandboxInfo, resourceReceipt, inspection } = createSandboxInspection({
    store,
    client,
    runner,
    bound,
    assertMachineSource,
    managementAuthority,
    sourceScope: source.scope,
    scope: options.scope,
    appName: options.appName,
    storedReads: options.storedReads ?? false,
  });
  const physicalLifecycle = createPhysicalLifecycle({
    client,
    bound,
    appName: options.appName,
    scope: options.scope,
    ...(deploymentId ? { deploymentId } : {}),
    distribution,
    runner,
    measure,
    assertMachineSource,
    sandboxInfo,
  });
  const { physical, namedOwned, create, sealBaselineBeforeAdmission } = physicalLifecycle;
  const {
    checkpoint,
    stop,
    delete: deleteSandbox,
  } = createStopDeleteLifecycle({
    client,
    store,
    runner,
    distribution,
    bound,
    physicalLifecycle,
    assertMachineSource,
    resourceReceipt,
    collectImages,
    detachCollection,
    cleanupSleep: options.cleanupSleep,
  });
  /** Caller holds the lifecycle lease through activation and the admitted operation. */
  async function readyLeased(
    row: Machine,
    save: (row: Machine) => Promise<void>,
    onResumeStage?: ResumeStageObserver,
  ): Promise<Machine> {
    assertMachineSource(row);
    if (row.golden && row.quiesced) throw refusal("sandbox_not_ready", "Sealed golden admission cannot be reopened.");
    if (row.phase === "stopped") {
      if (row.commonRuntime) throw refusal("invalid_request", "Enrolled Modal resume is not enabled.");
      if (!row.recoveryImageId) throw refusal("conflict", "Stopped sandbox has no durable recovery image.");
      await onResumeStage?.("accepted");
      await options.beforeResume?.(provider, row.info.id);
      row.generation++;
      row.quiesced = false;
      delete row.ordinaryStopAttempted;
      delete row.info.stopNote;
      row.eventBase = row.checkpointWatermark ?? 0;
      row.imageId = row.recoveryImageId;
      row.physicalName = `armada-${createHash("sha256").update(row.info.id).digest("hex").slice(0, 32)}-${row.generation}`;
      row.phase = "reserved";
      row.info.state = "starting";
      delete row.physicalId;
      delete row.processBaseline;
      try {
        await save(row);
      } catch (error) {
        await options.resumeRefused?.(provider, row.info.id);
        throw error;
      }
    }
    if (row.generation > 1 && ["reserved", "creating", "booting"].includes(row.phase))
      await create(row, save, await distribution.restoreEnv(row), onResumeStage);
    if (row.phase !== "active") throw refusal("sandbox_not_ready", "Sandbox lifecycle is not active.");
    if ((await (await physical(row)).poll()) !== null)
      throw refusal(
        "sandbox_not_ready",
        "Physical machine expired or exited; no verified checkpoint is available for current writes.",
      );
    return row;
  }
  async function ready(id: string): Promise<Machine> {
    const row = await store.get(id);
    if (row.phase === "stopped" || (row.generation > 1 && ["reserved", "creating", "booting"].includes(row.phase)))
      return store.lease(id, readyLeased);
    // No mutation is necessary; readyLeased cannot save an already-active row.
    return readyLeased(row, async () => {
      throw refusal("conflict", "Activation requires a lifecycle lease.");
    });
  }
  async function healthyAdmission(
    row: Machine,
    save: (row: Machine) => Promise<void>,
    onResumeStage?: ResumeStageObserver,
  ): Promise<Machine> {
    if (row.commonRuntime) throw refusal("invalid_request", "Enrolled runtime commands require the common transport.");
    const active = await readyLeased(row, save, onResumeStage);
    const health = await measure("modal_health", () =>
      runner.call<{ generation: string; ready: boolean }>(active, "health", {}),
    );
    if (!health || health.generation !== String(active.generation) || health.ready !== true)
      throw refusal("sandbox_not_ready", "Runner admission is not open for this generation.");
    return active;
  }
  /** Queue only a lease acquisition that ran no callback. Never retry an uncertain RPC outcome. */
  async function admit<T>(
    id: string,
    work: (row: Machine, save: (row: Machine) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let entered = false;
      try {
        return await store.lease(id, (row, save) => {
          entered = true;
          return work(row, save);
        });
      } catch (error) {
        if (entered || modalError(error).providerCode !== "lifecycle_lease_busy" || attempt >= 99) throw error;
        if ((await store.get(id)).phase !== "active") throw error;
        await (options.admissionSleep ?? Bun.sleep)(20);
      }
    }
  }
  async function call<T>(id: string, op: string, input: object): Promise<T> {
    const row = await ready(id);
    if (row.commonRuntime) throw refusal("invalid_request", "Enrolled runtime commands require the common transport.");
    return runner.call<T>(row, op, input);
  }
  async function verifyNativeSession(
    row: Machine,
    request: Parameters<NonNullable<Provider["verifyOrchestratorSession"]>>[0],
  ) {
    if (row.golden || row.phase !== "active" || request.physicalGeneration !== String(row.generation))
      throw refusal("conflict", "Native session verification requires the bound active incarnation.");
    const result = await runner.call<{
      physicalGeneration: string;
      conversationId: string;
      nativeSessionId: string;
      verified: boolean;
    }>(row, "resumeNativeSession", {
      conversationId: request.conversationId,
      expectedSessionId: request.nativeSessionId,
      input: {
        sandboxId: request.sandboxId,
        harness: request.harness,
        model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      },
    });
    if (
      result?.physicalGeneration !== request.physicalGeneration ||
      result.conversationId !== request.conversationId ||
      result.nativeSessionId !== request.nativeSessionId ||
      result.verified !== true
    )
      throw refusal("conflict", "Native session verification did not match the persisted identity.");
    return {
      physicalGeneration: request.physicalGeneration,
      conversationId: request.conversationId,
      nativeSessionId: request.nativeSessionId,
      verified: true as const,
    };
  }
  function assertRecoveryTarget({ ownerId, target }: Parameters<NonNullable<Provider["findGoldenBuilder"]>>[0]) {
    if (
      target.provider !== "modal" ||
      target.orgId !== options.scope.orgId ||
      ownerId !== options.scope.userId ||
      target.visibility !== options.scope.visibility ||
      target.modal?.workspace !== options.scope.binding.workspace ||
      target.modal.environment !== options.scope.binding.environment ||
      target.modal.appId !== options.scope.binding.appId
    )
      throw refusal("forbidden", "Golden builder target does not match this provider connection.");
  }
  function assertRecoveryBuilder(row: Machine, ownerId: string) {
    // No legacy/user-first authority fallback for adoption of an unknown create.
    if (
      !row.golden ||
      row.launchUserId !== ownerId ||
      !row.managementAuthority ||
      row.managementAuthority.credentialScope !== managementAuthority.credentialScope ||
      row.managementAuthority.credentialOwnerId !== managementAuthority.credentialOwnerId ||
      row.info.labels.armada !== "golden-builder" ||
      row.sourceImage
    )
      throw refusal("forbidden", "Golden builder reservation authority does not match.");
    assertMachineSource(row);
  }
  async function retainBuilder(row: Machine, collected?: string): Promise<boolean> {
    // Images still recorded with it as source (published, saving or tombstoned) always retain it.
    if ((await store.images(row.info.id)).length > 0) return true;
    // A deleting or deleted machine's deletion is already committed: its compute is going or gone
    // and the delete itself removes its recovery images. Its snapshot history alone must not strand
    // a job whose rolled-back artifact was collected, nor an interrupted delete.
    if (row.phase === "deleting" || row.phase === "deleted") return false;
    // The job confirmed this builder's only snapshot was never published and is now collected: a
    // builder parked after that snapshot (`checkpoint`) has no other reason to be retained.
    const onlyCollected =
      !!collected &&
      row.phase === "checkpoint" &&
      !!row.snapshotImages?.length &&
      row.snapshotImages.every((image) => image.name === collected);
    return (
      row.generation !== 1 ||
      !!row.goldenRestore ||
      (!onlyCollected && ["checkpoint", "snapshot", "stopped", "terminate"].includes(row.phase)) ||
      !!row.recoveryImageId ||
      !!row.retainedRecoveryIds?.length ||
      (!onlyCollected && !!row.snapshotImages?.length)
    );
  }
  async function collectOutputs<T>(
    { sandboxId, signal }: Parameters<NonNullable<Provider["readOutputs"]>>[0],
    command: string,
    read: (status: number | null, stdout: string) => T,
  ): Promise<T | null> {
    signal?.throwIfAborted();
    await bound();
    signal?.throwIfAborted();
    // Observation, not lifecycle: like exec and getPrompt it reads the row without the
    // exclusive lifecycle lease, so a periodic sample never makes a concurrent stop, prompt or
    // the pre-stop final capture fail with lifecycle_lease_busy. A stop racing this read only
    // makes the exec fail; the caller keeps its previous snapshot.
    const row = await store.get(sandboxId);
    signal?.throwIfAborted();
    assertMachineSource(row);
    // Live compute only: a stopped Modal workspace is a recovery image, readable only by
    // starting compute, which this read never does. Armada stops capture first instead.
    if (row.golden || row.phase !== "active" || !row.physicalId) return null;
    const sb = await physical(row, signal);
    signal?.throwIfAborted();
    // Fixed collector on the physical container, not the runner: it works for native and
    // enrolled (dial-out) runtimes alike and never carries caller input.
    const child = await sb.exec(["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "/bin/sh", "-c", command], {
      mode: "text",
      env: {},
      secrets: [],
      timeoutMs: 10_000,
      workdir: "/",
      stderr: "ignore",
    });
    signal?.throwIfAborted();
    const output = child.stdout.readText();
    // Awaited below; never an unhandled rejection if closing stdin fails first.
    output.catch(() => {});
    await child.stdin.close();
    // The caller's budget (the shared pre-stop deadline) bounds the wait, not only the exec timeout.
    signal?.throwIfAborted();
    const [status, stdout] = await abortable(Promise.all([child.wait(), output]), signal);
    return read(status, stdout);
  }

  const provider: ModalProvider = {
    id: "modal",
    backendIdentity: async () => {
      await bound();
      return {
        id: JSON.stringify([
          source.scope.binding.workspace,
          source.scope.binding.environment,
          source.scope.binding.appId,
        ]),
      };
    },
    managementIdentity: async () => ({
      scope: managementAuthority.credentialScope,
      ownerId: managementAuthority.credentialOwnerId,
    }),
    harnesses: HARNESSES,
    capabilities: distribution.capabilities,
    ...createLaunchLifecycle({
      store,
      source,
      scope: options.scope,
      commonRuntime: options.commonRuntime,
      managementAuthority,
      bound,
      assertAuthority,
      assertMachineSource,
      create,
      sandboxInfo,
      resourceReceipt,
    }),
    ...createRuntimeLifecycle({
      store,
      distribution,
      bound,
      assertMachineSource,
      physical,
      resourceReceipt,
      create,
      sandboxInfo,
    }),
    outputReadBytes: OUTPUT_MAX_READ_BYTES,
    listOutputEntries(request) {
      return collectOutputs(request, outputEntryCollector(null), readCollectorEntries);
    },
    readOutputChunk(request) {
      return collectOutputs(request, outputEntryCollector(request.chunk), (status, stdout) =>
        readCollectorChunk(status, stdout, request.chunk),
      );
    },
    readOutputs(request) {
      return collectOutputs(request, OUTPUT_COLLECTOR, readCollectorResult);
    },
    async probeOutputs(request) {
      return (await collectOutputs(request, OUTPUT_COLLECTOR_PROBE, readCollectorProbeResult)) !== null;
    },

    ...inspection,
    async restoreGoldenMaster({ sandboxId: requestedSandboxId, snapshotId }) {
      if (scopeKey(source.scope) !== scopeKey(options.scope))
        throw refusal("forbidden", "Golden master restore requires a source-scoped provider connection.");
      const snapshot = await source.store.image(snapshotId);
      assertAuthority(snapshot);
      if (requestedSandboxId !== undefined && snapshot.sourceId !== requestedSandboxId)
        throw refusal("forbidden", "Snapshot does not belong to this golden master.");
      const sandboxId = snapshot.sourceId;
      if (snapshot.info.status !== "ready" || !snapshot.imageId)
        throw refusal("sandbox_not_ready", "Golden snapshot is not ready.");
      if (!snapshot.goldenClean && !distribution.prepareFreshMachine)
        throw refusal(
          "conflict",
          "Legacy golden restore requires a distribution that sanitizes fresh managed state before bootstrap.",
        );
      await bound();
      let observed: Machine | undefined;
      try {
        return await source.store.lease(sandboxId, async (row, save) => {
          observed = row;
          assertMachineSource(row);
          if (!row.golden) throw refusal("invalid_request", "Only a golden master can be restored through this port.");
          const same =
            row.goldenRestore?.snapshotId === snapshotId &&
            (row.goldenRestore.sourceImageId ?? row.goldenRestore.imageId) === snapshot.imageId;
          if (row.phase === "active") {
            if (!same || row.goldenRestore?.generation !== row.generation || row.quiesced)
              throw refusal(
                "conflict",
                "Active golden master has a different restore context; edits were not discarded.",
              );
            return sandboxInfo(await healthyAdmission(row, save));
          }
          if (["reserved", "creating", "booting"].includes(row.phase)) {
            if (!same || row.goldenRestore?.generation !== row.generation)
              throw refusal("conflict", "Another golden restore is in progress.");
            // A committed boot may have lost its last SQL/HTTP response. Reconcile without starting a
            // second runner or resetting admission/session state on that same physical machine.
            if (row.phase === "booting" && row.physicalId) {
              let health: { generation: string; ready: boolean; pid?: unknown } | undefined;
              try {
                health = await runner.call(row, "health", {});
              } catch {
                /* Unknown boot remains protected by the single-runner lock. */
              }
              if (health?.generation === String(row.generation) && health.ready) {
                if (row.processBaseline?.admissionState === "pending")
                  await sealBaselineBeforeAdmission(await physical(row), row, save, health.pid);
                row.phase = "active";
                row.info.state = "ready";
                row.info.providerState = "active";
                await save(row);
                return sandboxInfo(row);
              }
            }
            return create(row, save, {});
          }
          if (row.phase !== "restoring") {
            if (!["deleted", "stopped"].includes(row.phase) && !(row.phase === "checkpoint" && row.quiesced))
              throw refusal("conflict", "Uncertain golden checkpoint retained; restore cannot discard that source.");
            // Re-read under the source lease: a snapshot retired since the read above may already be
            // claimed for physical collection, and a tombstone must never gain a reference.
            if ((await source.store.image(snapshotId)).imageId !== snapshot.imageId)
              throw refusal("conflict", "Golden snapshot changed during restore admission.");
            const latestBase = row.snapshotImages?.at(-1)?.name ?? row.goldenRestore?.snapshotId;
            const restoreImage =
              row.phase === "stopped" && latestBase === snapshotId && row.recoveryImageId
                ? row.recoveryImageId
                : snapshot.imageId;
            row.goldenRestore = {
              snapshotId,
              sourceImageId: snapshot.imageId as string,
              imageId: restoreImage as string,
              generation: row.generation + 1,
            };
            row.phase = "restoring";
            row.info.state = "starting";
            await save(row);
          } else if (!same) throw refusal("conflict", "Another golden restore intent is already recorded.");
          if (row.physicalId) {
            try {
              const old = await physical(row);
              await old.terminate({ wait: true });
              if ((await old.poll()) === null)
                throw refusal("unavailable", "Previous golden machine termination is pending.");
            } catch (error) {
              if (modalError(error).code !== "not_found") throw error;
            }
          }
          const intent = row.goldenRestore;
          if (!intent) throw refusal("conflict", "Golden restore intent is missing.");
          row.generation = intent.generation;
          row.imageId = intent.imageId;
          row.eventBase = 0;
          row.quiesced = false;
          delete row.checkpointWatermark;
          delete row.physicalId;
          delete row.processBaseline;
          delete row.grantExpiresAt;
          row.physicalName = `armada-${createHash("sha256").update(row.info.id).digest("hex").slice(0, 32)}-${row.generation}`;
          row.phase = "reserved";
          await save(row);
          return create(row, save, {});
        });
      } catch (error) {
        if (observed) throw new ModalOperationError(error, await resourceReceipt(observed));
        throw error;
      }
    },
    async prepareNativeHarnessCwd({ sandboxId, harness, cwd }) {
      // Repository membership/existence is validated by trusted core against the golden. Here reject
      // malformed path data, not shell-escape it or install executable wrappers in a user runner.
      if (
        !(HARNESSES as readonly string[]).includes(harness) ||
        typeof cwd !== "string" ||
        !posix.isAbsolute(cwd) ||
        posix.normalize(cwd) !== cwd ||
        Array.from(cwd).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        Buffer.byteLength(cwd) > 4095
      )
        throw refusal("invalid_request", "Native harness cwd must be a canonical absolute POSIX path.");
      await admit(sandboxId, async (row, save) => {
        if (row.golden) throw refusal("invalid_request", "Native harness cwd preparation requires a working fork.");
        const active = await healthyAdmission(row, save);
        active.harnessCwds = { ...active.harnessCwds, [harness]: cwd };
        await save(active);
      });
    },
    async configureGitHub({
      sandboxId,
      configuration,
    }: {
      sandboxId: string;
      configuration: import("@armada/core").GitHubRuntimeConfiguration | null;
    }) {
      return admit(sandboxId, async (row) => {
        // Renewal must never restore or allocate a stopped machine.
        if (
          row.golden ||
          !row.physicalId ||
          !["ready", "running"].includes(row.info.state) ||
          (configuration && configuration.generation !== String(row.generation))
        )
          throw refusal("unauthorized", "GitHub runtime generation is not active.");
        const bounded =
          configuration && row.grantExpiresAt
            ? { ...configuration, expiresAt: Math.min(configuration.expiresAt, row.grantExpiresAt) }
            : configuration;
        const result = await runner.call<{ acknowledged?: boolean }>(row, "configureGitHub", {
          configuration: bounded,
        });
        if (result?.acknowledged !== true)
          throw refusal("unavailable", "GitHub runtime did not acknowledge configuration.");
        return { acknowledged: true };
      });
    },
    async testModelConnection({ sandboxId, harness, model }) {
      resolveModelChoice(harness, { model });
      return admit(sandboxId, async (row) => {
        if (row.golden || row.phase !== "active" || !["ready", "running"].includes(row.info.state))
          throw refusal("sandbox_not_ready", "Connection checks require an already-running sandbox.");
        const result = await runner.call<unknown>(row, "testModelConnection", { harness, model });
        if (!isModelConnectionTestResult(result)) throw refusal("unavailable", "Invalid connection-test receipt.");
        return result;
      });
    },
    async configureReadableVariables({ sandboxId, harness, variables }) {
      await admit(sandboxId, async (row, save) => {
        if (row.golden) throw refusal("invalid_request", "Golden builders cannot receive variables.");
        const active = await healthyAdmission(row, save);
        const result = await runner.call<{ acknowledged?: boolean }>(active, "configureReadableVariables", {
          harness,
          variables,
        });
        if (result.acknowledged !== true) throw refusal("unavailable", "Readable variable bootstrap unavailable.");
      });
    },
    async configureMcp({ sandboxId, configuration }) {
      if (
        !configuration ||
        typeof configuration.revision !== "string" ||
        !configuration.servers ||
        typeof configuration.servers !== "object" ||
        Array.isArray(configuration.servers)
      )
        throw refusal("invalid_request", "Invalid MCP configuration shape.");
      return admit(sandboxId, async (row, save) => {
        if (row.golden)
          throw refusal("invalid_request", "Golden builders cannot receive model connection configuration.");
        const active = await healthyAdmission(row, save);
        const result = await runner.call<{ revision?: unknown }>(active, "configureMcp", { configuration });
        if (!result || result.revision !== configuration.revision)
          throw refusal("unavailable", "Runner did not acknowledge the requested MCP revision.");
        // Do not persist or echo servers, auth or arbitrary fields returned by the runner.
        return { revision: configuration.revision };
      });
    },
    async installOrchestratorEpoch({ sandboxId, token, binding, url }) {
      return admit(sandboxId, async (row, save) => {
        if (row.golden || row.phase !== "active" || binding.physicalGeneration !== String(row.generation))
          throw refusal("conflict", "Orchestrator authority requires the bound active physical generation.");
        const active = await healthyAdmission(row, save);
        if (binding.physicalGeneration !== String(active.generation))
          throw refusal("conflict", "Physical generation changed during authority admission.");
        const result = await runner.call<{ acknowledged?: unknown }>(active, "installOrchestratorEpoch", {
          token,
          binding,
          url,
        });
        if (result?.acknowledged !== true)
          throw refusal("unavailable", "Private runner did not acknowledge authority delivery.");
        return { acknowledged: true };
      });
    },
    async observeOrchestrator({ sandboxId, physicalGeneration, conversationId }) {
      return admit(sandboxId, async (row) => {
        if (row.golden || row.phase !== "active" || physicalGeneration !== String(row.generation))
          throw refusal("conflict", "Observation requires the bound active native generation.");
        const observed = await runner.call<{
          physicalGeneration: string;
          state: "active" | "quiescent" | "unknown";
          evidence: string;
          eventWatermark: number;
          acknowledgedSequence: number;
          nativeSessionId: string | null;
        }>(row, "observeOrchestrator", { ...(conversationId === undefined ? {} : { conversationId }) });
        if (
          observed?.physicalGeneration !== physicalGeneration ||
          !["active", "quiescent", "unknown"].includes(observed.state) ||
          typeof observed.evidence !== "string" ||
          !/^[a-f0-9]{64}$/.test(observed.evidence) ||
          !Number.isSafeInteger(observed.eventWatermark) ||
          observed.eventWatermark < 0 ||
          !Number.isSafeInteger(observed.acknowledgedSequence) ||
          observed.acknowledgedSequence < 0 ||
          observed.acknowledgedSequence > observed.eventWatermark ||
          (observed.nativeSessionId !== null && typeof observed.nativeSessionId !== "string")
        )
          throw refusal("unavailable", "Invalid native observation receipt.");
        return observed;
      });
    },
    async verifyOrchestratorSession(request) {
      return admit(request.sandboxId, async (row) => {
        return verifyNativeSession(row, request);
      });
    },
    async quiesceOrchestrator({ sandboxId, physicalGeneration }) {
      return admit(sandboxId, async (row, save) => {
        if (row.golden || row.phase !== "active" || physicalGeneration !== String(row.generation))
          throw refusal("conflict", "Quiescence requires the bound active physical generation.");
        const active = await healthyAdmission(row, save);
        if (physicalGeneration !== String(active.generation))
          throw refusal("conflict", "Physical generation changed during quiescence.");
        await runner.call(active, "interrupt", {});
        return { acknowledged: true };
      });
    },
    async scrubOrchestratorEpoch({ sandboxId, physicalGeneration, tokenHash }) {
      return admit(sandboxId, async (row, save) => {
        if (row.golden || row.phase !== "active" || physicalGeneration !== String(row.generation))
          throw refusal("conflict", "Orchestrator scrub requires the bound active physical generation.");
        const active = await healthyAdmission(row, save);
        if (physicalGeneration !== String(active.generation))
          throw refusal("conflict", "Physical generation changed during authority scrub.");
        const result = await runner.call<{ acknowledged?: unknown }>(active, "scrubOrchestratorEpoch", {
          ...(tokenHash === undefined ? {} : { tokenHash }),
        });
        if (result?.acknowledged !== true)
          throw refusal("unavailable", "Private runner did not acknowledge authority scrub.");
        return { acknowledged: true };
      });
    },
    async prompt(r) {
      // Capture only trusted incarnation state, never labels/request data or volatile callback refs.
      const incarnation = (row: Machine) =>
        JSON.stringify([
          row.generation,
          row.physicalId ?? null,
          row.grantExpiresAt ?? null,
          row.processBaseline?.namespace.pid ?? null,
          row.processBaseline?.namespace.mount ?? null,
        ]);
      let expected: string | undefined;
      let restored = false;
      const observeResume: ResumeStageObserver | undefined =
        r.onResumeStage &&
        (async (stage) => {
          if (stage === "machine_started") restored = true;
          await r.onResumeStage?.(stage);
        });
      if (options.beforePrompt) {
        expected = await measure("modal_prepare", () =>
          admit(r.sandboxId, async (row, save) => {
            if (row.golden) throw refusal("invalid_request", "Golden builders cannot run model turns.");
            // Preparation needs an active physical incarnation, not a native health
            // probe that is repeated after the hook. Final admission below owns health.
            return incarnation(await readyLeased(row, save, observeResume));
          }),
        );
        // configureMcp takes its own lease. Invoking this under admission would deadlock.
        await measure("modal_before_prompt", () => options.beforePrompt!(provider, r.sandboxId));
      }
      return measure("modal_admit", () =>
        admit(r.sandboxId, async (row, save) => {
          if (row.golden) throw refusal("invalid_request", "Golden builders cannot run model turns.");
          if (expected !== undefined && (row.phase !== "active" || incarnation(row) !== expected))
            throw refusal(
              "conflict",
              "Prompt preparation belongs to a different physical incarnation; turn not submitted.",
            );
          const active = await healthyAdmission(row, save, observeResume);
          if (expected !== undefined && (active.phase !== "active" || incarnation(active) !== expected))
            throw refusal("conflict", "Runner incarnation changed during admission; turn not submitted.");
          const choice = resolveModelChoice(r.harness, r, active.modelDefaults?.[r.harness]);
          const cwd = active.harnessCwds?.[r.harness];
          if (restored) await r.onResumeStage?.("harness_ready");
          return measure("modal_rpc", () =>
            runner.call(active, "prompt", {
              input: {
                sandboxId: r.sandboxId,
                harness: r.harness,
                text: r.text,
                ...choice,
                ...(r.conversationId !== undefined ? { conversationId: r.conversationId } : {}),
                ...(r.fast !== undefined ? { fast: r.fast } : {}),
                ...(cwd !== undefined ? { cwd } : {}),
              },
            }),
          );
        }),
      );
    },
    async getPrompt(r) {
      const row = await store.get(r.sandboxId);
      assertMachineSource(row);
      // Observation must never use ready(): a stop racing this read must not activate a new generation.
      if (row.commonRuntime)
        throw refusal("invalid_request", "Enrolled runtime history requires the common transport.");
      if (row.phase === "active" && !options.storedReads) return runner.call(row, "getPrompt", r);
      if (options.storedReads) {
        if (row.phase === "deleted") throw refusal("not_found", "Sandbox was deleted.");
        const latest = await store.latestPrompt(r.sandboxId, r.promptId);
        if (!latest) {
          if (row.phase === "active") return { promptId: r.promptId, status: "queued", done: false };
          throw refusal("not_found", "No durable prompt observation found.");
        }
        return {
          promptId: r.promptId,
          ...(latest.conversationId ? { conversationId: latest.conversationId } : {}),
          status: latest.status,
          done: !["queued", "running"].includes(latest.status),
        };
      }
      let cursor: string | undefined;
      let latest: import("@armada/core").AgentEvent | undefined;
      for (;;) {
        const page = await store.events({ sandboxId: r.sandboxId, limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const event of page.events) if (event.kind === "prompt" && event.promptId === r.promptId) latest = event;
        if (!page.hasMore) break;
        if (!page.cursor || page.cursor === cursor)
          throw refusal("unavailable", "Prompt event cursor did not advance.");
        cursor = page.cursor;
      }
      if (latest?.kind !== "prompt") throw refusal("not_found", "No durable prompt observation found.");
      return {
        promptId: r.promptId,
        ...(latest.conversationId ? { conversationId: latest.conversationId } : {}),
        status: latest.status,
        done: !["queued", "running"].includes(latest.status),
      };
    },
    steer(r) {
      return admit(r.sandboxId, async (row, save) => {
        if (row.golden) throw refusal("invalid_request", "Golden builders cannot run model turns.");
        if (row.phase === "stopped") throw refusal("sandbox_not_ready", "Stopped sandboxes cannot be steered.");
        // Protocol 1 selects the sole active turn when no conversation is specified.
        return runner.call(await healthyAdmission(row, save), "steer", {
          sandboxId: r.sandboxId,
          conversationId: r.conversationId,
          text: r.text,
        });
      });
    },
    interrupt: (r) => call(r.sandboxId, "interrupt", r),
    async exec(r) {
      if (r.onlyIfRunning)
        return admit(r.sandboxId, async (row) => {
          if (row.commonRuntime) throw refusal("invalid_request", "Enrolled runtime exec is not enabled.");
          if (row.phase !== "active") throw refusal("sandbox_not_ready", "Recovery capture requires active compute.");
          return runner.call<ExecResult>(row, "exec", { input: r });
        });
      const target = await store.get(r.sandboxId);
      if (!target.golden) return call(r.sandboxId, "exec", { input: r });
      return admit(r.sandboxId, async (row, save) => {
        if (!row.golden) throw refusal("conflict", "Sandbox role changed during golden exec admission.");
        const active = await healthyAdmission(row, save);
        return executeGoldenCommand(await physical(active), r);
      });
    },
    async events(r) {
      r.signal?.throwIfAborted();
      if (!options.storedReads) await bound();
      r.signal?.throwIfAborted();
      const row = await store.get(r.sandboxId);
      if (row.commonRuntime)
        throw refusal("invalid_request", "Enrolled runtime history requires the common transport.");
      // History is readable without live compute, but still belongs to this
      // immutable source/management authority and must not be a deleted machine.
      assertMachineSource(row);
      if (row.phase === "deleted") throw refusal("not_found", "Sandbox was deleted.");
      r.signal?.throwIfAborted();
      const page = await store.events(r);
      r.signal?.throwIfAborted();
      return page;
    },
    ...createSnapshotLifecycle({
      store,
      sourceStore: source.store,
      managementAuthority,
      bound,
      snapshotBackend,
      assertAuthority,
      assertMachineSource,
      physical,
      checkpoint,
      distribution,
      resourceReceipt,
    }),
    ...snapshotTombstones,
    quiesce: (r) => call(r.sandboxId, "interrupt", r),
    async extendLifetime({ sandboxId, ttlSeconds }) {
      await bound();
      return store.lease(sandboxId, async (row) => {
        if (row.phase !== "active" || (await (await physical(row)).poll()) !== null)
          throw refusal("sandbox_not_ready", "Only running compute can be extended.");
        if (!row.grantExpiresAt || Date.now() + ttlSeconds * 1000 > row.grantExpiresAt)
          throw refusal("invalid_request", "Extension exceeds the physical Modal deadline; stop and resume first.");
        return new Date(row.grantExpiresAt);
      });
    },
    stop,
    async findGoldenBuilder(request) {
      assertRecoveryTarget(request);
      const row = await store.findByRequestKey(request.requestKey);
      if (!row) return null;
      assertRecoveryBuilder(row, request.ownerId);
      return {
        sandboxId: row.info.id,
        disposition: (await retainBuilder(row, request.collected)) ? "retained" : "disposable",
      };
    },
    async disposeGoldenBuilder(request) {
      assertRecoveryTarget(request);
      const found = await store.findByRequestKey(request.requestKey);
      if (!found || found.info.id !== request.sandboxId)
        throw refusal("conflict", "Builder reservation changed; source retained.");
      await bound();
      let resume = false;
      await store.lease(request.sandboxId, async (row, save) => {
        assertRecoveryBuilder(row, request.ownerId);
        if (await retainBuilder(row, request.collected))
          throw refusal("conflict", "Builder has retained snapshot or recovery proof; source retained.");
        if (row.phase === "deleted") return;
        // An interrupted deletion (the builder's own cleanup or an earlier disposal) is resumed
        // through the same delete path, which also removes any recovery images. Every resume
        // path refuses a deleting record, so its retention cannot change after this lease.
        if (row.phase === "deleting") {
          resume = true;
          return;
        }
        if (row.physicalId || row.phase !== "reserved") {
          const reconciled = await namedOwned(row);
          if (row.physicalId && row.physicalId !== reconciled.sandboxId)
            throw refusal("conflict", "Named builder differs from recorded physical identity; source retained.");
          // Recheck after remote observation, before any destructive operation.
          if (await retainBuilder(row, request.collected))
            throw refusal("conflict", "Builder retention changed; source retained.");
          row.physicalId = reconciled.sandboxId;
          await save(row);
        }
        if (await retainBuilder(row, request.collected))
          throw refusal("conflict", "Builder retention changed; source retained.");
        row.phase = "deleting";
        await save(row);
        if (row.physicalId) {
          const sb = await physical(row);
          await sb.terminate({ wait: true });
          if ((await sb.poll()) === null)
            throw refusal("unavailable", "Builder termination remains uncertain; reservation retained.");
        }
        // Recovery never collects any image: artifact retention has an independent owner.
        row.phase = "deleted";
        await save(row);
      });
      if (resume) return provider.delete({ sandboxId: request.sandboxId });
      return { status: "deleted" };
    },
    delete: deleteSandbox,
    async collectGarbage() {
      await bound();
      await collectImages();
    },
    async sshKey({ sandboxId, key }) {
      const row = await ready(sandboxId);
      return store.lease(sandboxId, async (current) => {
        if (current.phase !== "active" || current.generation !== row.generation)
          throw refusal("sandbox_not_ready", "SSH lifecycle changed.");
        const result = await ssh.prepare(await physical(row), row, key);
        if (result.username !== (current.golden ? "root" : "user"))
          throw refusal("conflict", "SSH identity does not match trusted sandbox role.");
        return {
          sshEndpoint: result.endpoint,
          hostKey: result.hostPublicKey,
          ...(result.username ? { username: result.username } : {}),
        };
      });
    },
  };
  // Normalize all public failures, without leaking SDK request/token diagnostics.
  return Object.fromEntries(
    Object.entries(provider).map(([key, value]) => [
      key,
      typeof value === "function"
        ? async (...args: unknown[]) => {
            try {
              return await value(...args);
            } catch (e) {
              throw modalError(e);
            }
          }
        : value,
    ]),
  ) as unknown as ModalProvider;
}
