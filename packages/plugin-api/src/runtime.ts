import type { ProviderConnection } from "./connection.js";
import type { ProjectRequest } from "./index.js";
import type { TestMergeRequest, TestMergeResult } from "./merge.js";

/** A provider can prove that native creation was never entered; every other launch error is an unknown outcome. */
export class RuntimeLaunchRefusal extends Error {
  override readonly name = "RuntimeLaunchRefusal";
}
/** Name survives a separately bundled SDK copy in a plugin. Plugins remain trusted installed code. */
export const isRuntimeLaunchRefusal = (value: unknown): value is RuntimeLaunchRefusal =>
  value instanceof Error && value.name === "RuntimeLaunchRefusal";

export interface Workspace {
  id: string;
  path: string;
  node: string;
}
export interface PrepareRequest extends ProjectRequest {
  ticket: string;
  repository: string;
  branch: string;
  /** Hosted runtime configuration can be checked before any native creation. */
  labels?: string[];
  profile?: string;
}
/** Generation is pinned on every action, including delivery and stop. */
export interface WorkerRef {
  project: string;
  ticket: string;
  session: string;
  generation: number;
  handle: string;
}
export interface LaunchRequest {
  /** Host-reserved local identity, journaled before process creation. Hosted runtimes return their native handle. */
  handle?: string;
  workspace: Workspace;
  worker: Omit<WorkerRef, "handle">;
  /** Empty selects the runtime's official CLI; a nonempty command is a host override (e.g. conformance). Nodes receive only resolved commands. */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Hosted runtimes consume the brief through stdin during creation. Never persist it. */
  brief?: string;
  labels?: string[];
  baseBranch?: string;
}
/** Cumulative since this worker generation launched; omitted counters are explicitly unknown. */
export interface WorkerUsage {
  /** Known counters remain lower bounds after an unreported turn. */
  incomplete?: boolean;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  model: string | null;
  provider: string | null;
}
export interface WorkerObservation {
  usage?: WorkerUsage | "unknown";
  state: "starting" | "running" | "stopped" | "failed" | "unknown";
  reply?: string;
  /** Optional node statistic for reconstructing runtime counters after attachment. */
  acceptedDeliveries?: number;
  /** CLI activity is independent of the operating-system process state. */
  activity?: "working" | "idle";
}
export interface RuntimeRecovery {
  /** CLI wire mode, never prompts, output or credentials. */
  native?: boolean;
  stream?: boolean;
  /** The journaled launch has not returned its runtime handle yet. */
  starting?: boolean;
}
export interface RuntimeProvider extends ProviderConnection {
  /** Owns its workspace and authenticates workers through Armada web, instead of a node socket. */
  readonly needsLaunchToken?: boolean;
  /** The host supplies facilities; plugins never look up another provider. */
  withNode?(node: NodeProvider): RuntimeProvider;
  prepare(request: PrepareRequest): Promise<Workspace>;
  /** Read-only recovery of one native create with an unknown outcome. Never repeats creation. */
  recover?(request: PrepareRequest & { worker: Omit<WorkerRef, "handle">; since: string }): Promise<WorkerRef | null>;
  /** Reattach a persisted exact generation without creating a process. */
  checkpoint?(worker: WorkerRef): RuntimeRecovery;
  adopt?(worker: WorkerRef, workspace: Workspace, recovery?: RuntimeRecovery): Promise<{ deliveries: number }>;
  launch(request: LaunchRequest): Promise<WorkerRef>;
  deliver(worker: WorkerRef, message: string, deliveryKey: string): Promise<void>;
  observe(worker: WorkerRef): Promise<WorkerObservation>;
  /** Optional read-only transcript tail, at most maxBytes UTF-8 bytes. No runtime input is sent. */
  transcript?(worker: WorkerRef, maxBytes: number): Promise<string>;
  stop(worker: WorkerRef): Promise<void>;
  /** Called only after the host has recorded release, with an ended-generation guard. */
  archive?(worker: WorkerRef): Promise<void>;
}
/** A runtime consumes a node's workspace and PTY facilities. */
export interface NodeProvider {
  /** Detached throwaway merge, local gates in order, cleanup even on failure. */
  testMerge?(request: TestMergeRequest): Promise<TestMergeResult>;
  /** Refuse while a worker still uses it or local changes would be lost. */
  dispose?(workspace: Workspace): Promise<void>;
  prepare(request: PrepareRequest): Promise<Workspace>;
  /** Reattach through the live supervisor, never by signaling a persisted PID. */
  adopt?(worker: WorkerRef, workspace: Workspace, recovery?: { starting?: boolean }): Promise<{ deliveries: number }>;
  launch(request: LaunchRequest): Promise<WorkerRef>;
  deliver(worker: WorkerRef, message: string, deliveryKey: string): Promise<void>;
  observe(worker: WorkerRef): Promise<WorkerObservation>;
  /** Optional read-only transcript tail, at most maxBytes UTF-8 bytes. No runtime input is sent. */
  transcript?(worker: WorkerRef, maxBytes: number): Promise<string>;
  stop(worker: WorkerRef): Promise<void>;
}
