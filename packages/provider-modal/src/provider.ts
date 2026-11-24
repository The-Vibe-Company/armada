import { createHash } from "node:crypto";
import type { Provider, ResumeStageObserver, SandboxInfo } from "@armada/core";
import { HARNESSES, OUTPUT_MAX_READ_BYTES } from "@armada/core";
import {
  OUTPUT_COLLECTOR,
  OUTPUT_COLLECTOR_PROBE,
  OutputCollectionError,
  outputEntryCollector,
  readCollectorChunk,
  readCollectorEntries,
  readCollectorProbeResult,
  readCollectorResult,
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
  ModalManagementProvenance,
  ModalStore,
  RunnerDistribution,
  Scope,
  SshPreparation,
} from "./ports.ts";
import type { RuntimeTicket } from "./runtime-bootstrap.ts";
import { createRuntimeLifecycle } from "./runtime-lifecycle.ts";
import { createRuntimeCapture } from "./runtime-work.ts";
import { createSandboxInspection } from "./sandbox-inspection.ts";
import { createSnapshotLifecycle } from "./snapshot-lifecycle.ts";
import { createSnapshotTombstones } from "./snapshot-tombstones.ts";
import { createSshPreparation } from "./ssh.ts";
import { createStopDeleteLifecycle } from "./stop-delete-lifecycle.ts";
import { scopeKey } from "./store.ts";

const collectorOperations = {
  listOutputEntries: "list_entries",
  readOutputChunk: "read_chunk",
  readOutputs: "read_snapshot",
  probeOutputs: "probe_collector",
} as const;
type CollectorOperation = (typeof collectorOperations)[keyof typeof collectorOperations];
const lastCollectorDiagnosticAt = new Map<string, number>();

export type ModalPromptPhase =
  | "modal_app_lookup"
  | "modal_image"
  | "modal_sandbox_create"
  | `modal_boot_${"binding" | "baseline" | "fresh" | "active_publication"}`;
export interface ModalProviderOptions extends ModalConnection {
  deploymentId?: string;
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
  distribution: RunnerDistribution;
  ssh?: SshPreparation;
}
export interface ModalProvider extends Provider {
  startRuntime(input: RuntimeTicket & { sandboxId: string; resumeGeneration?: number }): Promise<void>;
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
  findGoldenBuilder: NonNullable<Provider["findGoldenBuilder"]>;
  disposeGoldenBuilder: NonNullable<Provider["disposeGoldenBuilder"]>;
  restoreGoldenMaster(request: { sandboxId?: string; snapshotId: string }): Promise<SandboxInfo>;
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
export function createModalProvider(options: ModalProviderOptions) {
  const { store, distribution } = options;
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
    if (!row.golden && !row.commonRuntime)
      throw refusal("invalid_request", "This Modal connection requires Armada runtime enrolment.");
    const origin = row.sourceImage?.scopeKey ?? scopeKey(options.scope);
    if (origin !== scopeKey(source.scope))
      throw refusal("forbidden", "Machine source golden authority does not match this provider connection.");
  }
  const { sandboxInfo, resourceReceipt, inspection } = createSandboxInspection({
    store,
    client,
    bound,
    assertMachineSource,
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
    measure,
    assertMachineSource,
    sandboxInfo,
  });
  const { physical, namedOwned, create } = physicalLifecycle;
  const { stop, delete: deleteSandbox } = createStopDeleteLifecycle({
    client,
    store,
    distribution,
    bound,
    physicalLifecycle,
    assertMachineSource,
    resourceReceipt,
    collectImages,
    detachCollection,
    cleanupSleep: options.cleanupSleep,
  });
  async function assertActive(row: Machine) {
    assertMachineSource(row);
    if (row.phase !== "active" || (row.golden && row.quiesced) || (await (await physical(row)).poll()) !== null)
      throw refusal("sandbox_not_ready", "Sandbox lifecycle is not active.");
  }
  function pendingGoldenRestore(row: Machine) {
    return row.golden && row.generation > 1 && ["reserved", "creating", "booting"].includes(row.phase);
  }
  async function readyLeased(row: Machine, save: (row: Machine) => Promise<void>) {
    assertMachineSource(row);
    if (pendingGoldenRestore(row) && !row.quiesced) await create(row, save);
    await assertActive(row);
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
    operation: CollectorOperation,
    command: string,
    read: (status: number | null, stdout: string) => T,
  ): Promise<T | null> {
    async function check<R>(step: string, work: () => R | Promise<R>, exitCode?: number | null) {
      try {
        return await work();
      } catch (error) {
        if (
          !signal?.aborted &&
          !(error instanceof OutputCollectionError && error.reason === "output_directory_missing")
        ) {
          const key = JSON.stringify([operation, step, exitCode]);
          const now = performance.now();
          const previous = lastCollectorDiagnosticAt.get(key);
          if (previous === undefined || now - previous >= 60_000) {
            lastCollectorDiagnosticAt.set(key, now);
            console.warn(
              JSON.stringify({
                event: "modal_output_collector_step_failed",
                providerSandboxId: sandboxId,
                operation,
                step,
                exitCode,
              }),
            );
          }
        }
        throw error;
      }
    }

    signal?.throwIfAborted();
    await check("bind_app", bound);
    signal?.throwIfAborted();
    const row = await check("read_machine", () => store.get(sandboxId));
    signal?.throwIfAborted();
    await check("check_authority", () => assertMachineSource(row));
    if (row.golden || row.phase !== "active" || !row.physicalId) return null;
    const sb = await check("resolve_machine", () => physical(row, signal));
    signal?.throwIfAborted();
    const child = await check("start_exec", () =>
      sb.exec(["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "/bin/sh", "-c", command], {
        mode: "text",
        env: {},
        secrets: [],
        timeoutMs: 10_000,
        workdir: "/",
        stderr: "ignore",
      }),
    );
    signal?.throwIfAborted();
    const output = check("read_stdout", () => child.stdout.readText());
    output.catch(() => {});
    await check("close_stdin", () => child.stdin.close());
    signal?.throwIfAborted();
    const [status, stdout] = await abortable(Promise.all([check("wait_for_exit", () => child.wait()), output]), signal);
    const exitCode = status !== null && Number.isInteger(status) && status >= 0 && status <= 255 ? status : null;
    return check("read_result", () => read(status, stdout), exitCode);
  }

