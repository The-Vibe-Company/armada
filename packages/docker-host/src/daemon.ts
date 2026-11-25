import { createHash } from "node:crypto";
import type { DockerJobFailureReason } from "../../core/src/docker-api.ts";
import { DOCKER_DISK_FLOOR_BYTES, DockerDiskFloorError } from "../../core/src/docker-disk-policy.ts";
import {
  type BootstrapDescriptor,
  canonicalDockerHostJob,
  type DockerHostJob,
  dockerMachineJobId,
  parseDockerHostJob,
} from "../../core/src/docker-host-job.ts";
import type { DockerHostPollResponse } from "../../core/src/docker-host-wire.ts";
import { DockerMachineError, type DockerMachineRequest } from "../../core/src/docker-machine.ts";
import type { DockerSandboxLimits } from "../../core/src/docker-resource-policy.ts";
import {
  DockerSnapshotBaselineError,
  type DockerSnapshotBuildReceipt,
  DockerSnapshotMissingRefError,
} from "../../core/src/docker-snapshot-build.ts";

import type { SnapshotBaselineTool } from "../../core/src/snapshot-baseline.ts";

export type Job = DockerHostJob;
export type Receipt = {
  requestId: string;
  request: DockerMachineRequest;
  outcome?: "completed" | "failed";
  reason?: DockerJobFailureReason;
  retentionProofPending?: true;
  expired?: true;
  cleaned?: true;
  expiryReported?: true;
  expiryOutputsPending?: true;
} & (
  | { operation: "delete" }
  | { operation: "create"; machineId?: string }
  | { operation: "stop"; machineId?: string; absentMachineId?: string }
  | { operation: "bootstrap" | "resume" | "deletePhysical"; inputHash: string }
  | { operation: "restore"; inputHash: string; predecessorKey: string; machineId?: string }
  | {
      operation: "buildSnapshot";
      inputHash: string;
      imageId?: string;
      baselineVersion?: number;
      baselineTool?: SnapshotBaselineTool;
      missingRefIndex?: number;
    }
);
export type State = {
  server: string;
  installationId: string;
  hostId: string;
  hostToken: string;
  receipts: Receipt[];
  retired?: [
    requestId: string,
    hash: string,
    generation: string,
    machineHash: string,
    operation: Receipt["operation"],
    outcome: "completed" | "failed",
    reason: DockerJobFailureReason | null,
    imageId: string | null,
    baselineVersion?: number | null,
    baselineTool?: SnapshotBaselineTool | null,
    missingRefIndex?: number | null,
    machineId?: string | null,
    absentMachineId?: string,
  ][];
  cleanupLimit?: number;
  retention?: {
    request: DockerMachineRequest;
    requestId: string;
    deadline: number;
    observedStoppedAt?: number;
    cleanupAuthorized?: true;
    deleted?: true;
    cleanupReason?: "retention_elapsed" | "disk_pressure";
  }[];
  cleanupGenerations?: string[];
  resumeClaims?: { requestId: string; sandboxId: string; generation: string; accepted: boolean; active: boolean }[];
  retentionSeconds?: number;
  retentionPolicyFromServer?: true;
  retentionScanAfter?: string;
  retentionDeleteAfter?: string;
  retentionReportAfter?: string;
  lastPollAt?: string;
  activeTtl?: string[];
  expiryReportAfter?: string;
  retentionProofAfter?: string;
};
export interface Store {
  load(): Promise<State>;
  save(state: State): Promise<void>;
}
export interface Api {
  register(server: string, token: string, installationId: string): Promise<{ hostId: string; hostToken: string }>;
  poll(
    state: State,
    options?: {
      skipSnapshots?: boolean;
      waitSeconds?: number;
      running?: string[];
      preferStartup?: boolean;
      updateResult?: string;
      updateHealth?: true;
    },
  ): Promise<DockerHostPollResponse & { retainedStopProof?: true | undefined }>;
  result(state: State, receipt: Receipt, expired?: true, retained?: true): Promise<void>;
  retainedOutputs?(state: State, requestId: string, read: () => Promise<Uint8Array<ArrayBuffer> | null>): Promise<void>;
  claim?(state: State, requestId: string, accepted: boolean): Promise<void>;
  cleaned?(state: State, requestId: string, reason?: "retention_elapsed" | "disk_pressure"): Promise<void>;
}
export interface Executor {
  diskFreeBytes?(): Promise<number | null>;
  cleanupImages?(): Promise<void>;
  configureLimits?(limits: DockerSandboxLimits | undefined): void;
  buildSnapshot?(
    job: Extract<Job, { operation: "buildSnapshot" }>,
    recoverOnly?: boolean,
  ): Promise<DockerSnapshotBuildReceipt>;
  startRuntime?(request: DockerMachineRequest, bootstrap: BootstrapDescriptor): Promise<unknown>;
  resume?(request: DockerMachineRequest): Promise<unknown>;
  restore?(
    request: DockerMachineRequest,
    predecessor: Extract<Job, { operation: "restore" }>["predecessor"],
  ): Promise<unknown>;
  reconcileRestore?(
    request: DockerMachineRequest,
    predecessor: Extract<Job, { operation: "restore" }>["predecessor"],
  ): Promise<string | null>;
  create(request: DockerMachineRequest): Promise<unknown>;
  stop(request: DockerMachineRequest, machineId?: string): Promise<unknown>;
  delete(request: DockerMachineRequest, target?: { scope: "physical-only"; machineId: string }): Promise<unknown>;
  stopIfExpired(request: DockerMachineRequest): Promise<unknown>;
  deleteStopped?(request: DockerMachineRequest): Promise<void>;
  isRunning?(request: DockerMachineRequest): Promise<boolean>;
  isAbsent?(request: DockerMachineRequest): Promise<boolean>;
  stoppedAt?(request: DockerMachineRequest): Promise<number | null>;
  isStopped?(request: DockerMachineRequest): Promise<boolean>;
  isRetainedStop?(request: DockerMachineRequest): Promise<boolean>;
}
export function createExpiryOutputSweep(
  store: Store,
  upload: NonNullable<Api["retainedOutputs"]>,
  read: (request: DockerMachineRequest) => Promise<Uint8Array<ArrayBuffer> | null>,
  now = Date.now,
) {
  let pending: Promise<void> | undefined;
  let after: string | undefined;
  const retryAfter = new Map<string, number>();
  async function capture() {
    const state = await store.load();
    const candidates = state.receipts.filter(
      (item) => item.expiryReported && !item.cleaned && item.expiryOutputsPending,
    );
    const ids = new Set(candidates.map(({ requestId }) => requestId));
    for (const id of retryAfter.keys()) if (!ids.has(id)) retryAfter.delete(id);
    const cursor = candidates.findIndex((receipt) => receipt.requestId === after);
    const time = now();
    const receipt = [...candidates.slice(cursor + 1), ...candidates.slice(0, cursor + 1)].find(
      ({ requestId }) => (retryAfter.get(requestId) ?? 0) <= time,
    );
    if (!receipt) return;
    after = receipt.requestId;
    retryAfter.set(receipt.requestId, time + 120_000);
    await upload(state, receipt.requestId, () => read(receipt.request));
    await exclusive(store, async () => {
      const current = await store.load();
      const target = current.receipts.find((item) => item.requestId === receipt.requestId);
      if (!target || target.cleaned) return;
      delete target.expiryOutputsPending;
      await store.save(current);
    });
    retryAfter.delete(receipt.requestId);
  }
  return {
    sweep() {
      pending ??= capture()
        .catch(() => {})
        .finally(() => {
          pending = undefined;
        });
    },
    async drain() {
      await pending;
    },
  };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function validId(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}
export function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
export function serverOrigin(server: string): string {
  const url = new URL(server);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Invalid server origin");
  return url.origin;
}
function fingerprint(job: Pick<Job, "request">): string {
  const r = job.request;
  return JSON.stringify([
    r.sandboxId,
    r.generation,
    r.image,
    r.ttlSeconds,
    ...(r.expiresAt === undefined ? [] : [r.expiresAt]),
    ...(r.snapshot ? [r.snapshot] : []),
  ]);
}
function updateActiveTtl(state: State, receipt: Receipt): void {
  const active = state.activeTtl;
  if (!active) return;
  const same = (id: string) => {
    const other = state.receipts.find((item) => item.requestId === id);
    return (
      other?.request.sandboxId === receipt.request.sandboxId && other.request.generation === receipt.request.generation
    );
  };
  if (
    receipt.cleaned ||
    receipt.expired ||
    ((receipt.operation === "stop" || receipt.operation === "delete") && receipt.outcome === "completed")
  ) {
    state.activeTtl = active.filter((id) => !same(id));
  } else if (
    (receipt.operation === "create" ||
      receipt.operation === "bootstrap" ||
      receipt.operation === "resume" ||
      receipt.operation === "restore") &&
    !active.some(same) &&
    !state.receipts.some(
      (item) =>
        item.expired &&
        item.request.sandboxId === receipt.request.sandboxId &&
        item.request.generation === receipt.request.generation,
    )
  ) {
    active.push(receipt.requestId);
  }
}
export async function register(store: Store, api: Api, server: string, token: string): Promise<void> {
  if (!validToken(token)) throw new Error("Invalid registration token");
  const origin = serverOrigin(server);
  const installationId = crypto.randomUUID();
  const result = await api.register(origin, token, installationId);
  if (!validId(result.hostId) || !validToken(result.hostToken)) throw new Error("Invalid host registration");
  await store.save({
    server: origin,
    installationId,
    hostId: result.hostId,
    hostToken: result.hostToken,
    receipts: [],
  });
}
export function createPhysicalExpirySweep(store: Store, executor: Executor) {
  const pending = new Map<string, Promise<void>>();
  return {
    async sweep(): Promise<void> {
      const state = await store.load();
      const candidates = new Map<string, DockerMachineRequest>();
      const active = state.activeTtl ? new Set(state.activeTtl) : undefined;
      for (const receipt of state.receipts) {
        if (active && !active.has(receipt.requestId)) continue;
        if (
          receipt.operation === "create" ||
          receipt.operation === "bootstrap" ||
          receipt.operation === "resume" ||
          receipt.operation === "restore"
        ) {
          if (!receipt.expired) candidates.set(generationKey(receipt.request), receipt.request);
        }
      }
      for (const [key, request] of candidates) {
        if (pending.has(key)) continue;
        const task = Promise.resolve()
          .then(() => executor.stopIfExpired(request))
          .catch(() => {})
          .then(() => {
            pending.delete(key);
          });
        pending.set(key, task);
      }
    },
    async drain(): Promise<void> {
      await Promise.all(pending.values());
    },
  };
}

export type TickOutcome = "worked" | "held" | "busy" | "idle";
type IterationPhase = "admission" | "poll" | "resume_claim" | "job_decode" | "job";
export type TickOptions = {
  phase?: (phase: IterationPhase) => void;
  waitSeconds?: number;
  running?: ReadonlySet<string>;
  sandboxes?: ReadonlySet<string>;
  snapshots?: ReadonlySet<string>;
  deferUncertain?: ReadonlySet<string>;
  preferStartup?: boolean;
  restoreConflicts?: Map<string, string>;
  update?: ((state: State, target: string | undefined) => Promise<boolean>) | undefined;
  updateResult?: (() => string | undefined) | undefined;
  dispatch?: (job: Job, work: Promise<void>) => void;
};

const ledgers = new WeakMap<Store, Promise<void>>();
async function acquire(store: Store): Promise<() => void> {
  const previous = ledgers.get(store) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  ledgers.set(
    store,
    previous.then(() => next),
  );
  await previous;
  return release;
}
async function exclusive<T>(store: Store, work: () => Promise<T>): Promise<T> {
  const release = await acquire(store);
  try {
    return await work();
  } finally {
    release();
  }
}

export async function tick(
  store: Store,
  api: Api,
  executor: Executor,
  skipSnapshots = false,
  now = Date.now,
  options: TickOptions = {},
): Promise<TickOutcome> {
  const step = await admit(store, api, executor, skipSnapshots, now, options);
  if (typeof step === "string") return step;
  if (options.dispatch && step.held) {
    options.dispatch(step.job, step.work());
    return "worked";
  }
  options.phase?.("job");
  await step.work();
  return "worked";
}

export const DOCKER_HOST_CONCURRENT_JOBS = 4;
export const DOCKER_HOST_POLL_WAIT_SECONDS = 20;
const MAX_POLL_EXCLUSIONS = 16;
export const DOCKER_HOST_IDLE_MS = 20_000;

export async function runJobs(
  store: Store,
  api: Api,
  executor: Executor,
  loop: {
    stopping(): boolean;
    sleep(ms: number): Promise<unknown>;
    beforeTick?(): Promise<void>;
    update?: TickOptions["update"];
    updateResult?: TickOptions["updateResult"];
    failed?(what: "tick" | "job", phase: IterationPhase, error: unknown): void;
    now?: () => number;
  },
): Promise<void> {
  const running = new Map<string, Promise<void>>();
  const live = { running: new Set<string>(), sandboxes: new Set<string>(), snapshots: new Set<string>() };
  let finished = 0;
  const deferUncertain = new Map<string, boolean>();
  const restoreConflicts = new Map<string, string>();
  const settled = () => Promise.race(running.values());
  try {
    while (!loop.stopping()) {
      await loop.beforeTick?.();
      if (running.size >= DOCKER_HOST_CONCURRENT_JOBS) {
        await settled();
        continue;
      }
      const finishedBefore = finished;
      const excluded = new Set(deferUncertain.keys());
      const preferStartup =
        deferUncertain.size >= MAX_POLL_EXCLUSIONS - running.size &&
        [...deferUncertain.values()].some((isCleanup) => isCleanup);
      for (const [id, isCleanup] of deferUncertain) if (preferStartup || !isCleanup) deferUncertain.delete(id);
      let outcome: TickOutcome;
      let phase: IterationPhase = "admission";
      try {
        outcome = await tick(store, api, executor, live.snapshots.size > 0, loop.now ?? Date.now, {
          phase(next) {
            phase = next;
          },
          waitSeconds: DOCKER_HOST_POLL_WAIT_SECONDS,
          ...live,
          deferUncertain: excluded,
          preferStartup,
          restoreConflicts,
          update: loop.update,
          updateResult: loop.updateResult,
          dispatch(job, work) {
            const done = work
              .catch((error) => {
                if (isUncertainDockerFailure(job.operation, error) && deferUncertain.size < MAX_POLL_EXCLUSIONS)
                  deferUncertain.set(job.requestId, job.operation !== "restore");
                loop.failed?.("job", "job", error);
              })
              .finally(() => {
                running.delete(job.requestId);
                live.running.delete(job.requestId);
                live.sandboxes.delete(job.request.sandboxId);
                live.snapshots.delete(job.requestId);
                finished++;
              });
            running.set(job.requestId, done);
            live.running.add(job.requestId);
            live.sandboxes.add(job.request.sandboxId);
            if (job.operation === "buildSnapshot") live.snapshots.add(job.requestId);
          },
        });
      } catch (error) {
        loop.failed?.("tick", phase, error);
        outcome = "idle";
      }
      if (loop.stopping()) break;
      if (outcome === "held" || outcome === "idle") deferUncertain.clear();
      if (outcome === "busy" && finished !== finishedBefore) continue;
      if (outcome === "busy" && running.size) await Promise.race([settled(), loop.sleep(DOCKER_HOST_IDLE_MS)]);
      else if (outcome === "busy" || outcome === "idle") await loop.sleep(DOCKER_HOST_IDLE_MS);
    }
  } finally {
    await Promise.all(running.values());
  }
}

type Admission = TickOutcome | { job: Job; held: boolean; work: () => Promise<void> };
async function admit(
  store: Store,
  api: Api,
  executor: Executor,
  skipSnapshots: boolean,
  now: () => number,
  options: TickOptions,
): Promise<Admission> {
  const lock = { release: await acquire(store) };
  try {
    return await admitLocked(store, api, executor, skipSnapshots, now, options, lock);
  } finally {
    lock.release();
  }
}

async function admitLocked(
  store: Store,
  api: Api,
  executor: Executor,
  skipSnapshots: boolean,
  now: () => number,
  options: TickOptions,
  lock: { release: () => void },
): Promise<Admission> {
  let state = await store.load();
  state.retention ??= [];
  const retentionSeconds = state.retentionSeconds ?? 86400;
  if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds < 0) throw Error("Invalid retention policy");
  const deadline = (request: DockerMachineRequest, stoppedAt: number) => {
    const retainedUntil = stoppedAt + (state.retentionSeconds ?? 86400) * 1000;
    return state.retentionPolicyFromServer || request.expiresAt === undefined
      ? retainedUntil
      : Math.min(retainedUntil, request.expiresAt);
  };
  for (const entry of state.retention) {
    entry.observedStoppedAt ??= entry.deadline - retentionSeconds * 1000;
    if (!entry.deleted) entry.deadline = deadline(entry.request, entry.observedStoppedAt);
  }
  const restoreStillRecoverable = (receipt: Receipt) =>
    options.running?.has(receipt.requestId) || (receipt.request.expiresAt ?? 0) > now();
  const readyForRetention = (receipt: Receipt) =>
    receipt.outcome !== undefined || (receipt.operation === "restore" && !restoreStillRecoverable(receipt));
  const expired = (ledger: State) =>
    new Set(
      [...ledger.receipts, ...(ledger.retention ?? [])]
        .filter((receipt) => receipt.request.expiresAt !== undefined && receipt.request.expiresAt <= now())
        .map((receipt) => generationKey(receipt.request)),
    );
  let expiredGenerations = expired(state);
  let releasedClaim = false;
  for (const claim of state.resumeClaims ?? []) {
    if (claim.active && expiredGenerations.has(generationKey(claim))) {
      claim.active = false;
      releasedClaim = true;
    }
  }
  if (releasedClaim) await store.save(state);
  if (executor.isStopped) {
    const candidates = new Map<string, Receipt>();
    for (const receipt of state.receipts) {
      if (
        receipt.cleaned ||
        receipt.operation === "buildSnapshot" ||
        receipt.operation === "delete" ||
        receipt.operation === "deletePhysical"
      )
        continue;
      candidates.set(generationKey(receipt.request), receipt);
    }
    const values = [...candidates.values()].filter(readyForRetention);
    const after = values.findIndex((receipt) => receipt.requestId === state.retentionScanAfter);
    const receipt = values[(after + 1) % values.length];
    if (receipt) {
      state.retentionScanAfter = receipt.requestId;
      const key = generationKey(receipt.request);
      const scheduled = state.retention.find((entry) => generationKey(entry.request) === key);
      try {
        const absent = (await executor.isAbsent?.(receipt.request)) === true;
        const stopped = absent || (await executor.isStopped(receipt.request));
        if (absent && scheduled) scheduled.deleted = true;
        if (!stopped && scheduled && !scheduled.deleted && (await executor.isRunning?.(receipt.request)) === true) {
          state.retention = state.retention.filter((entry) => entry !== scheduled);
          await store.save(state);
        }
        if (
          stopped &&
          !scheduled &&
          !state.resumeClaims?.some((claim) => claim.active && claim.accepted && generationKey(claim) === key)
        ) {
          state.retention.push({
            request: receipt.request,
            requestId: receipt.requestId,
            deadline: deadline(receipt.request, now()),
            observedStoppedAt: now(),
            ...(absent ? { deleted: true as const } : {}),
          });
          await store.save(state);
        }
      } catch {}
    }
  }
  const exclusions = new Set(options.running);
  for (const requestId of options.deferUncertain ?? []) exclusions.add(requestId);
  if (options.restoreConflicts?.size) {
    const pending = new Set(
      state.receipts
        .filter((receipt) => receipt.operation === "restore" && !receipt.outcome && restoreStillRecoverable(receipt))
        .map((receipt) => receipt.requestId),
    );
    for (const [requestId, owner] of options.restoreConflicts) {
      if (pending.has(owner)) exclusions.add(requestId);
      else options.restoreConflicts.delete(requestId);
    }
  }
  const excludedRequestIds = [...exclusions].slice(0, MAX_POLL_EXCLUSIONS);
  const reload = Boolean(options.running?.size || api.retainedOutputs);
  if (reload) await store.save(state);
  lock.release();
  const updateResult = options.updateResult?.();
  let polled: Awaited<ReturnType<Api["poll"]>> | undefined;
  let pollFailure: { phase: "poll" | "resume_claim"; error: unknown } | undefined;
  try {
    polled = await api.poll(state, {
      skipSnapshots,
      ...(updateResult ? { updateResult } : {}),
      ...(options.waitSeconds === undefined
        ? {}
        : {
            waitSeconds: options.waitSeconds,
            running: excludedRequestIds,
            ...(options.preferStartup ? { preferStartup: true } : {}),
          }),
    });
    if (await options.update?.(state, polled.targetVersion)) return "idle";
  } catch (error) {
    pollFailure = { phase: "poll", error };
  } finally {
    lock.release = await acquire(store);
  }
  if (reload) {
    state = await store.load();
    state.retention ??= [];
    expiredGenerations = expired(state);
  }
  if (polled?.restoreRecovery && executor.reconcileRestore) {
    const recovery = parseDockerHostJob(polled.restoreRecovery);
    if (recovery.operation !== "restore") throw Error("Invalid restore reconciliation");
    if (!options.running?.has(recovery.requestId) && !options.sandboxes?.has(recovery.request.sandboxId)) {
      const inputHash = createHash("sha256")
        .update(JSON.stringify({ requestId: recovery.requestId, input: canonicalDockerHostJob(recovery) }))
        .digest("hex");
      let receipt = state.receipts.find((entry) => entry.requestId === recovery.requestId);
      if (receipt && (receipt.operation !== "restore" || receipt.inputHash !== inputHash))
        throw Error("Changed restore reconciliation");
      if (!receipt?.outcome) {
        const machineId = await executor.reconcileRestore(recovery.request, recovery.predecessor);
        receipt = {
          requestId: recovery.requestId,
          request: recovery.request,
          operation: "restore",
          inputHash,
          predecessorKey: generationKey(recovery.predecessor.request),
          outcome: machineId ? "completed" : "failed",
          ...(machineId ? { machineId } : {}),
        };
        state.receipts = state.receipts.filter((entry) => entry.requestId !== recovery.requestId);
        state.receipts.push(receipt);
        updateActiveTtl(state, receipt);
        await store.save(state);
      }
      await api.result(state, receipt);
    }
  }
  const restoreHolds = new Map<string, string>();
  for (const receipt of state.receipts) {
    if (receipt.operation === "restore" && !receipt.outcome && restoreStillRecoverable(receipt)) {
      restoreHolds.set(receipt.predecessorKey, receipt.requestId);
      restoreHolds.set(generationKey(receipt.request), receipt.requestId);
    }
  }
  let unacknowledged = 0;
  for (const intent of polled?.resumeClaims ?? []) {
    state.resumeClaims ??= [];
    let claim = state.resumeClaims.find((item) => item.requestId === intent.requestId);
    if (!claim) {
      const key = generationKey(intent);
      const lost =
        restoreHolds.has(key) ||
        expiredGenerations.has(key) ||
        state.cleanupGenerations?.includes(key) ||
        state.retention.some(
          (entry) => generationKey(entry.request) === key && (entry.cleanupAuthorized || entry.deleted),
        ) ||
        state.receipts.some(
          (receipt) =>
            generationKey(receipt.request) === key &&
            (receipt.cleaned ||
              receipt.operation === "delete" ||
              (receipt.operation === "deletePhysical" && receipt.outcome !== "failed")),
        ) ||
        state.retired?.some(
          (receipt) =>
            receipt[2] === key &&
            (receipt[4] === "delete" || (receipt[4] === "deletePhysical" && receipt[5] === "completed")),
        );
      claim = { ...intent, accepted: !lost, active: !lost };
      state.resumeClaims.push(claim);
      if (claim.accepted) state.retention = state.retention.filter((entry) => generationKey(entry.request) !== key);
      await store.save(state);
    }
    if (expiredGenerations.has(generationKey(claim))) {
      unacknowledged++;
      continue;
    }
    try {
      await api.claim?.(state, claim.requestId, claim.accepted);
    } catch (error) {
      pollFailure = { phase: "resume_claim", error };
    }
  }
  const claimed = new Set<string>();
  for (const request of polled?.pendingStarts ?? []) {
    const key = generationKey(request);
    if (!expiredGenerations.has(key)) claimed.add(key);
  }
  let job: Job | undefined;
  if (polled?.job) {
    try {
      const observed = parseDockerHostJob(polled.job);
      job = observed;
      if (observed.operation === "bootstrap" || observed.operation === "resume")
        if (!expiredGenerations.has(generationKey(observed.request))) claimed.add(generationKey(observed.request));
    } catch {}
  }
  const restoreDeliveryKeys = new Set<string>();
  if (
    job?.operation === "restore" &&
    (job.request.expiresAt ?? 0) > now() &&
    !state.receipts.some((receipt) => receipt.requestId === job?.requestId && receipt.outcome) &&
    !state.retired?.some((receipt) => receipt[0] === job?.requestId)
  ) {
    restoreDeliveryKeys.add(generationKey(job.request));
    restoreDeliveryKeys.add(generationKey(job.predecessor.request));
  }
  const protectedByRestore = (key: string) => restoreHolds.has(key) || restoreDeliveryKeys.has(key);
  if (claimed.size)
    state.retention = state.retention.filter((entry) => {
      const key = generationKey(entry.request);
      return entry.deleted || protectedByRestore(key) || !claimed.has(key);
    });
  if (polled) {
    executor.configureLimits?.(polled.limits);
    if (polled.retentionSeconds !== undefined) {
      const seconds = polled.retentionSeconds;
      if (!Number.isSafeInteger(seconds) || seconds < 0) throw Error("Invalid retention policy");
      state.retentionSeconds = seconds;
      state.retentionPolicyFromServer = true;
      for (const entry of state.retention)
        if (!entry.deleted) entry.deadline = deadline(entry.request, entry.observedStoppedAt!);
      await store.save(state);
    }
    state.lastPollAt = new Date().toISOString();
  }
  const pressure = async () => {
    const bytes = await executor.diskFreeBytes?.();
    return typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 && bytes < DOCKER_DISK_FLOOR_BYTES;
  };
  if (await pressure()) {
    const latest = new Map<string, Receipt>();
    for (const receipt of state.receipts)
      if (receipt.operation !== "deletePhysical") latest.set(generationKey(receipt.request), receipt);
    for (const [key, receipt] of latest) {
      if (
        !readyForRetention(receipt) ||
        receipt.cleaned ||
        receipt.operation === "delete" ||
        receipt.operation === "buildSnapshot" ||
        claimed.has(key) ||
        protectedByRestore(key) ||
        state.resumeClaims?.some((claim) => claim.active && claim.accepted && generationKey(claim) === key) ||
        state.retention.some((entry) => generationKey(entry.request) === key)
      )
        continue;
      try {
        if (await executor.isStopped?.(receipt.request)) {
          state.retention.push({
            request: receipt.request,
            requestId: receipt.requestId,
            deadline: deadline(receipt.request, now()),
            observedStoppedAt: now(),
          });
        }
      } catch {}
    }
    await store.save(state);
    const stoppedTimes = new Map<string, number>();
    for (const entry of state.retention) {
      try {
        const stoppedAt = await executor.stoppedAt?.(entry.request);
        if (stoppedAt !== null && stoppedAt !== undefined) stoppedTimes.set(entry.requestId, stoppedAt);
      } catch {}
    }
    const age = (entry: NonNullable<State["retention"]>[number]) =>
      stoppedTimes.get(entry.requestId) ?? entry.observedStoppedAt ?? entry.deadline - retentionSeconds * 1000;
    for (const entry of [...state.retention].sort((a, b) => age(a) - age(b))) {
      if (!(await pressure())) break;
      const key = generationKey(entry.request);
      if (
        entry.deleted ||
        claimed.has(key) ||
        protectedByRestore(key) ||
        state.resumeClaims?.some((claim) => claim.active && claim.accepted && generationKey(claim) === key)
      )
        continue;
      if (!executor.deleteStopped) break;
      try {
        if (!(await executor.isStopped?.(entry.request))) continue;
        entry.cleanupReason ??= "disk_pressure";
        entry.cleanupAuthorized = true;
        state.cleanupGenerations ??= [];
        if (!state.cleanupGenerations.includes(key)) state.cleanupGenerations.push(key);
        await store.save(state);
        await executor.deleteStopped(entry.request);
        entry.deleted = true;
        await store.save(state);
      } catch {}
    }
    if (await pressure()) {
      try {
        await executor.cleanupImages?.();
      } catch {}
    }
  }
  const deleteAfter = state.retention.findIndex((entry) => entry.requestId === state.retentionDeleteAfter);
  const due = [...state.retention.slice(deleteAfter + 1), ...state.retention.slice(0, deleteAfter + 1)].find(
    (entry) => !entry.deleted && entry.deadline <= now() && !protectedByRestore(generationKey(entry.request)),
  );
  if (due && executor.deleteStopped) {
    try {
      state.retentionDeleteAfter = due.requestId;
      await store.save(state);
      due.cleanupReason ??= "retention_elapsed";
      due.cleanupAuthorized = true;
      state.cleanupGenerations ??= [];
      if (!state.cleanupGenerations.includes(generationKey(due.request)))
        state.cleanupGenerations.push(generationKey(due.request));
      await store.save(state);
      await executor.deleteStopped(due.request);
      due.deleted = true;
      await store.save(state);
    } catch {}
  }
  if (!state.activeTtl) {
    state.activeTtl = [];
    const terminal = new Set<string>();
    const stopped = new Set<string>();
    const resumed = new Set(
      state.receipts.filter((r) => r.operation === "resume").map((r) => generationKey(r.request)),
    );
    for (const retired of state.retired ?? []) {
      if ((retired[4] === "stop" || retired[4] === "delete") && retired[5] !== "completed") continue;
      if (retired[4] === "stop") stopped.add(retired[2]);
      else if (retired[4] !== "buildSnapshot" && retired[4] !== "deletePhysical") terminal.add(retired[2]);
    }
    for (const receipt of state.receipts) {
      const key = generationKey(receipt.request);
      if (terminal.has(key) || (stopped.has(key) && !resumed.has(key))) continue;
      updateActiveTtl(state, receipt);
    }
  }
  const id = state.activeTtl.shift();
  if (id) {
    state.activeTtl.push(id);
    try {
      await store.save(state);
    } catch {}
    const receipt = state.receipts.find((r) => r.requestId === id);
    if (receipt && !(receipt.operation === "restore" && options.running?.has(receipt.requestId))) {
      try {
        if ((await executor.stopIfExpired(receipt.request)) === true) {
          receipt.expired = true;
          state.activeTtl = state.activeTtl.filter((item) => item !== id);
          try {
            await store.save(state);
          } catch {
            delete receipt.expired;
            state.activeTtl.push(id);
          }
        }
      } catch {}
    }
  }
  const cleanAfter = state.retention.findIndex((entry) => entry.requestId === state.retentionReportAfter);
  const cleaned = [...state.retention.slice(cleanAfter + 1), ...state.retention.slice(0, cleanAfter + 1)].find(
    (entry) => entry.deleted,
  );
  if (cleaned && api.cleaned) {
    try {
      state.retentionReportAfter = cleaned.requestId;
      const key = generationKey(cleaned.request);
      state.cleanupGenerations ??= [];
      if (!state.cleanupGenerations.includes(key)) state.cleanupGenerations.push(key);
      await store.save(state);
      await api.cleaned(state, cleaned.requestId, cleaned.cleanupReason);
      for (const receipt of state.receipts) {
        if (generationKey(receipt.request) === key) receipt.cleaned = true;
      }
      state.activeTtl = state.activeTtl?.filter(
        (id) => !state.receipts.some((receipt) => receipt.requestId === id && receipt.cleaned),
      );
      state.retention = state.retention.filter((entry) => entry !== cleaned);
      await store.save(state);
    } catch {}
  }
  const after = state.receipts.findIndex((receipt) => receipt.requestId === state.expiryReportAfter);
  const report = [...state.receipts.slice(after + 1), ...state.receipts.slice(0, after + 1)].find(
    (receipt) => receipt.expired && !receipt.expiryReported && !receipt.cleaned,
  );
  if (report) {
    try {
      state.expiryReportAfter = report.requestId;
      await store.save(state);
      await api.result(state, report, true);
      report.expiryReported = true;
      if (api.retainedOutputs) report.expiryOutputsPending = true;
      await store.save(state);
    } catch {}
  }
  function retentionRemoved(ledger: State, receipt: Receipt) {
    const key = generationKey(receipt.request);
    return (
      receipt.cleaned ||
      ledger.cleanupGenerations?.includes(key) ||
      ledger.retention?.some(
        (entry) => (entry.deleted || entry.cleanupAuthorized) && generationKey(entry.request) === key,
      ) ||
      ledger.receipts.some(
        (entry) =>
          entry.operation === "deletePhysical" && entry.outcome === "completed" && generationKey(entry.request) === key,
      ) ||
      ledger.retired?.some((entry) => entry[2] === key && entry[4] === "deletePhysical" && entry[5] === "completed")
    );
  }
  function reportReceipt(ledger: State, receipt: Receipt) {
    if (receipt.operation === "stop" && receipt.machineId && retentionRemoved(ledger, receipt)) {
      const { machineId: _removed, ...exit } = receipt;
      return api.result(ledger, exit);
    }
    return api.result(ledger, receipt);
  }
  async function reportRetainedStop(ledger: State, receipt: Receipt) {
    const key = generationKey(receipt.request);
    const eligible =
      !retentionRemoved(ledger, receipt) &&
      !receipt.expired &&
      !expired(ledger).has(key) &&
      !claimed.has(key) &&
      !ledger.resumeClaims?.some((claim) => claim.active && claim.accepted && generationKey(claim) === key);
    const retained = eligible && (await executor.isRetainedStop?.(receipt.request).catch(() => false));
    await api.result(ledger, receipt, undefined, retained ? true : undefined);
    delete receipt.retentionProofPending;
    await store.save(ledger);
  }

  if (polled?.retainedStopProof && !pollFailure) {
    const pending = state.receipts.filter((receipt) => receipt.retentionProofPending);
    const after = pending.findIndex((receipt) => receipt.requestId === state.retentionProofAfter);
    const report = [...pending.slice(after + 1), ...pending.slice(0, after + 1)].find(
      (receipt) => receipt.requestId !== polled?.job?.requestId && !options.sandboxes?.has(receipt.request.sandboxId),
    );
    if (report) {
      state.retentionProofAfter = report.requestId;
      try {
        await store.save(state);
        await reportRetainedStop(state, report);
      } catch {}
    }
  }

  async function prepare(receipt: Receipt): Promise<unknown> {
    try {
      if (
        (receipt.operation === "stop" || receipt.operation === "delete" || receipt.operation === "deletePhysical") &&
        state.resumeClaims?.some(
          (claim) => claim.active && claim.accepted && generationKey(claim) === generationKey(receipt.request),
        )
      )
        throw new Error("Generation claimed for resume");
      if (receipt.operation === "delete") {
        state.cleanupGenerations ??= [];
        const key = generationKey(receipt.request);
        if (!state.cleanupGenerations.includes(key)) {
          state.cleanupGenerations.push(key);
          await store.save(state);
        }
      }
      return undefined;
    } catch (error) {
      return error;
    }
  }
  const dispatched = Boolean(options.dispatch && polled?.held);
  async function perform(receipt: Receipt, job: Job, admitted: boolean, refusal: unknown) {
    try {
      if (refusal) throw refusal;
      if (receipt.operation === "buildSnapshot") {
        if (job.operation !== "buildSnapshot" || !executor.buildSnapshot) throw Error("Snapshot builds unavailable.");
        let sweeping: Promise<unknown> | undefined;
        const timer = dispatched
          ? undefined
          : setInterval(async () => {
              if (sweeping) return;
              sweeping = tick(store, api, executor, true).catch(() => {});
              await sweeping;
              sweeping = undefined;
            }, 10000);
        try {
          const built = await executor.buildSnapshot(job, !admitted);
          receipt.imageId = built.imageId;
          if (built.baselineVersion !== null) receipt.baselineVersion = built.baselineVersion;
        } finally {
          clearInterval(timer);
          await sweeping;
        }
      } else if (receipt.operation === "bootstrap" || receipt.operation === "resume") {
        const machineBootstrap =
          job.operation === "bootstrap" && job.requestId === dockerMachineJobId(job.request.generation, "bootstrap");
        if (
          (!admitted && !machineBootstrap) ||
          (job.operation !== "bootstrap" && job.operation !== "resume") ||
          !executor.startRuntime
        )
          throw new Error("Unknown bootstrap outcome");
        if (receipt.operation === "resume") {
          if (!executor.resume) throw new Error("Resume unavailable");
          await executor.resume(receipt.request);
        }
        await executor.startRuntime(receipt.request, job.bootstrap);
      } else if (receipt.operation === "restore") {
        if (job.operation !== "restore" || !executor.restore) throw Error("Restore unavailable");
        const machineId = allocationMachineId(await executor.restore(receipt.request, job.predecessor));
        if (machineId !== undefined) receipt.machineId = machineId;
      } else if (receipt.operation === "stop") {
        const key = generationKey(receipt.request);
        const allocation = state.receipts.find(
          (entry) =>
            (entry.operation === "create" || entry.operation === "restore") &&
            entry.outcome === "completed" &&
            entry.machineId !== undefined &&
            generationKey(entry.request) === key,
        );
        const retired = state.retired?.find(
          (entry) =>
            entry[2] === key &&
            (entry[4] === "create" || entry[4] === "restore") &&
            entry[5] === "completed" &&
            Boolean(entry[11]),
        );
        const expectedId =
          allocation && "machineId" in allocation ? allocation.machineId : (retired?.[11] ?? undefined);
        const result = await executor.stop(receipt.request, expectedId);
        const machineId = allocationMachineId(result);
        if (machineId !== undefined) receipt.machineId = machineId;
        if (
          result &&
          typeof result === "object" &&
          "absentMachineId" in result &&
          typeof result.absentMachineId === "string" &&
          /^[a-f0-9]{64}$/.test(result.absentMachineId)
        )
          receipt.absentMachineId = result.absentMachineId;
      } else if (receipt.operation === "create") {
        const machineId = allocationMachineId(await executor.create(receipt.request));
        if (machineId !== undefined) receipt.machineId = machineId;
      } else if (receipt.operation === "deletePhysical") {
        if (job.operation !== "deletePhysical") throw Error("Changed host job");
        await executor.delete(receipt.request, { scope: "physical-only", machineId: job.machineId });
      } else {
        await executor[receipt.operation](receipt.request);
      }
      receipt.outcome = "completed";
    } catch (error) {
      if (isUncertainDockerFailure(receipt.operation, error)) throw error;
      receipt.outcome = "failed";
      if (receipt.operation === "stop" && !refusal && polled?.retainedStopProof && executor.isRetainedStop)
        receipt.retentionProofPending = true;
      if (error instanceof DockerDiskFloorError) receipt.reason = "disk_full";
      else if (receipt.operation === "buildSnapshot") {
        receipt.reason = "snapshot_build_failed";
        if (error instanceof DockerSnapshotBaselineError) receipt.baselineTool = error.tool;
        if (error instanceof DockerSnapshotMissingRefError) receipt.missingRefIndex = error.index;
        console.error(
          `Snapshot ${receipt.request.sandboxId}: ${
            error instanceof DockerSnapshotBaselineError || error instanceof DockerSnapshotMissingRefError
              ? error.message
              : "Snapshot image build failed. Check registry access, repository access, init commands and the secret scan; build output is suppressed to protect secrets."
          }`,
        );
      } else if (error instanceof DockerMachineError && error.code === "image_unavailable") receipt.reason = error.code;
    }
  }
  async function finish(receipt: Receipt) {
    const latest = await store.load();
    const saved = latest.receipts.find((item) => item.requestId === receipt.requestId);
    if (!saved) throw Error("Missing durable receipt");
    Object.assign(saved, receipt);
    for (const claim of latest.resumeClaims ?? [])
      if (
        claim.requestId === receipt.requestId ||
        (receipt.operation === "resume" && generationKey(claim) === generationKey(receipt.request))
      )
        claim.active = false;
    if (receipt.operation === "resume" && receipt.outcome === "completed")
      latest.retention = (latest.retention ?? []).filter(
        (entry) => generationKey(entry.request) !== generationKey(receipt.request),
      );
    updateActiveTtl(latest, saved);
    await store.save(latest);
    Object.assign(state, latest);
  }
  if (pollFailure) {
    options.phase?.(pollFailure.phase);
    throw pollFailure.error;
  }
  if (!polled) throw new Error("Host poll unavailable");
  if (!polled.job) {
    await store.save(state);
    return polled.held && !unacknowledged ? "held" : "idle";
  }
  if (!job) {
    options.phase?.("job_decode");
    throw new Error("Invalid host job");
  }
  const machineKey = generationKey(job.request);
  const restoreKey = job.operation === "restore" ? generationKey(job.predecessor.request) : undefined;
  const restoreOwner = (key: string) => {
    const owner = restoreHolds.get(key);
    return owner === job.requestId ? undefined : owner;
  };
  const pendingOwner = restoreOwner(machineKey) ?? (restoreKey === undefined ? undefined : restoreOwner(restoreKey));
  if ((job.operation === "bootstrap" || job.operation === "resume") && job.bootstrap.serverUrl !== state.server)
    throw new Error("Wrong bootstrap origin");
  if (pendingOwner && polled.held && options.restoreConflicts && !excludedRequestIds.includes(job.requestId)) {
    const conflicts = options.restoreConflicts;
    conflicts.delete(job.requestId);
    if (conflicts.size >= MAX_POLL_EXCLUSIONS - DOCKER_HOST_CONCURRENT_JOBS) {
      const oldest = conflicts.keys().next();
      if (!oldest.done) conflicts.delete(oldest.value);
    }
    conflicts.set(job.requestId, pendingOwner);
    await store.save(state);
    return "held";
  }
  if (
    pendingOwner !== undefined ||
    options.deferUncertain?.has(job.requestId) ||
    options.running?.has(job.requestId) ||
    (options.running?.size && !polled.held) ||
    options.sandboxes?.has(job.request.sandboxId) ||
    ((options.snapshots ? options.snapshots.size > 0 : skipSnapshots) && job.operation === "buildSnapshot")
  ) {
    await store.save(state);
    return "busy";
  }
  const inputHash =
    job.operation === "bootstrap" ||
    job.operation === "resume" ||
    job.operation === "buildSnapshot" ||
    job.operation === "restore" ||
    job.operation === "deletePhysical"
      ? createHash("sha256")
          .update(JSON.stringify({ requestId: job.requestId, input: canonicalDockerHostJob(job) }))
          .digest("hex")
      : undefined;
  let admitted = false;
  let receipt = state.receipts.find((r) => r.requestId === job.requestId);
  if (
    receipt &&
    (receipt.operation !== job.operation ||
      fingerprint(receipt) !== fingerprint(job) ||
      ("inputHash" in receipt ? receipt.inputHash : undefined) !== inputHash)
  )
    throw new Error("Changed host job");
  if (!receipt) {
    const retired = state.retired ?? [];
    const old = retired.find((r) => r[0] === job.requestId);
    if (old) {
      if (old[1] !== digest(JSON.stringify([job.operation, fingerprint(job), inputHash ?? null])))
        throw new Error("Changed retired host job");
      const replay = {
        requestId: job.requestId,
        request: job.request,
        operation: job.operation,
        ...(inputHash ? { inputHash } : {}),
        outcome: old[5],
        ...(old[6] ? { reason: old[6] } : {}),
        ...(old[7] ? { imageId: old[7] } : {}),
        ...(old[8] ? { baselineVersion: old[8] } : {}),
        ...(old[9] ? { baselineTool: old[9] } : {}),
        ...(old[10] ? { missingRefIndex: old[10] } : {}),
        ...(old[11] ? { machineId: old[11] } : {}),
        ...(old[12] ? { absentMachineId: old[12] } : {}),
      } as Receipt;
      await reportReceipt(state, replay);
      return "worked";
    }
    const oldGeneration = retired.filter((r) => r[2] === generationKey(job.request));
    const cleanup = job.operation === "stop" || job.operation === "delete";
    if (
      oldGeneration.some((r) => r[3] !== digest(fingerprint(job))) ||
      oldGeneration.some(
        (r) =>
          ((r[4] === "create" || r[4] === "restore") && (job.operation === "create" || job.operation === "restore")) ||
          (r[4] === job.operation && (job.operation === "bootstrap" || job.operation === "buildSnapshot")),
      )
    )
      throw new Error("Retired machine generation");
    const count = retired.length + state.receipts.length;
    state.cleanupLimit ??= Math.max(17408, count + 1024);
    if (count >= (cleanup ? state.cleanupLimit : 16384))
      throw new Error("Host replay ledger capacity reached; retire installation");
    if (!cleanup && Buffer.byteLength(JSON.stringify(state)) > 8 * 1024 * 1024)
      throw new Error("Host admission capacity reached; cleanup remains available");
    const generation = state.receipts.filter(
      (r) => r.request.sandboxId === job.request.sandboxId && r.request.generation === job.request.generation,
    );
    if (
      generation.some(
        (r) =>
          fingerprint(r) !== fingerprint(job) ||
          ((r.operation === "create" || r.operation === "restore") &&
            (job.operation === "create" || job.operation === "restore")) ||
          (r.operation === "bootstrap" && job.operation === "bootstrap"),
      )
    )
      throw new Error("Changed machine generation");
    const base = { requestId: job.requestId, request: { ...job.request } };
    const created: Receipt =
      job.operation === "restore"
        ? {
            ...base,
            operation: "restore",
            inputHash: inputHash as string,
            predecessorKey: generationKey(job.predecessor.request),
          }
        : job.operation === "buildSnapshot"
          ? { ...base, operation: "buildSnapshot", inputHash: inputHash as string }
          : job.operation === "bootstrap" || job.operation === "resume" || job.operation === "deletePhysical"
            ? { ...base, operation: job.operation, inputHash: inputHash as string }
            : { ...base, operation: job.operation };
    receipt = created;
    state.receipts.push(created);
    updateActiveTtl(state, created);
    await store.save(state);
    admitted = true;
  }
  const accepted = receipt;
  let refusal = accepted.outcome ? undefined : await prepare(accepted);
  if (job.operation === "restore" && !accepted.outcome) {
    const predecessorKey = generationKey(job.predecessor.request);
    if (
      (job.request.expiresAt ?? 0) <= now() ||
      [machineKey, predecessorKey].some(
        (key) =>
          state.cleanupGenerations?.includes(key) ||
          state.retention?.some(
            (entry) => generationKey(entry.request) === key && (entry.cleanupAuthorized || entry.deleted),
          ) ||
          state.resumeClaims?.some((claim) => claim.active && claim.accepted && generationKey(claim) === key),
      )
    )
      refusal = new Error("Restore generation unavailable");
  }
  return {
    job,
    held: polled.held === true,
    async work() {
      if (!accepted.outcome) {
        await perform(accepted, job, admitted, refusal);
        await exclusive(store, () => finish(accepted));
      }
      if (accepted.retentionProofPending && polled?.retainedStopProof) {
        await exclusive(store, async () => {
          const latest = await store.load();
          const saved = latest.receipts.find((item) => item.requestId === accepted.requestId);
          if (saved?.retentionProofPending) await reportRetainedStop(latest, saved);
        });
      } else if (accepted.operation === "stop") {
        await exclusive(store, async () => {
          const latest = await store.load();
          const saved = latest.receipts.find((item) => item.requestId === accepted.requestId) ?? accepted;
          await reportReceipt(latest, saved);
        });
      } else {
        await api.result(state, accepted);
      }
    },
  };
}

