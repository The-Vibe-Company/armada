import type { DockerMachineRequest } from "../../core/src/docker-machine.ts";

export type Job = { requestId: string; request: DockerMachineRequest; operation: "create" | "stop" | "delete" };
export type Receipt = Job & { outcome?: "completed" | "failed" };
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
function validJob(job: Job): boolean {
  const r = job?.request;
  return (
    !!r &&
    validId(job.requestId) &&
    ["create", "stop", "delete"].includes(job.operation) &&
    validId(r.sandboxId) &&
    validId(r.generation) &&
    typeof r.image === "string" &&
    /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/.test(r.image) &&
    Number.isInteger(r.ttlSeconds) &&
    r.ttlSeconds > 0 &&
    r.ttlSeconds <= 86_400
  );
}
function fingerprint(job: Job): string {
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
  for (const receipt of state.receipts.filter((r) => r.operation === "create")) {
    try {
      await executor.stopIfExpired(receipt.request);
    } catch {
      /* retry next tick */
    }
  }
  async function execute(receipt: Receipt) {
    if (receipt.outcome) return;
    try {
      await executor[receipt.operation](receipt.request);
      receipt.outcome = "completed";
    } catch {
      receipt.outcome = "failed";
    } // Uncertain native failure is terminal for this request identity.
    await store.save(state);
  }
  const { job } = await api.poll(state);
  if (!job) return;
  if (!validJob(job)) throw new Error("Invalid host job");
  let receipt = state.receipts.find((r) => r.requestId === job.requestId);
  if (receipt && (receipt.operation !== job.operation || fingerprint(receipt) !== fingerprint(job)))
    throw new Error("Changed host job");
  if (!receipt) {
    const generation = state.receipts.filter(
      (r) => r.request.sandboxId === job.request.sandboxId && r.request.generation === job.request.generation,
    );
    if (
      generation.some(
        (r) => fingerprint(r) !== fingerprint(job) || (r.operation === "create" && job.operation === "create"),
      )
    )
      throw new Error("Changed machine generation");
    receipt = { requestId: job.requestId, operation: job.operation, request: { ...job.request } };
    state.receipts.push(receipt);
    await store.save(state);
  }
  await execute(receipt);
  await api.result(state, receipt);
}
