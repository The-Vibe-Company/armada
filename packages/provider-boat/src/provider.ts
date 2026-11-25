import { createHash } from "node:crypto";
import type {
  CreateGoldenRequest,
  DeleteReceipt,
  ExecRequest,
  ExecResult,
  ForkRequest,
  Page,
  PromptRequest,
  Provider,
  SandboxInfo,
  SandboxState,
  SnapshotInfo,
  SnapshotRequest,
  SshConnection,
  SshKeyRequest,
} from "@armada/core";
import {
  HARNESS_CAPABILITIES,
  HARNESS_CATALOG,
  HARNESSES,
  MACHINE_SIZE_CATALOG,
  ProviderError,
  parseMachineSize,
  providerRateLimitDetails,
  providerRateLimitMessage,
  redact,
} from "@armada/core";
import {
  isNonMutatingProviderRefusal,
  OUTPUT_COLLECTOR,
  OUTPUT_COLLECTOR_PROBE,
  OutputCollectionError,
  outputEntryCollector,
  readCollectorChunk,
  readCollectorEntries,
  readCollectorProbeResult,
  readCollectorResult,
} from "@armada/core/server";
import {
  BoatApi,
  Configuration,
  type CreateSandboxRequest,
  type Sandbox,
  SandboxLastSnapshotStatusEnum,
  type SandboxListResponse,
  type SavedSnapshot,
  StopOperationResponseFromJSON,
  StopOperationStatusEnum,
} from "@boatdev/sdk";
import {
  parseVmResourceFiles,
  VM_RESOURCE_MAX_FILE_BYTES,
  VM_RESOURCE_PATHS,
} from "../../core/src/vm-resource-reading.ts";
import { invalidRequest, PROVIDER_ID, toProviderError, unexpectedAnswer } from "./errors.ts";

const DEFAULT_BASE_URL = "https://boat.dev/api/v1";
/** boat's own default, sent explicitly so a launch never depends on it. */
const DEFAULT_TTL_SECONDS = 3600;
/** The longest TTL boat accepts: 30 days. */
const MAX_TTL_SECONDS = 2_592_000;

/** Native Boat and the runtime currently expose the same harness capabilities. */
export const BOAT_CAPABILITIES = Object.fromEntries(
  HARNESSES.filter((id) => HARNESS_CATALOG[id].boatProvider !== null).map((id) => [id, HARNESS_CAPABILITIES[id]]),
) as Pick<typeof HARNESS_CAPABILITIES, "claude" | "codex">;

const BOAT_STATES: Record<SandboxState, readonly string[]> = {
  starting: ["init", "provisioning", "provisioned", "cloning"],
  ready: ["ready", "idle"],
  running: ["running"],
  stopping: ["archiving"],
  stopped: ["archived"],
  failed: ["error", "cancelled"],
};

const STOP_STATUSES = new Set<string>(Object.values(StopOperationStatusEnum));
const SNAPSHOT_STATUSES = new Set<string>(Object.values(SandboxLastSnapshotStatusEnum));
function trace(fields: Record<string, unknown>): void {
  try {
    console.info(JSON.stringify({ ...fields, at: new Date().toISOString() }));
  } catch {
    /* Diagnostics must not change lifecycle admission. */
  }
}
function lifecycleTrace(
  sandboxId: string,
  operation: "stop" | "resume" | "interrupt" | "quiesce",
  phase: string,
  path: string,
) {
  trace({ event: "boat_lifecycle", providerSandboxId: sandboxId, operation, phase, path });
}

function sandboxState(providerState: string): SandboxState {
  for (const [state, names] of Object.entries(BOAT_STATES)) {
    if (names.includes(providerState)) return state as SandboxState;
  }
  // A state boat adds later is not ready for work until this adapter learns it.
  return "starting";
}

function stopInFlight(status: StopOperationStatusEnum | undefined) {
  return status === StopOperationStatusEnum.Pending || status === StopOperationStatusEnum.Failing;
}