function allocationMachineId(result: unknown) {
  if (result === null || typeof result !== "object" || !("machineId" in result)) return undefined;
  const { machineId } = result;
  return typeof machineId === "string" && /^[a-f0-9]{64}$/.test(machineId) ? machineId : undefined;
}

function isUncertainDockerFailure(operation: Job["operation"], error: unknown) {
  return (
    (operation === "restore" || operation === "stop" || operation === "delete" || operation === "deletePhysical") &&
    error instanceof DockerMachineError &&
    error.code === "docker_failed"
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function generationKey(request: { sandboxId: string; generation: string }): string {
  return digest(JSON.stringify([request.sandboxId, request.generation]));
}
export function compactReceipts(state: State): void {
  state.cleanupLimit ??= Math.max(17408, state.receipts.length + (state.retired?.length ?? 0) + 1024);
  if (Buffer.byteLength(JSON.stringify(state)) < 1024 * 1024) return;
  state.retired ??= [];
  const retired = state.retired;
  const covered = new Set(state.retention?.map((entry) => generationKey(entry.request)));
  for (const receipt of state.receipts) {
    if (receipt.cleaned || (receipt.operation === "delete" && receipt.outcome === "completed")) {
      covered.add(generationKey(receipt.request));
    }
  }
  state.receipts = state.receipts.filter((receipt) => {
    if (!receipt.outcome || receipt.retentionProofPending || retired.length >= state.cleanupLimit!) return true;
    const closed =
      receipt.cleaned ||
      receipt.operation === "stop" ||
      receipt.operation === "delete" ||
      receipt.operation === "deletePhysical" ||
      receipt.operation === "buildSnapshot" ||
      (receipt.expired && receipt.expiryReported && !receipt.expiryOutputsPending);
    if (!closed) return true;
    if (
      receipt.operation !== "delete" &&
      receipt.operation !== "deletePhysical" &&
      receipt.operation !== "buildSnapshot" &&
      !covered.has(generationKey(receipt.request))
    )
      return true;
    const compacted: NonNullable<State["retired"]>[number] = [
      receipt.requestId,
      digest(
        JSON.stringify([receipt.operation, fingerprint(receipt), "inputHash" in receipt ? receipt.inputHash : null]),
      ),
      generationKey(receipt.request),
      digest(fingerprint(receipt)),
      receipt.operation,
      receipt.outcome,
      receipt.reason ?? null,
      receipt.operation === "buildSnapshot" ? (receipt.imageId ?? null) : null,
      receipt.operation === "buildSnapshot" ? (receipt.baselineVersion ?? null) : null,
      receipt.operation === "buildSnapshot" ? (receipt.baselineTool ?? null) : null,
      receipt.operation === "buildSnapshot" ? (receipt.missingRefIndex ?? null) : null,
    ];
    if (
      (receipt.operation === "create" || receipt.operation === "restore" || receipt.operation === "stop") &&
      receipt.machineId
    )
      compacted[11] = receipt.machineId;
    if (receipt.operation === "stop" && receipt.absentMachineId) {
      compacted[11] = null;
      compacted[12] = receipt.absentMachineId;
    }
    retired.push(compacted);
    return false;
  });
}