  const requiresRuntime = async () => {
    throw refusal("invalid_request", "Enrolled runtime commands require the common transport.");
  };
  const provider: ModalProvider = {
    id: "modal",
    getPrompt: requiresRuntime,
    steer: requiresRuntime,
    interrupt: requiresRuntime,
    events: requiresRuntime,
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
      return collectOutputs(
        request,
        collectorOperations.listOutputEntries,
        outputEntryCollector(null),
        readCollectorEntries,
      );
    },
    readOutputChunk(request) {
      return collectOutputs(
        request,
        collectorOperations.readOutputChunk,
        outputEntryCollector(request.chunk),
        (status, stdout) => readCollectorChunk(status, stdout, request.chunk),
      );
    },
    readOutputs(request) {
      return collectOutputs(request, collectorOperations.readOutputs, OUTPUT_COLLECTOR, readCollectorResult);
    },
    async probeOutputs(request) {
      return (
        (await collectOutputs(
          request,
          collectorOperations.probeOutputs,
          OUTPUT_COLLECTOR_PROBE,
          readCollectorProbeResult,
        )) !== null
      );
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
            await assertActive(row);
            return sandboxInfo(row);
          }
          if (["reserved", "creating", "booting"].includes(row.phase)) {
            if (!same || row.goldenRestore?.generation !== row.generation)
              throw refusal("conflict", "Another golden restore is in progress.");
            return create(row, save);
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
          row.quiesced = false;
          delete row.physicalId;
          delete row.processBaseline;
          delete row.grantExpiresAt;
          row.physicalName = `armada-${createHash("sha256").update(row.info.id).digest("hex").slice(0, 32)}-${row.generation}`;
          row.phase = "reserved";
          await save(row);
          return create(row, save);
        });
      } catch (error) {
        if (observed) throw new ModalOperationError(error, await resourceReceipt(observed));
        throw error;
      }
    },
    async exec(request) {
      request.signal?.throwIfAborted();
      if (request.onlyIfRunning)
        throw refusal("invalid_request", "Generation-fenced workspace commands require the common transport.");
      const target = await store.get(request.sandboxId);
      if (!target.golden) return requiresRuntime();
      for (let attempt = 0; ; attempt++) {
        let entered = false;
        try {
          return await store.lease(request.sandboxId, async (row, save) => {
            entered = true;
            if (!row.golden) throw refusal("conflict", "Sandbox role changed during golden exec admission.");
            request.signal?.throwIfAborted();
            await readyLeased(row, save);
            request.signal?.throwIfAborted();
            return executeGoldenCommand(await physical(row), request);
          });
        } catch (error) {
          if (entered || modalError(error).providerCode !== "lifecycle_lease_busy" || attempt >= 99) throw error;
          if ((await store.get(request.sandboxId)).phase !== "active") throw error;
          await (options.admissionSleep ?? Bun.sleep)(20);
        }
      }
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
      let row = await store.get(sandboxId);
      if (pendingGoldenRestore(row)) {
        row = await store.lease(sandboxId, async (current, save) => {
          await readyLeased(current, save);
          return current;
        });
      } else await assertActive(row);
      return store.lease(sandboxId, async (current) => {
        if (current.phase !== "active" || current.generation !== row.generation)
          throw refusal("sandbox_not_ready", "SSH lifecycle changed.");
        const result = await ssh.prepare(await physical(current), current, key);
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
  const adapter = Object.fromEntries(
    Object.entries(provider).map(([key, value]) => [
      key,
      typeof value === "function"
        ? async (...args: unknown[]) => {
            try {
              return await value(...args);
            } catch (e) {
              if (Object.hasOwn(collectorOperations, key)) {
                if (e instanceof OutputCollectionError) throw e;
                if (e instanceof SyntaxError) throw new SyntaxError("invalid collector JSON");
                if (e instanceof Error && (e.message === "invalid_output" || e.message === "output_limit"))
                  throw new Error(e.message);
              }
              throw modalError(e);
            }
          }
        : value,
    ]),
  ) as unknown as ModalProvider;
  return { provider: adapter, captureRuntimeWork: createRuntimeCapture(store, physical) };
}
