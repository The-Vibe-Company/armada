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
import { createNativeLifecycle } from "./native-lifecycle.ts";
import { createNativeOrchestratorOperations } from "./native-orchestrator.ts";
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
  deploymentId?: string;
  commonRuntime?: true;
  measure?<T>(phase: ModalPromptPhase, work: () => Promise<T>): Promise<T>;
  storedReads?: boolean;
  admissionSleep?(milliseconds: number): Promise<void>;
  cleanupSleep?(milliseconds: number): Promise<void>;
  detachCollection?(work: () => Promise<void>): void;
  scope: Scope;
  managementAuthority?: ModalManagementProvenance;
  appName: string;
  store: ModalStore;
  source?: { scope: Scope; store: ModalStore };
  runner: RunnerTransport;
  distribution: RunnerDistribution;
  ssh?: SshPreparation;
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
  collectRetiredSnapshot: NonNullable<Provider["collectRetiredSnapshot"]>;
  sshKey(request: {
    sandboxId: string;
    key: string;
  }): Promise<{ sshEndpoint: string; hostKey: string; username?: "user" | "root" }>;
}
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
  const { ready, healthyAdmission, admit, call, turns } = createNativeLifecycle({
    options,
    provider: () => provider,
    runner,
    measure,
    bound,
    assertMachineSource,
    physicalLifecycle,
  });
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
    if ((await store.images(row.info.id)).length > 0) return true;
    if (row.phase === "deleting" || row.phase === "deleted") return false;
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
    const row = await store.get(sandboxId);
    signal?.throwIfAborted();
    assertMachineSource(row);
    if (row.golden || row.phase !== "active" || !row.physicalId) return null;
    const sb = await physical(row, signal);
    signal?.throwIfAborted();
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
    output.catch(() => {});
    await child.stdin.close();
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
            if (row.phase === "booting" && row.physicalId) {
              let health: { generation: string; ready: boolean; pid?: unknown } | undefined;
              try {
                health = await runner.call(row, "health", {});
              } catch {}
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
        return { revision: configuration.revision };
      });
    },
    ...createNativeOrchestratorOperations({ admit, healthyAdmission, runner }),
    ...turns,
    supportsExecPhysicalGeneration: true,
    async exec({ expectedPhysicalGeneration, ...r }) {
      if (r.onlyIfRunning || expectedPhysicalGeneration !== undefined)
        return admit(r.sandboxId, async (row) => {
          r.signal?.throwIfAborted();
          if (row.commonRuntime) throw refusal("invalid_request", "Enrolled runtime exec is not enabled.");
          if (expectedPhysicalGeneration !== undefined && expectedPhysicalGeneration !== String(row.generation))
            throw refusal("conflict", "Native exec physical incarnation changed.");
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
        if (row.phase === "deleting") {
          resume = true;
          return;
        }
        if (row.physicalId || row.phase !== "reserved") {
          const reconciled = await namedOwned(row);
          if (row.physicalId && row.physicalId !== reconciled.sandboxId)
            throw refusal("conflict", "Named builder differs from recorded physical identity; source retained.");
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
        row.phase = "deleted";
        await save(row);
      });
      if (resume) return provider.delete({ sandboxId: request.sandboxId });
      return { status: "deleted" };
    },
    delete: deleteSandbox,
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