function archivedSnapshotVerification(sandbox: Sandbox) {
  if (sandbox.dataExpiredAt) return { retention: "unconfirmed", reason: "data_expired" } as const;
  if (sandbox.snapshots === false) return { retention: "unconfirmed", reason: "snapshots_disabled" } as const;
  const stopStatus = sandbox.stop?.status;
  const snapshotStatus = sandbox.lastSnapshotStatus;
  if (stopInFlight(stopStatus)) return { retention: "pending", reason: "stop_in_flight" } as const;
  if (
    snapshotStatus === SandboxLastSnapshotStatusEnum.Queued ||
    snapshotStatus === SandboxLastSnapshotStatusEnum.InProgress
  )
    return { retention: "pending", reason: "snapshot_in_flight" } as const;
  if (
    sandbox.stop &&
    stopStatus !== StopOperationStatusEnum.Completed &&
    stopStatus !== StopOperationStatusEnum.Superseded
  )
    return { retention: "unconfirmed", reason: "stop_status_unconfirmed" } as const;
  if (sandbox.snapshotAvailable !== true) return { retention: "unconfirmed", reason: "snapshot_unavailable" } as const;
  if (snapshotStatus && snapshotStatus !== SandboxLastSnapshotStatusEnum.Completed)
    return { retention: "unconfirmed", reason: "snapshot_status_unconfirmed" } as const;

  const stoppedAt = sandbox.stoppedAt?.getTime();
  const verifiedAt = (sandbox.snapshotVerifiedAt ?? sandbox.snapshotCompletedAt)?.getTime();
  if (stoppedAt === undefined || !Number.isFinite(stoppedAt))
    return { retention: "unconfirmed", reason: "stop_time_unconfirmed" } as const;
  if (verifiedAt === undefined || !Number.isFinite(verifiedAt))
    return { retention: "unconfirmed", reason: "verification_time_unconfirmed" } as const;
  return { stoppedAt, verifiedAt };
}

function sandboxInfo(sandbox: Sandbox): SandboxInfo {
  const info: SandboxInfo = {
    id: sandbox.id,
    name: sandbox.name,
    state: sandboxState(sandbox.state),
    providerState: sandbox.state,
    labels: sandbox.labels ?? {},
  };
  if (sandbox.error) info.error = sandbox.error;
  if (sandbox.createdAt) info.createdAt = sandbox.createdAt;
  if (sandbox.stoppedAt && Number.isFinite(sandbox.stoppedAt.getTime())) info.stoppedAt = sandbox.stoppedAt;
  if (sandbox.archiveAfter) info.expiresAt = sandbox.archiveAfter;
  if (sandbox.sshEndpoint) info.sshEndpoint = sandbox.sshEndpoint;
  return info;
}

function snapshotInfo(snapshot: SavedSnapshot): SnapshotInfo {
  const info: SnapshotInfo = { name: snapshot.name, status: snapshot.status };
  if (snapshot.snapshotId) info.artifactId = snapshot.snapshotId;
  if (snapshot.error) info.error = snapshot.error;
  if (snapshot.sourceSandboxId) info.sourceSandboxId = snapshot.sourceSandboxId;
  if (snapshot.createdAt) info.createdAt = snapshot.createdAt;
  return info;
}

export interface BoatProviderOptions {
  /** The boat API key. It stays in this object: no error or event carries it. */
  apiKey: string;
  /** Stable, nonsecret environment + server identity. Omit to leave inventory unbound. */
  deploymentId?: string;
  baseUrl?: string;
  /** Seconds before boat stops a sandbox by itself, when a call names none. */
  defaultTtlSeconds?: number;
  /** For tests; the SDK's own fetch otherwise. */
  fetch?: typeof fetch;
  /** For tests: how a command refused while its sandbox restores its disk waits before it is sent again. */
  sleep?: (ms: number) => Promise<void>;
}

