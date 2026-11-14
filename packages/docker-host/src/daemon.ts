import { createHash } from "node:crypto";
import type { DockerJobFailureReason } from "../../core/src/docker-api.ts";
import {
  type BootstrapDescriptor,
  canonicalDockerHostJob,
  type DockerHostJob,
  parseDockerHostJob,
} from "../../core/src/docker-host-job.ts";
import { DockerMachineError, type DockerMachineRequest } from "../../core/src/docker-machine.ts";

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
  lastPollAt?: string;
  /** Fair bounded retries across retained confirmations and process restarts. */
  expiryReportAfter?: string;
};
export interface Store {
  load(): Promise<State>;
  save(state: State): Promise<void>;
}
export interface Api {
  register(server: string, token: string, installationId: string): Promise<{ hostId: string; hostToken: string }>;
  poll(state: State, options?: { skipSnapshots?: boolean }): Promise<{ job: Job | null }>;
  result(state: State, receipt: Receipt, expired?: true): Promise<void>;
}
export interface Executor {
  buildSnapshot?(job: Extract<Job, { operation: "buildSnapshot" }>, recoverOnly?: boolean): Promise<string>;
  startRuntime?(request: DockerMachineRequest, bootstrap: BootstrapDescriptor): Promise<unknown>;
  resume?(request: DockerMachineRequest): Promise<unknown>;
  create(request: DockerMachineRequest): Promise<unknown>;
  stop(request: DockerMachineRequest): Promise<unknown>;
  delete(request: DockerMachineRequest): Promise<unknown>;
  stopIfExpired(request: DockerMachineRequest): Promise<unknown>;
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
export async function tick(store: Store, api: Api, executor: Executor, skipSnapshots = false): Promise<void> {
  const state = await store.load();
  // Sweep even when the server is offline or has revoked the credential. One failed sweep cannot block others.
  for (const receipt of state.receipts.filter(
    (r) => r.operation === "create" || r.operation === "bootstrap" || r.operation === "resume",
  )) {
    try {
      if ((await executor.stopIfExpired(receipt.request)) === true && !receipt.expired) {
        receipt.expired = true;
        try {
          await store.save(state);
        } catch {
          // Never publish a confirmation that has not survived persistence.
          delete receipt.expired;
        }
      }
    } catch {
      /* retry the sweep; an earlier durable confirmation can still be reported */
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
    Object.assign(state, latest);
    await store.save(state);
  }
  const polled = await api.poll(state, { skipSnapshots });
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
    await store.save(state);
    admitted = true;
  }
  await execute(receipt, job, admitted);
  await api.result(state, receipt);
}
