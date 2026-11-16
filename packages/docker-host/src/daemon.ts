import { createHash } from "node:crypto";
import type { DockerJobFailureReason } from "../../core/src/docker-api.ts";
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
  retention?: { request: DockerMachineRequest; requestId: string; deadline: number; deleted?: true }[];
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
    options?: { skipSnapshots?: boolean },
  ): Promise<{ job: Job | null; limits?: DockerSandboxLimits; retentionSeconds?: number }>;
  result(state: State, receipt: Receipt, expired?: true): Promise<void>;
  cleaned?(state: State, requestId: string): Promise<void>;
}
export interface Executor {
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
/** One serialized production iteration. Durable receipts precede all machine operations. */
export async function tick(
  store: Store,
  api: Api,
  executor: Executor,
  skipSnapshots = false,
  now = Date.now,
): Promise<void> {
  const state = await store.load();
  state.retention ??= [];
  const retentionSeconds = state.retentionSeconds ?? 86400;
  if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds < 0) throw Error("Invalid retention policy");
  // Observe exact owned allocations even while disconnected. Never infer physical exit from a failed RPC.
  if (executor.isStopped) {
    const candidates = new Map<string, Receipt>();
    for (const receipt of state.receipts) {
      if (receipt.operation === "buildSnapshot" || receipt.operation === "delete") continue;
      candidates.set(generationKey(receipt.request), receipt);
    }
    const values = [...candidates.values()];
    const after = values.findIndex((receipt) => receipt.requestId === state.retentionScanAfter);
    const receipt = values[(after + 1) % values.length];
    if (receipt) {
      state.retentionScanAfter = receipt.requestId;
      const key = generationKey(receipt.request);
      const scheduled = state.retention.find((entry) => generationKey(entry.request) === key);
      try {
        const stopped = await executor.isStopped(receipt.request);
        if (!stopped && scheduled && !scheduled.deleted && (await executor.isRunning?.(receipt.request)) === true) {
          state.retention = state.retention.filter((entry) => entry !== scheduled);
          await store.save(state);
        }
        if (stopped && !scheduled) {
          state.retention.push({
            request: receipt.request,
            requestId: receipt.requestId,
            deadline: now() + retentionSeconds * 1000,
          });
          await store.save(state);
        }
      } catch {
        /* Unknown ownership or disk failure never authorizes deletion. */
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
      await api.cleaned(state, cleaned.requestId);
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
    (receipt) => receipt.expired && !receipt.expiryReported,
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
  async function execute(receipt: Receipt, job: Job, admitted: boolean) {
    if (receipt.outcome) return;
    try {
      if (receipt.operation === "buildSnapshot") {
        if (job.operation !== "buildSnapshot" || !executor.buildSnapshot) throw Error("Snapshot builds unavailable.");
        let sweeping: Promise<void> | undefined;
        const timer = setInterval(async () => {
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
      } else await executor[receipt.operation](receipt.request);
      receipt.outcome = "completed";
    } catch (error) {
      receipt.outcome = "failed";
      if (receipt.operation === "buildSnapshot") {
        receipt.reason = "snapshot_build_failed";
        // Do not log exception text: build output and init commands can contain credentials.
        console.error(
          `Snapshot ${receipt.request.sandboxId}: Snapshot image build failed. Check registry access, repository access, init commands and the secret scan; build output is suppressed to protect secrets.`,
        );
      } else if (error instanceof DockerMachineError && error.code === "image_unavailable") receipt.reason = error.code;
    } // Uncertain native failure is terminal for this request identity.
    // A long build continues ordinary mailbox/TTL work; merge its receipt into the latest durable state.
    const latest = await store.load();
    const saved = latest.receipts.find((item) => item.requestId === receipt.requestId);
    if (!saved) throw Error("Missing durable receipt");
    Object.assign(saved, receipt);
    if (receipt.operation === "resume" && receipt.outcome === "completed")
      latest.retention = (latest.retention ?? []).filter(
        (entry) => generationKey(entry.request) !== generationKey(receipt.request),
      );
    updateActiveTtl(latest, saved);
    Object.assign(state, latest);
    await store.save(state);
  }
  const polled = await api.poll(state, { skipSnapshots });
  executor.configureLimits?.(polled.limits);
  if (polled.retentionSeconds !== undefined) {
    const seconds = polled.retentionSeconds;
    if (!Number.isSafeInteger(seconds) || seconds < 0) throw Error("Invalid retention policy");
    const previous = state.retentionSeconds ?? 86400;
    for (const entry of state.retention ?? []) if (!entry.deleted) entry.deadline += (seconds - previous) * 1000;
    state.retentionSeconds = seconds;
    state.retentionPolicyFromServer = true;
    await store.save(state);
  }
  state.lastPollAt = new Date().toISOString();
  if (!polled.job) {
    await store.save(state);
    return;
  }
  const job = parseDockerHostJob(polled.job);
  if ((job.operation === "bootstrap" || job.operation === "resume") && job.bootstrap.serverUrl !== state.server)
    throw new Error("Wrong bootstrap origin");
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
      return;
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
  await execute(receipt, job, admitted);
  await api.result(state, receipt);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function generationKey(request: DockerMachineRequest): string {
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
  state.receipts = state.receipts.filter((receipt) => {
    if (!receipt.outcome || retired.length >= state.cleanupLimit!) return true;
    const closed =
      receipt.operation === "stop" ||
      receipt.operation === "delete" ||
      receipt.operation === "buildSnapshot" ||
      (receipt.expired && receipt.expiryReported);
    if (!closed) return true;
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