/** boat refuses a command with this message before running it while a resumed or forked sandbox mounts its disk. */
const RESTORING = "sandbox_restoring";
const RESTORE_RETRIES = 5;
const RESTORE_WAIT_MS = 2000;
const NOT_READY_WAIT_MS = 1000;

function ttl(requested: number | undefined, fallback: number): number {
  const seconds = requested ?? fallback;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TTL_SECONDS) {
    throw invalidRequest(`ttlSeconds must be a whole number of seconds from 1 to ${MAX_TTL_SECONDS}.`);
  }
  return seconds;
}

function page<T>(items: T[], pageInfo: { nextCursor: string | null; hasMore: boolean } | undefined): Page<T> {
  return { items, cursor: pageInfo?.hasMore ? pageInfo.nextCursor : null };
}

/** Compute-only runtime ports; intentionally not required by legacy managed adapters. */
interface BoatRuntimeHost {
  resumeRuntime(
    sandboxId: string,
    ttlSeconds: number,
    signal?: AbortSignal,
    onResumeStage?: PromptRequest["onResumeStage"],
  ): Promise<void>;
}

/** The boat.dev placement, over `@boatdev/sdk`. Every failure is a `ProviderError`. */
export interface BoatProvider extends Provider {
  /** Report-only observations from Boat's label-filtered sandbox API. The timestamps
   * and IDs describe logical sandboxes. Resume can replace the underlying machine. */
  listSandboxInventory(request?: {
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<Page<{ sandboxId: string; deploymentId: string; createdAt: Date }>>;
}

const DEPLOYMENT_LABEL = "armada.deployment";

export function createBoatProvider(options: BoatProviderOptions): BoatProvider & BoatRuntimeHost {
  const defaultTtl = options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;
  const deploymentId = options.deploymentId?.trim();
  const deploymentLabel = deploymentId ? createHash("sha256").update(deploymentId).digest("hex") : undefined;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const api = new BoatApi(
    new Configuration({
      basePath: options.baseUrl ?? DEFAULT_BASE_URL,
      accessToken: options.apiKey,
      ...(options.fetch ? { fetchApi: options.fetch } : {}),
    }),
  );

  async function call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw await toProviderError(error);
    }
  }

