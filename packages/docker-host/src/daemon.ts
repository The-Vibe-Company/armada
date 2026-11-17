import { createHash } from "node:crypto";
import type { DockerJobFailureReason } from "../../core/src/docker-api.ts";
import { DOCKER_DISK_FLOOR_BYTES, DockerDiskFloorError } from "../../core/src/docker-disk-policy.ts";
import {
  type BootstrapDescriptor,
  canonicalDockerHostJob,
  type DockerHostJob,
  parseDockerHostJob,
} from "../../core/src/docker-host-job.ts";
import { DockerMachineError, type DockerMachineRequest } from "../../core/src/docker-machine.ts";
import type { DockerSandboxLimits } from "../../core/src/docker-resource-policy.ts";

export type Job = DockerHostJob;
export type Receipt = {
  requestId: string;
  request: DockerMachineRequest;
  outcome?: "completed" | "failed";
  /** Why a failed machine operation failed, when it is one the person can act on (#1507). */
  reason?: DockerJobFailureReason;
  /** Durable positive local stop proof, separate from the original job outcome. */
  expired?: true;
  cleaned?: true;
  expiryReported?: true;
} & (
  | { operation: "create" | "stop" | "delete" }
  | { operation: "bootstrap" | "resume"; inputHash: string }
  | { operation: "buildSnapshot"; inputHash: string; imageId?: string }
);
export type State = {
  server: string;
  installationId: string;
  hostId: string;
  hostToken: string;
  receipts: Receipt[];
  /** Permanent compact replay fences; never evict within an installation. */
  retired?: [
    requestId: string,
    hash: string,
    generation: string,
    machineHash: string,
    operation: Receipt["operation"],
    outcome: "completed" | "failed",
    reason: DockerJobFailureReason | null,
    imageId: string | null,
  ][];
  cleanupLimit?: number;
  /** Local durable retention obligations survive receipt compaction and offline polls. */
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
  /** Receipt identities for unique active generations, in fair sweep order. */
  activeTtl?: string[];
  /** Fair bounded retries across retained confirmations and process restarts. */
  expiryReportAfter?: string;
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
      /** Ask the server to hold the poll until work exists, at most this long (#2561). */
      waitSeconds?: number;
      /** Request IDs still executing here; the server hands out other sandboxes' jobs. */
      running?: string[];
    },
  ): Promise<{
    job: Job | null;
    /** The server held this poll until work existed or its hold elapsed. */
    held?: true;
    limits?: DockerSandboxLimits;
    retentionSeconds?: number;
    /** Every generation with a queued resume/bootstrap, not only the job handed out. */
    pendingStarts?: { sandboxId: string; generation: string }[];
    resumeClaims?: { requestId: string; sandboxId: string; generation: string }[];
  }>;
  result(state: State, receipt: Receipt, expired?: true): Promise<void>;
  claim?(state: State, requestId: string, accepted: boolean): Promise<void>;
  cleaned?(state: State, requestId: string, reason?: "retention_elapsed" | "disk_pressure"): Promise<void>;
}
export interface Executor {
  diskFreeBytes?(): Promise<number | null>;
  cleanupImages?(): Promise<void>;
  configureLimits?(limits: DockerSandboxLimits | undefined): void;
  buildSnapshot?(job: Extract<Job, { operation: "buildSnapshot" }>, recoverOnly?: boolean): Promise<string>;
  startRuntime?(request: DockerMachineRequest, bootstrap: BootstrapDescriptor): Promise<unknown>;
  resume?(request: DockerMachineRequest): Promise<unknown>;
  create(request: DockerMachineRequest): Promise<unknown>;
  stop(request: DockerMachineRequest): Promise<unknown>;
  delete(request: DockerMachineRequest): Promise<unknown>;
  stopIfExpired(request: DockerMachineRequest): Promise<unknown>;
  deleteStopped?(request: DockerMachineRequest): Promise<void>;
  isRunning?(request: DockerMachineRequest): Promise<boolean>;
  isAbsent?(request: DockerMachineRequest): Promise<boolean>;
  stoppedAt?(request: DockerMachineRequest): Promise<number | null>;
  isStopped?(request: DockerMachineRequest): Promise<boolean>;
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
    (receipt.operation === "create" || receipt.operation === "bootstrap" || receipt.operation === "resume") &&
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
  const result = await api.register(origin, token, installationId); // Single-use exchange: never retry.
  if (!validId(result.hostId) || !validToken(result.hostToken)) throw new Error("Invalid host registration");
  await store.save({
    server: origin,
    installationId,
    hostId: result.hostId,
    hostToken: result.hostToken,
    receipts: [],
  });
}
/**
 * Read-only physical lane. Admission is fenced per generation, not per batch:
 * a slow inspection must not suppress later checks of other allocations.
 * Only the mailbox persists/reports the observed physical facts.
 */
