import { createHash } from "node:crypto";
import {
  type BootstrapDescriptor,
  canonicalDockerHostJob,
  type DockerHostJob,
  parseDockerHostJob,
} from "../../core/src/docker-host-job.ts";
import type { DockerMachineRequest } from "../../core/src/docker-machine.ts";

export type Job = DockerHostJob;
export type Receipt = { requestId: string; request: DockerMachineRequest; outcome?: "completed" | "failed" } & (
  | { operation: "create" | "stop" | "delete" }
  | { operation: "bootstrap"; inputHash: string }
);
export type State = { server: string; installationId: string; hostId: string; hostToken: string; receipts: Receipt[] };
export interface Store {
  load(): Promise<State>;
  save(state: State): Promise<void>;
}
export interface Api {
  register(server: string, token: string, installationId: string): Promise<{ hostId: string; hostToken: string }>;
  poll(state: State): Promise<{ job: Job | null }>;
  result(state: State, receipt: Receipt): Promise<void>;
}
export interface Executor {
  startRuntime?(request: DockerMachineRequest, bootstrap: BootstrapDescriptor): Promise<unknown>;
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
  return JSON.stringify([r.sandboxId, r.generation, r.image, r.ttlSeconds]);
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
export async function tick(store: Store, api: Api, executor: Executor): Promise<void> {
  const state = await store.load();
  // Sweep even when the server is offline or has revoked the credential. One failed sweep cannot block others.
  for (const receipt of state.receipts.filter((r) => r.operation === "create" || r.operation === "bootstrap")) {
    try {
      await executor.stopIfExpired(receipt.request);
    } catch {
      /* retry next tick */
    }
  }
  async function execute(receipt: Receipt, job: Job, admitted: boolean) {
    if (receipt.outcome) return;
    try {
      if (receipt.operation === "bootstrap") {
        // A recovered pending receipt is uncertain, even if persistence preceded the actual call.
        if (!admitted || job.operation !== "bootstrap" || !executor.startRuntime)
          throw new Error("Unknown bootstrap outcome");
        await executor.startRuntime(receipt.request, job.bootstrap);
      } else await executor[receipt.operation](receipt.request);
      receipt.outcome = "completed";
    } catch {
      receipt.outcome = "failed";
    } // Uncertain native failure is terminal for this request identity.
    await store.save(state);
  }
  const polled = await api.poll(state);
  if (!polled.job) return;
  const job = parseDockerHostJob(polled.job);
  if (job.operation === "bootstrap" && job.bootstrap.serverUrl !== state.server)
    throw new Error("Wrong bootstrap origin");
  const inputHash =
    job.operation === "bootstrap"
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
      (receipt.operation === "bootstrap" && receipt.inputHash !== inputHash))
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
    receipt =
      job.operation === "bootstrap"
        ? { ...base, operation: "bootstrap", inputHash: inputHash as string }
        : { ...base, operation: job.operation };
    state.receipts.push(receipt);
    await store.save(state);
    admitted = true;
  }
  await execute(receipt, job, admitted);
  await api.result(state, receipt);
}