  async function start(body: CreateSandboxRequest, idempotencyKey: string | undefined): Promise<SandboxInfo> {
    if (body.labels) {
      const labels = { ...body.labels };
      delete labels[DEPLOYMENT_LABEL];
      if (body.from && deploymentLabel && labels.armada === "sandbox") labels[DEPLOYMENT_LABEL] = deploymentLabel;
      body = { ...body, labels };
    }
    try {
      const response = await call(() =>
        api.create({ createSandboxRequest: body, ...(idempotencyKey ? { idempotencyKey } : {}) }),
      );
      if (!response.sandbox?.id) throw unexpectedAnswer("sandbox");
      return sandboxInfo(response.sandbox);
    } catch (error) {
      const secrets = [options.apiKey, ...Object.values(body.env ?? {})];
      const original = await toProviderError(error);
      // Keep typed evidence, not credential-bearing SDK causes/response bodies.
      const failure = new ProviderError({
        provider: original.provider,
        code: original.code,
        ...(original.status === undefined ? {} : { status: original.status }),
        message: redact(original.message, secrets),
        retryable: original.retryable,
        ...(original.providerCode ? { providerCode: redact(original.providerCode, secrets) } : {}),
        ...(original.requestId ? { requestId: redact(original.requestId, secrets) } : {}),
        ...(original.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: original.retryAfterSeconds }),
        ...(original.details ? { details: original.details } : {}),
      });
      const tag = (value: string | undefined) =>
        value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? redact(value, secrets) : null;
      try {
        const known = failure;
        const window = known.details?.window;
        const limit =
          known.code === "rate_limited" && known.status === 429
            ? providerRateLimitDetails({
                ...known.details,
                provider: "boat",
                retryAfterSeconds: known.retryAfterSeconds,
              })
            : undefined;
        console.error(
          JSON.stringify({
            event: "boat_allocation_failed",
            ...(limit
              ? { message: redact(providerRateLimitMessage(limit), secrets), nextStartAt: limit.nextStartAt ?? null }
              : {}),
            code: known?.code ?? "unknown",
            status: known?.status ?? null,
            providerCode: tag(known?.providerCode),
            requestId: tag(known?.requestId),
            retryable: known?.retryable ?? false,
            retryAfterSeconds: known?.retryAfterSeconds ?? null,
            window:
              typeof window === "string" && ["minute", "hour", "day", "month", "concurrency"].includes(window)
                ? window
                : null,
            outcome: isNonMutatingProviderRefusal(failure) ? "refused" : "unknown",
          }),
        );
      } catch {
        /* Diagnostics must not change the allocation outcome. */
      }
      throw failure;
    }
  }

  async function observeArchivedRetention(sandbox: Sandbox, signal: AbortSignal) {
    const stop = sandbox.stop;
    const endedAt = stop?.endedAt?.getTime();
    const lastSnapshotAttemptAt = sandbox.lastSnapshotAttemptAt?.getTime();
    const finite = (time: number | undefined) => (Number.isFinite(time) ? time : null);
    function defer(
      retention: "unconfirmed" | "pending",
      reason: string,
      observedStop?: { requestedAt: number | undefined; endedAt: number | undefined },
    ) {
      const stopStatus = stop?.status;
      const snapshotStatus = sandbox.lastSnapshotStatus;
      trace({
        event: "boat_retention_unconfirmed",
        providerSandboxId: sandbox.id,
        retention,
        reason,
        stopStatus: stopStatus == null || STOP_STATUSES.has(stopStatus) ? (stopStatus ?? null) : "unknown",
        snapshotStatus:
          snapshotStatus == null || SNAPSHOT_STATUSES.has(snapshotStatus) ? (snapshotStatus ?? null) : "unknown",
        snapshotAvailable: sandbox.snapshotAvailable === true,
        snapshotsDisabled: sandbox.snapshots === false,
        dataExpired: Boolean(sandbox.dataExpiredAt),
        stoppedAt: finite(sandbox.stoppedAt?.getTime()),
        verifiedAt: finite((sandbox.snapshotVerifiedAt ?? sandbox.snapshotCompletedAt)?.getTime()),
        lastSnapshotAttemptAt: finite(lastSnapshotAttemptAt),
        stopEndedAt: finite(endedAt),
        observedStopRequestedAt: finite(observedStop?.requestedAt),
        observedStopEndedAt: finite(observedStop?.endedAt),
      });
      return retention;
    }

    const verification = archivedSnapshotVerification(sandbox);
    if (verification.reason !== undefined) return defer(verification.retention, verification.reason);
    const { stoppedAt, verifiedAt } = verification;
    if (verifiedAt >= stoppedAt) return "usable";

    if (sandbox.lastSnapshotStatus !== SandboxLastSnapshotStatusEnum.Completed)
      return defer("unconfirmed", "snapshot_completion_required");
    if (lastSnapshotAttemptAt !== undefined && !Number.isFinite(lastSnapshotAttemptAt))
      return defer("unconfirmed", "snapshot_attempt_time_invalid");
    if (lastSnapshotAttemptAt !== undefined && lastSnapshotAttemptAt > verifiedAt)
      return defer("unconfirmed", "snapshot_attempt_after_verification");
    if (!stop?.id) return defer("unconfirmed", "stop_operation_id_missing");
    if (stop.status !== StopOperationStatusEnum.Completed) return defer("unconfirmed", "completed_stop_required");
    if (endedAt === undefined || !Number.isFinite(endedAt)) return defer("unconfirmed", "stop_end_time_unconfirmed");
    if (endedAt < stoppedAt) return defer("unconfirmed", "stop_ended_before_archive");

    const observed = await call(async () => {
      const response = await api.getStopRaw({ sandboxId: sandbox.id, stopId: stop.id }, { signal });
      const body = (await response.raw.json()) as { stop?: { forced?: unknown } } | null;
      return { receipt: StopOperationResponseFromJSON(body), forced: body?.stop?.forced };
    }).catch((error: unknown) => {
      if (error instanceof ProviderError && error.status === 404 && error.code === "not_found") return null;
      throw error;
    });
    if (!observed) return defer("pending", "stop_lookup_not_found");
    const { receipt, forced } = observed;
    if (receipt?.ok !== true) return defer("unconfirmed", "stop_lookup_not_ok");
    if (receipt.id !== sandbox.id) return defer("unconfirmed", "stop_lookup_sandbox_mismatch");
    const operation = receipt.stop;
    if (operation?.id !== stop.id) return defer("unconfirmed", "stop_lookup_operation_mismatch");
    if (operation.status !== StopOperationStatusEnum.Completed)
      return defer("unconfirmed", "stop_lookup_not_completed");
    const requestedAt = operation.requestedAt?.getTime();
    const observedStop = { requestedAt, endedAt: operation.endedAt?.getTime() };
    if (observedStop.endedAt !== endedAt) return defer("unconfirmed", "stop_end_mismatch", observedStop);
    if (requestedAt === undefined || !Number.isFinite(requestedAt))
      return defer("unconfirmed", "stop_request_time_unconfirmed", observedStop);
    if (requestedAt > endedAt) return defer("unconfirmed", "stop_request_after_end", observedStop);
    if (forced === true) return defer("unconfirmed", "forced_stop", observedStop);
    if (requestedAt > verifiedAt && forced !== false)
      return defer("unconfirmed", "verification_before_stop_request", observedStop);
    return "usable";
  }

  async function collectOutputs<T>(
    { sandboxId, signal }: Parameters<NonNullable<Provider["readOutputs"]>>[0],
    command: string,
    read: (status: number | null, stdout: string) => T,
  ): Promise<T | null> {
    // Live disk only: the fixed collector through the Boat command API. onlyIfRunning refuses a
    // stopping or stopped sandbox instead of resuming it; its retained disk is not read (#2570 scope).
    const result = await provider
      .exec({
        sandboxId,
        command,
        outputCollection: true,
        onlyIfRunning: true,
        timeoutSeconds: 10,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      })
      .catch((error: unknown) => {
        // Not live (stopping, stopped): unavailable, as on Modal.
        if (error instanceof ProviderError && error.code === "sandbox_not_ready") return null;
        throw error;
      });
    if (!result) return null;
    if (result.detached) throw new OutputCollectionError("collector_failed");
    if (result.timedOut) throw new OutputCollectionError("output_timeout");
    if (result.truncated) throw new OutputCollectionError("collector_failed");
    return read(result.exitCode, result.stdout);
  }

  const requiresRuntime = async (): Promise<never> => {
    throw invalidRequest("Boat agent operations require an enrolled Armada runtime.");
  };
  const provider: BoatProvider & BoatRuntimeHost = {
    id: PROVIDER_ID,
    harnesses: HARNESSES.filter((id) => HARNESS_CATALOG[id].boatProvider !== null),
    capabilities: BOAT_CAPABILITIES,
    maxGoldens: 1,
    async backendIdentity() {
      const response = await call(() => api.me({ signal: AbortSignal.timeout(10_000) }));
      if (!response.user.id) throw unexpectedAnswer("account identity");
      return { id: response.user.id };
    },

    async createGolden(request: CreateGoldenRequest): Promise<SandboxInfo> {
      // noEnv is not optional: a golden must not inherit the boat account's model credentials.
      // There is no `env` and no `environment` here, so nothing from the account is copied onto the disk.
      return start(
        {
          ttlSeconds: ttl(request.ttlSeconds, defaultTtl),
          noEnv: true,
          ...(request.name ? { name: request.name } : {}),
          ...(request.labels ? { labels: request.labels } : {}),
        },
        request.idempotencyKey,
      );
    },

    async sshKey(request: SshKeyRequest): Promise<SshConnection> {
      const response = await call(() =>
        api.sshKey({ sandboxId: request.sandboxId, sshKeyRequest: { key: request.key } }),
      );
      if (!response.sshEndpoint || !response.hostKey) throw unexpectedAnswer("SSH connection");
      return { sshEndpoint: response.sshEndpoint, hostKey: response.hostKey };
    },

    async snapshot(request: SnapshotRequest): Promise<SnapshotInfo> {
      const response = await call(() =>
        api.saveSavedSnapshot({ savedSnapshotSaveRequest: { sandboxId: request.sandboxId, name: request.name } }),
      );
      if (!response.snapshot?.name) throw unexpectedAnswer("snapshot");
      return snapshotInfo(response.snapshot);
    },

    async getSnapshot(name: string): Promise<SnapshotInfo> {
      const response = await call(() => api.getSavedSnapshot({ name }));
      if (!response.snapshot?.name) throw unexpectedAnswer("snapshot");
      return snapshotInfo(response.snapshot);
    },

    async deleteSnapshot(name: string): Promise<void> {
      await call(() => api.deleteSavedSnapshot({ name }));
    },

    async fork(request: ForkRequest): Promise<SandboxInfo> {
      let type: CreateSandboxRequest["type"];
      if (request.size !== undefined) {
        try {
          type = MACHINE_SIZE_CATALOG[parseMachineSize(request.size)].boatType;
        } catch {
          throw invalidRequest("Size must be small, medium, large or xlarge.");
        }
      }
      return start(
        {
          from: request.from,
          ...(type === undefined ? {} : { type }),
          ttlSeconds: ttl(request.ttlSeconds, defaultTtl),
          ...(request.name ? { name: request.name } : {}),
          ...(request.labels ? { labels: request.labels } : {}),
          ...(request.env ? { env: request.env } : {}),
          ...(request.noEnv ? { noEnv: true } : {}),
        },
        request.idempotencyKey,
      );
    },

    // Match the bounded concurrency of Boat work preservation's chunk reads.
    outputReadConcurrency: 8,
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

    async observeResources(sandboxId) {
      // Fixed supported file reads, never commands, model prompts or account-wide OTLP.
      const signal = AbortSignal.timeout(5000);
      const before = await api.get({ sandboxId }, { signal });
      if (!before.sandbox || !["ready", "running"].includes(sandboxInfo(before.sandbox).state)) return null;
      const files: (string | null)[] = [];
      for (const path of VM_RESOURCE_PATHS) {
        try {
          const response = await api.readFile({ sandboxId, path, encoding: "utf8" }, { signal });
          files.push(
            response.ok &&
              response.success &&
              response.path === path &&
              response.encoding === "utf8" &&
              typeof response.content === "string" &&
              Buffer.byteLength(response.content) < VM_RESOURCE_MAX_FILE_BYTES
              ? response.content
              : null,
          );
        } catch {
          files.push(null);
        }
        if (signal.aborted) return null;
      }
      const reading = parseVmResourceFiles(files);
      if (!reading) return null;
      const after = await api.get({ sandboxId }, { signal });
      if (!after.sandbox || !["ready", "running"].includes(sandboxInfo(after.sandbox).state)) return null;
      return {
        version: 1 as const,
        providerSandboxId: sandboxId,
        physicalId: `${sandboxId}/${reading.bootId}`,
        generation: reading.bootId,
        scope: "dedicated-vm" as const,
        runtimeProvenance: "boat-dedicated-vm" as const,
        reading,
        limitations: ["sampled-memory-not-peak", "hypervisor-throttling-unavailable"] as const,
      };
    },
    async get(sandboxId: string, requestOptions?: { signal?: AbortSignal }): Promise<SandboxInfo> {
      const timeout = AbortSignal.timeout(10_000);
      const signal = requestOptions?.signal ? AbortSignal.any([requestOptions.signal, timeout]) : timeout;
      const response = await call(() => api.get({ sandboxId }, { signal }));
      if (!response.sandbox?.id || response.sandbox.id !== sandboxId) throw unexpectedAnswer("sandbox");
      const current = response.sandbox;
      const info = sandboxInfo(current);
      if (current.state === "archived") info.retainedSnapshot = await observeArchivedRetention(current, signal);
      return info;
    },

    async resumeRuntime(sandboxId, ttlSeconds, caller, onResumeStage) {
      const timeout = AbortSignal.timeout(150_000);
      const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
      // Only the trusted managed adapter calls this port after its own owner,
      // account and operation fence. Ordinary MCP resume hooks deliberately hide
      // managed parents; managed MCP is prepared by that adapter after activation.
      lifecycleTrace(sandboxId, "resume", "api_dispatch", "armada_runtime");
      await call(() =>
        api.resume(
          { sandboxId, resumeRequest: { noEnv: true, env: {}, ttlSeconds: ttl(ttlSeconds, defaultTtl) } },
          { signal },
        ),
      );
      await onResumeStage?.("provider_claimed");
      let info = await provider.get(sandboxId, { signal });
      for (let attempt = 0; info.state === "starting" && attempt < 120; attempt++) {
        signal.throwIfAborted();
        await sleep(1000);
        info = await provider.get(sandboxId, { signal });
      }
      if (!["ready", "running"].includes(info.state)) throw invalidRequest("Sandbox activation failed.");
    },
    async listSandboxInventory({ cursor, signal } = {}) {
      if (!deploymentId || !deploymentLabel) return { items: [], cursor: null };
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(10_000);
      const response = await call<SandboxListResponse>(() =>
        api.sandboxes(
          { label: [`${DEPLOYMENT_LABEL}=${deploymentLabel}`], sort: "desc", ...(cursor ? { cursor } : {}) },
          { signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
        ),
      );
      signal?.throwIfAborted();
      if (response.pageInfo?.hasMore && (!response.pageInfo.nextCursor || response.pageInfo.nextCursor === cursor)) {
        throw unexpectedAnswer("sandbox inventory cursor");
      }
      const items = [];
      for (const sandbox of response.sandboxes ?? []) {
        if (
          sandbox.labels?.[DEPLOYMENT_LABEL] === deploymentLabel &&
          sandbox.labels.armada === "sandbox" &&
          sandbox.machineProvider &&
          sandbox.id?.trim() &&
          sandbox.createdAt &&
          Number.isFinite(sandbox.createdAt.getTime())
        ) {
          items.push({ sandboxId: sandbox.id, deploymentId, createdAt: sandbox.createdAt });
        }
      }
      return page(items, response.pageInfo);
    },

    async exec(request: ExecRequest): Promise<ExecResult> {
      const commandRequest = {
        command: request.command,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.timeoutSeconds ? { timeoutSeconds: request.timeoutSeconds } : {}),
        ...(request.detached ? { detached: true } : {}),
      };
      for (let attempt = 1; ; attempt++) {
        request.signal?.throwIfAborted();
        if (request.onlyIfRunning) {
          // Capture precedes stop and must never resume retained compute. A transient
          // startup may settle, but stopping/terminal compute cannot accept capture.
          // The extra GET for every chunk is deliberate: refuse compute that
          // stopped mid-download rather than implicitly resuming it.
          const current = await provider.get(
            request.sandboxId,
            request.signal ? { signal: request.signal } : undefined,
          );
          request.signal?.throwIfAborted();
          const refused = current.physicalExitConfirmed === true || !["ready", "running"].includes(current.state);
          if (refused) {
            if (current.state === "starting" && attempt < RESTORE_RETRIES) {
              await sleep(NOT_READY_WAIT_MS);
              continue;
            }
            throw new ProviderError({
              provider: PROVIDER_ID,
              code: "sandbox_not_ready",
              // Local admission refusal, not an HTTP response from Boat.
              message: "Capture requires running compute.",
              retryable: false,
            });
          }
        }
        try {
          const response = await call(() =>
            api.command(
              { sandboxId: request.sandboxId, commandRequest },
              request.signal ? { signal: request.signal } : undefined,
            ),
          );
          if ("processId" in response) return { detached: true, processId: response.processId };
          if (!("exitCode" in response)) throw unexpectedAnswer("command result");
          return {
            detached: false,
            exitCode: response.exitCode,
            stdout: response.stdout,
            stderr: response.stderr,
            timedOut: response.timedOut,
            truncated: response.stdoutTruncated === true || response.stderrTruncated === true,
          };
        } catch (error) {
          const restoring = error instanceof Error && "details" in error && isRestoring(error.details);
          const notReady =
            request.onlyIfRunning &&
            error instanceof ProviderError &&
            error.code === "sandbox_not_ready" &&
            error.status === 409;
          if ((!restoring && !notReady) || attempt >= RESTORE_RETRIES) throw error;
          // A 409 refusal did not execute the command. Never replay ambiguous errors.
          await sleep(notReady ? NOT_READY_WAIT_MS : RESTORE_WAIT_MS);
        }
      }
    },

    getPrompt: requiresRuntime,
    steer: requiresRuntime,
    interrupt: requiresRuntime,
    events: requiresRuntime,

    async extendLifetime(request) {
      const before = await provider.get(request.sandboxId);
      if (before.id !== request.sandboxId) throw unexpectedAnswer("sandbox");
      if (!["ready", "running"].includes(before.state)) throw invalidRequest("Only running compute can be extended.");
      const response = await call(() =>
        api.update(
          { sandboxId: request.sandboxId, updateSandboxRequest: { ttlSeconds: ttl(request.ttlSeconds, defaultTtl) } },
          { signal: AbortSignal.timeout(10_000) },
        ),
      );
      const acknowledged = response.sandbox?.id === request.sandboxId ? sandboxInfo(response.sandbox) : undefined;
      // Observe once after an incomplete/misidentified successful reply; never
      // replay the PATCH or publish another resource's lifetime as this one's.
      const info = acknowledged?.expiresAt ? acknowledged : await provider.get(request.sandboxId);
      if (info.id !== request.sandboxId) throw unexpectedAnswer("sandbox");
      if (!info.expiresAt) throw unexpectedAnswer("expiry");
      return info.expiresAt;
    },

    async stop(request: { sandboxId: string }): Promise<void> {
      lifecycleTrace(request.sandboxId, "stop", "api_dispatch", "ordinary");
      await call(() => api.stop({ sandboxId: request.sandboxId }, { signal: AbortSignal.timeout(10_000) }));
      lifecycleTrace(request.sandboxId, "stop", "api_accepted", "ordinary");
    },

    async delete(request: { sandboxId: string }): Promise<DeleteReceipt> {
      const response = await call(() =>
        api.deleteSandbox({ sandboxId: request.sandboxId, xAsciiConfirmDelete: request.sandboxId }),
      );
      return {
        status: response.operation?.status ?? "pending",
        ...(response.operation?.id ? { operationId: response.operation.id } : {}),
      };
    },
  };
  return provider;
}

function isRestoring(details: unknown): boolean {
  return (
    typeof details === "object" &&
    details !== null &&
    (details as Record<string, unknown>).retryable === true &&
    (details as Record<string, unknown>).message === RESTORING
  );
}