export function createPhysicalExpirySweep(store: Store, executor: Executor) {
  const pending = new Map<string, Promise<void>>();
  return {
    async sweep(): Promise<void> {
      const state = await store.load();
      const candidates = new Map<string, DockerMachineRequest>();
      const active = state.activeTtl ? new Set(state.activeTtl) : undefined;
      for (const receipt of state.receipts) {
        if (active && !active.has(receipt.requestId)) continue;
        if (receipt.operation === "create" || receipt.operation === "bootstrap" || receipt.operation === "resume") {
          if (!receipt.expired) candidates.set(generationKey(receipt.request), receipt.request);
        }
      }
      for (const [key, request] of candidates) {
        if (pending.has(key)) continue;
        const task = Promise.resolve()
          .then(() => executor.stopIfExpired(request))
          .catch(() => {
            // Failed inspection is not absence or ownership proof. Retry next sweep.
          })
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

/**
 * What a tick did, so the caller paces itself: `worked` and `held` poll again at
 * once, `busy` waits for a running job, `idle` (a server that cannot hold a
 * poll) waits out the daemon's own idle period.
 */
export type TickOutcome = "worked" | "held" | "busy" | "idle";
export type TickOptions = {
  /** Ask the server to hold the poll open until work exists, at most this long. */
  waitSeconds?: number;
  /** Request IDs whose machine operation is still executing in this process. */
  running?: ReadonlySet<string>;
  /** Sandboxes whose machine operation is still executing in this process. */
  sandboxes?: ReadonlySet<string>;
  /**
   * Receives an admitted machine operation instead of awaiting it, so the next
   * tick can take another sandbox's job. The durable receipt is already saved;
   * `work` runs the operation, durably completes the receipt and reports it.
   */
  dispatch?: (job: Job, work: Promise<void>) => void;
};

const ledgers = new WeakMap<Store, Promise<void>>();
/**
 * Every read-modify-write of the durable ledger is serialized per store; machine
 * operations and held polls are not, so a running job can always complete.
 */
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

/**
 * One production iteration. Durable receipts precede all machine operations.
 * Ledger work is serialized per store; the admitted machine operation runs
 * outside that section, so jobs of different sandboxes can run concurrently
 * while the server keeps each sandbox's jobs serial (#2561).
 */
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
  // Only a server that held the poll excludes `running` work; an older one gets
  // the previous serial execution, so one sandbox's jobs never overlap.
  if (options.dispatch && step.held) {
    options.dispatch(step.job, step.work());
    return "worked";
  }
  await step.work();
  return "worked";
}

/** Most machine operations one daemon runs at once; each sandbox stays serial. */
export const DOCKER_HOST_CONCURRENT_JOBS = 4;
/** How long the daemon asks the server to hold an idle poll open. */
export const DOCKER_HOST_POLL_WAIT_SECONDS = 20;
/** Pause after a failed tick, or between polls when the server cannot hold one. */
export const DOCKER_HOST_IDLE_MS = 20_000;

/**
 * The daemon's mailbox loop (#2561). It polls again as soon as a job was taken or
 * a held poll ended, so ready jobs drain without an idle period, and it runs up to
 * DOCKER_HOST_CONCURRENT_JOBS operations of different sandboxes at once. It
 * pauses only after a failure, against a server that cannot hold a poll, or
 * while the server can only re-deliver work that is already running.
 */
export async function runJobs(
  store: Store,
  api: Api,
  executor: Executor,
  loop: {
    stopping(): boolean;
    sleep(ms: number): Promise<unknown>;
    beforeTick?(): Promise<void>;
    failed?(what: "tick" | "job"): void;
    now?: () => number;
  },
): Promise<void> {
  const running = new Map<string, { sandboxId: string; snapshot: boolean; done: Promise<void> }>();
  // Counts finished operations. A tick checks the job it receives against the
  // work running when it started; if some of that work finished meanwhile (a
  // create completing during the held poll that returns its bootstrap), the
  // refused job may now be admissible, so the loop polls again at once.
  let finished = 0;
  const settled = () => Promise.race([...running.values()].map((job) => job.done));
  try {
    while (!loop.stopping()) {
      await loop.beforeTick?.();
      if (running.size >= DOCKER_HOST_CONCURRENT_JOBS) {
        await settled();
        continue;
      }
      const finishedBefore = finished;
      let outcome: TickOutcome;
      try {
        outcome = await tick(
          store,
          api,
          executor,
          [...running.values()].some((job) => job.snapshot),
          loop.now ?? Date.now,
          {
            waitSeconds: DOCKER_HOST_POLL_WAIT_SECONDS,
            running: new Set(running.keys()),
            sandboxes: new Set([...running.values()].map((job) => job.sandboxId)),
            dispatch(job, work) {
              const done = work
                .catch(() => loop.failed?.("job"))
                .finally(() => {
                  running.delete(job.requestId);
                  finished++;
                });
              running.set(job.requestId, {
                sandboxId: job.request.sandboxId,
                snapshot: job.operation === "buildSnapshot",
                done,
              });
            },
          },
        );
      } catch {
        loop.failed?.("tick");
        outcome = "idle";
      }
      if (loop.stopping()) break;
      if (outcome === "busy" && finished !== finishedBefore) continue;
      if (outcome === "busy" && running.size) await Promise.race([settled(), loop.sleep(DOCKER_HOST_IDLE_MS)]);
      else if (outcome === "busy" || outcome === "idle") await loop.sleep(DOCKER_HOST_IDLE_MS);
    }
  } finally {
    await Promise.all([...running.values()].map((job) => job.done));
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
  // Preserve stopped age before capping deadlines, including ledgers from older daemons.
  for (const entry of state.retention) {
    entry.observedStoppedAt ??= entry.deadline - retentionSeconds * 1000;
    if (!entry.deleted) entry.deadline = deadline(entry.request, entry.observedStoppedAt);
  }
  // Claims cannot outlive the allocation's immutable physical expiry. A
  // server cannot admit a resume beyond this same frozen expiry, so releasing
  // the hold here is safe even while offline. Retain its historical ACK.
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
  // Observe exact owned allocations even while disconnected. Never infer physical exit from a failed RPC.
  if (executor.isStopped) {
    const candidates = new Map<string, Receipt>();
    for (const receipt of state.receipts) {
      if (receipt.cleaned || receipt.operation === "buildSnapshot" || receipt.operation === "delete") continue;
      candidates.set(generationKey(receipt.request), receipt);
    }
    // An admitted but unfinished operation may still be recovered below. Absence
    // before its first execution is not loss of a completed allocation.
    const values = [...candidates.values()].filter((receipt) => receipt.outcome);
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
      } catch {
        /* Unknown ownership or disk failure never authorizes deletion. */
      }
    }
  }
  // Poll once before local retention deletion. A resume already admitted by the
  // server is only observable from the mailbox, and deleting its stopped
  // allocation first would destroy the workspace the resume is claiming. Local
  // retention still runs while offline: the poll error is rethrown after it.
  // The poll may be held open by the server, so it runs outside the ledger
  // section: running jobs keep completing meanwhile. Only their completions can
  // write the ledger in that window, so with jobs running it is saved before
  // and reloaded after. A ledger that cannot be saved first could not be
  // reconciled with a completion saved during the poll, and a later write of it
  // would erase that completion and its replay fence. That save error therefore
  // ends this tick before polling: everything computed above is derived again
  // from the durable ledger on the next tick, and physical expiry runs on its own.
  const reload = Boolean(options.running?.size);
  if (reload) await store.save(state);
  lock.release();
  let polled: Awaited<ReturnType<Api["poll"]>> | undefined;
  let pollError: unknown;
  try {
    polled = await api.poll(state, {
      skipSnapshots,
      ...(options.waitSeconds === undefined
        ? {}
        : { waitSeconds: options.waitSeconds, running: [...(options.running ?? [])] }),
    });
  } catch (error) {
    pollError = error;
  } finally {
    lock.release = await acquire(store);
  }
  if (reload) {
    state = await store.load();
    state.retention ??= [];
    expiredGenerations = expired(state);
  }
  // A claim and cleanup authorization are serialized by this single durable
  // host ledger. Merely requesting a resume on the server never admits it.
  let unacknowledged = 0;
  for (const intent of polled?.resumeClaims ?? []) {
    state.resumeClaims ??= [];
    let claim = state.resumeClaims.find((item) => item.requestId === intent.requestId);
    if (!claim) {
      const key = generationKey(intent);
      const lost =
        expiredGenerations.has(key) ||
        state.cleanupGenerations?.includes(key) ||
        state.retention.some(
          (entry) => generationKey(entry.request) === key && (entry.cleanupAuthorized || entry.deleted),
        ) ||
        state.receipts.some(
          (receipt) => generationKey(receipt.request) === key && (receipt.cleaned || receipt.operation === "delete"),
        ) ||
        state.retired?.some((receipt) => receipt[2] === key && receipt[4] === "delete");
      claim = { ...intent, accepted: !lost, active: !lost };
      state.resumeClaims.push(claim);
      if (claim.accepted) state.retention = state.retention.filter((entry) => generationKey(entry.request) !== key);
      await store.save(state); // fsync before acknowledging; crashes cannot resurrect cleanup.
    }
    if (expiredGenerations.has(generationKey(claim))) {
      unacknowledged++;
      continue;
    }
    try {
      await api.claim?.(state, claim.requestId, claim.accepted);
    } catch (error) {
      pollError = error;
    }
  }
  // Resume intent cancels this generation's local cleanup deadline before the
  // deletion pass; a later failed resume is rediscovered as a stopped receipt.
  // The server serves one job per poll, ordered so every stop/delete precedes
  // startup work, so a resume queued behind another job is invisible in
  // `polled.job`. The poll therefore also reports every held generation with a
  // pending resume/bootstrap; all of them fence deletion, not only the head.
  // An entry already physically deleted keeps its pending cleaned report: the
  // workspace is gone, so the server must still learn that fact.
  const claimed = new Set<string>();
  for (const request of polled?.pendingStarts ?? []) {
    const key = generationKey(request);
    if (!expiredGenerations.has(key)) claimed.add(key);
  }
  if (polled?.job) {
    try {
      const observed = parseDockerHostJob(polled.job);
      if (observed.operation === "bootstrap" || observed.operation === "resume")
        if (!expiredGenerations.has(generationKey(observed.request))) claimed.add(generationKey(observed.request));
    } catch {
      // An invalid mailbox payload is rejected when it is executed below.
    }
  }
  if (claimed.size)
    state.retention = state.retention.filter((entry) => entry.deleted || !claimed.has(generationKey(entry.request)));
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
  // Pressure cleanup shares the same durable authorization as retention. Discovery
  // stays restricted to known completed operations; physical ownership is checked
  // by isStopped and again by deleteStopped. Claims survive disconnected polls.
  const pressure = async () => {
    const bytes = await executor.diskFreeBytes?.();
    return typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 && bytes < DOCKER_DISK_FLOOR_BYTES;
  };
  if (await pressure()) {
    const latest = new Map<string, Receipt>();
    for (const receipt of state.receipts) latest.set(generationKey(receipt.request), receipt);
    for (const [key, receipt] of latest) {
      if (
        !receipt.outcome ||
        receipt.cleaned ||
        receipt.operation === "delete" ||
        receipt.operation === "buildSnapshot" ||
        claimed.has(key) ||
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
      } catch {
        /* An uncertain inspection never authorizes deletion. */
      }
    }
    await store.save(state);
    const stoppedTimes = new Map<string, number>();
    for (const entry of state.retention) {
      try {
        const stoppedAt = await executor.stoppedAt?.(entry.request);
        if (stoppedAt !== null && stoppedAt !== undefined) stoppedTimes.set(entry.requestId, stoppedAt);
      } catch {
        /* Ownership is checked again before deletion. */
      }
    }
    const age = (entry: NonNullable<State["retention"]>[number]) =>
      stoppedTimes.get(entry.requestId) ?? entry.observedStoppedAt ?? entry.deadline - retentionSeconds * 1000;
    for (const entry of [...state.retention].sort((a, b) => age(a) - age(b))) {
      if (!(await pressure())) break;
      const key = generationKey(entry.request);
      if (
        entry.deleted ||
        claimed.has(key) ||
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
        await store.save(state); // Fence resume durably before physical deletion.
        await executor.deleteStopped(entry.request);
        entry.deleted = true;
        await store.save(state);
      } catch {
        /* Preserve the authorization and reason for safe retry. */
      }
    }
    if (await pressure()) {
      try {
        await executor.cleanupImages?.();
      } catch {
        /* Best-effort image cleanup must not block TTL or deletion reports. */
      }
    }
  }
  // One physical cleanup per tick, rotated durably even when Docker refuses it.
  // Reporting is deliberately deferred until after all local physical TTL work.
  const deleteAfter = state.retention.findIndex((entry) => entry.requestId === state.retentionDeleteAfter);
  const due = [...state.retention.slice(deleteAfter + 1), ...state.retention.slice(0, deleteAfter + 1)].find(
    (entry) => !entry.deleted && entry.deadline <= now(),
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
    } catch {
      /* Exact idempotent cleanup retries on a later fair local iteration. */
    }
  }
  // Upgrade legacy state once. Replay identity is retained independently of TTL work.
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
      // Compacted launch receipts carry durable reported expiry proof. Deletes
      // are permanent; snapshots do not describe a running machine.
      else if (retired[4] !== "buildSnapshot") terminal.add(retired[2]);
    }
    for (const receipt of state.receipts) {
      const key = generationKey(receipt.request);
      if (terminal.has(key) || (stopped.has(key) && !resumed.has(key))) continue;
      // Old compaction lost stop/resume ordering. A retained resume is uncertain,
      // not terminal evidence: keep its local expiry obligation rather than
      // disabling offline TTL for a legitimately resumed container.
      updateActiveTtl(state, receipt);
    }
  }
  // One generation per tick bounds the serial Docker prefix. Rotate durably before
  // attempting I/O, so a failing generation cannot monopolize subsequent ticks.
  const id = state.activeTtl.shift();
  if (id) {
    state.activeTtl.push(id);
    try {
      await store.save(state);
    } catch {
      // Disk failure must not disable local physical expiry.
    }
    const receipt = state.receipts.find((r) => r.requestId === id);
    if (receipt) {
      try {
        if ((await executor.stopIfExpired(receipt.request)) === true) {
          receipt.expired = true;
          state.activeTtl = state.activeTtl.filter((item) => item !== id);
          try {
            await store.save(state);
          } catch {
            // No durable proof: retain the retry and never publish confirmation.
            delete receipt.expired;
            state.activeTtl.push(id);
          }
        }
      } catch {
        /* uncertain ownership/stop: retry on a later fair turn */
      }
    }
  }
  const cleanAfter = state.retention.findIndex((entry) => entry.requestId === state.retentionReportAfter);
  const cleaned = [...state.retention.slice(cleanAfter + 1), ...state.retention.slice(0, cleanAfter + 1)].find(
    (entry) => entry.deleted,
  );
  if (cleaned && api.cleaned) {
    try {
      state.retentionReportAfter = cleaned.requestId;
      await store.save(state);
      await api.cleaned(state, cleaned.requestId, cleaned.cleanupReason);
      for (const receipt of state.receipts) {
        if (generationKey(receipt.request) === generationKey(cleaned.request)) receipt.cleaned = true;
      }
      state.activeTtl = state.activeTtl?.filter(
        (id) => !state.receipts.some((receipt) => receipt.requestId === id && receipt.cleaned),
      );
      state.retention = state.retention.filter((entry) => entry !== cleaned);
      await store.save(state);
    } catch {
      /* Retry one durable physical-cleanup report per tick, without delaying local expiry. */
    }
  }
  // Never let offline reporting delay another machine's physical TTL sweep.
  // One bounded HTTP attempt per tick, round-robin even across process restart.
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
      await store.save(state);
    } catch {
      // Offline/unknown ACK: retry this same durable fact on a later fair turn.
    }
  }
  /** Ledger-side preconditions, inside the serialized section. Returns a refusal. */
  async function prepare(receipt: Receipt): Promise<unknown> {
    try {
      if (
        (receipt.operation === "stop" || receipt.operation === "delete") &&
        state.resumeClaims?.some(
          (claim) => claim.active && claim.accepted && generationKey(claim) === generationKey(receipt.request),
        )
      )
        throw new Error("Generation claimed for resume");
      if (receipt.operation === "delete") {
        state.cleanupGenerations ??= [];
        state.cleanupGenerations.push(generationKey(receipt.request));
        await store.save(state);
      }
      return undefined;
    } catch (error) {
      return error;
    }
  }
  /** The machine operation itself, outside the serialized ledger section. */
  const dispatched = Boolean(options.dispatch && polled?.held);
  async function perform(receipt: Receipt, job: Job, admitted: boolean, refusal: unknown) {
    try {
      if (refusal) throw refusal;
      if (receipt.operation === "buildSnapshot") {
        if (job.operation !== "buildSnapshot" || !executor.buildSnapshot) throw Error("Snapshot builds unavailable.");
        let sweeping: Promise<unknown> | undefined;
        // A caller that dispatched this build keeps ticking itself; a build run
        // inline (serial caller, or a server that cannot hold a poll) sweeps from here.
        const timer = dispatched
          ? undefined
          : setInterval(async () => {
              if (sweeping) return;
              sweeping = tick(store, api, executor, true).catch(() => {});
              await sweeping;
              sweeping = undefined;
            }, 10000);
        try {
          receipt.imageId = await executor.buildSnapshot(job, !admitted);
        } finally {
          clearInterval(timer);
          await sweeping;
        }
      } else if (receipt.operation === "bootstrap" || receipt.operation === "resume") {
        // A recovered pending receipt is uncertain, even if persistence preceded the actual call.
        if (!admitted || (job.operation !== "bootstrap" && job.operation !== "resume") || !executor.startRuntime)
          throw new Error("Unknown bootstrap outcome");
        if (receipt.operation === "resume") {
          if (!executor.resume) throw new Error("Resume unavailable");
          await executor.resume(receipt.request);
        }
        await executor.startRuntime(receipt.request, job.bootstrap);
      } else {
        await executor[receipt.operation](receipt.request);
      }
      receipt.outcome = "completed";
    } catch (error) {
      receipt.outcome = "failed";
      if (error instanceof DockerDiskFloorError) receipt.reason = "disk_full";
      else if (receipt.operation === "buildSnapshot") {
        receipt.reason = "snapshot_build_failed";
        // Do not log exception text: build output and init commands can contain credentials.
        console.error(
          `Snapshot ${receipt.request.sandboxId}: Snapshot image build failed. Check registry access, repository access, init commands and the secret scan; build output is suppressed to protect secrets.`,
        );
      } else if (error instanceof DockerMachineError && error.code === "image_unavailable") receipt.reason = error.code;
    } // Uncertain native failure is terminal for this request identity.
  }
  /** Durable completion, back inside the serialized section. */
  async function finish(receipt: Receipt) {
    // Reload durable state: other ticks may have saved while the operation ran.
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
  if (pollError) throw pollError;
  if (!polled) throw pollError ?? new Error("Host poll unavailable");
  if (!polled.job) {
    await store.save(state);
    // A claim this host cannot acknowledge would end every held poll at once.
    return polled.held && !unacknowledged ? "held" : "idle";
  }
  const job = parseDockerHostJob(polled.job);
  if ((job.operation === "bootstrap" || job.operation === "resume") && job.bootstrap.serverUrl !== state.server)
    throw new Error("Wrong bootstrap origin");
  // A server that cannot exclude running work re-delivers it; never treat
  // this process's own in-flight operation as an uncertain recovery. Such a
  // server (no held poll) may also hand out a later job of a sandbox whose
  // operation is still running, so nothing is admitted until local work drains;
  // the unadmitted job is delivered again. The server frees a sandbox once a
  // job's outcome is recorded, and it records one without the host when it
  // cancels queued work (revocation, owner removal, snapshot build expiry). So
  // this host keeps each sandbox, and snapshot builds, serial itself.
  if (
    options.running?.has(job.requestId) ||
    (options.running?.size && !polled.held) ||
    options.sandboxes?.has(job.request.sandboxId) ||
    (skipSnapshots && job.operation === "buildSnapshot")
  ) {
    await store.save(state);
    return "busy";
  }
  const inputHash =
    job.operation === "bootstrap" || job.operation === "resume" || job.operation === "buildSnapshot"
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
      ((receipt.operation === "bootstrap" || receipt.operation === "resume" || receipt.operation === "buildSnapshot") &&
        receipt.inputHash !== inputHash))
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
      } as Receipt;
      await api.result(state, replay);
      return "worked";
    }
    const oldGeneration = retired.filter((r) => r[2] === generationKey(job.request));
    const cleanup = job.operation === "stop" || job.operation === "delete";
    if (
      oldGeneration.some((r) => r[3] !== digest(fingerprint(job))) ||
      oldGeneration.some(
        (r) =>
          r[4] === job.operation &&
          (job.operation === "create" || job.operation === "bootstrap" || job.operation === "buildSnapshot"),
      )
    )
      throw new Error("Retired machine generation");
    // Reserve durable space for cleanup and TTL updates, not just the next launch.
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
          (r.operation === "create" && job.operation === "create") ||
          (r.operation === "bootstrap" && job.operation === "bootstrap"),
      )
    )
      throw new Error("Changed machine generation");
    const base = { requestId: job.requestId, request: { ...job.request } };
    const created: Receipt =
      job.operation === "buildSnapshot"
        ? { ...base, operation: "buildSnapshot", inputHash: inputHash as string }
        : job.operation === "bootstrap" || job.operation === "resume"
          ? { ...base, operation: job.operation, inputHash: inputHash as string }
          : { ...base, operation: job.operation };
    receipt = created;
    state.receipts.push(created);
    updateActiveTtl(state, created);
    await store.save(state);
    admitted = true;
  }
  const accepted = receipt;
  const refusal = accepted.outcome ? undefined : await prepare(accepted);
  return {
    job,
    held: polled.held === true,
    async work() {
      if (!accepted.outcome) {
        await perform(accepted, job, admitted, refusal);
        await exclusive(store, () => finish(accepted));
      }
      await api.result(state, accepted);
    },
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function generationKey(request: { sandboxId: string; generation: string }): string {
  return digest(JSON.stringify([request.sandboxId, request.generation]));
}
/** Lossless identity fences: old requests are rejected, never re-executed.
 * Keep live TTL obligations and all uncertain receipts in full.
 */
export function compactReceipts(state: State): void {
  state.cleanupLimit ??= Math.max(17408, state.receipts.length + (state.retired?.length ?? 0) + 1024);
  if (Buffer.byteLength(JSON.stringify(state)) < 1024 * 1024) return;
  state.retired ??= [];
  const retired = state.retired;
  // Replay finality is not physical deletion. Until discovery has persisted an
  // exact-generation obligation, keep the request that lets a later tick observe it.
  const covered = new Set(state.retention?.map((entry) => generationKey(entry.request)));
  for (const receipt of state.receipts) {
    if (receipt.cleaned || (receipt.operation === "delete" && receipt.outcome === "completed")) {
      covered.add(generationKey(receipt.request));
    }
  }
  state.receipts = state.receipts.filter((receipt) => {
    if (!receipt.outcome || retired.length >= state.cleanupLimit!) return true;
    const closed =
      receipt.cleaned ||
      receipt.operation === "stop" ||
      receipt.operation === "delete" ||
      receipt.operation === "buildSnapshot" ||
      (receipt.expired && receipt.expiryReported);
    if (!closed) return true;
    if (
      receipt.operation !== "delete" &&
      receipt.operation !== "buildSnapshot" &&
      !covered.has(generationKey(receipt.request))
    )
      return true;
    retired.push([
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
    ]);
    return false;
  });
}
