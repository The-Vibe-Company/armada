import type { ProjectRequest } from "./index.js";
import type { TestMergeRequest, TestMergeResult } from "./merge.js";

export interface Workspace {
  id: string;
  path: string;
  node: string;
}
export interface PrepareRequest extends ProjectRequest {
  ticket: string;
  repository: string;
  branch: string;
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
  workspace: Workspace;
  worker: Omit<WorkerRef, "handle">;
  /** Empty selects the runtime's official CLI; a nonempty command is a host override (e.g. conformance). Nodes receive only resolved commands. */
  command: string;
  args: string[];
  env: Record<string, string>;
}
export interface WorkerObservation {
  state: "starting" | "running" | "stopped" | "failed" | "unknown";
  reply?: string;
  /** CLI activity is independent of the operating-system process state. */
  activity?: "working" | "idle";
}
export interface RuntimeProvider {
  /** The host supplies facilities; plugins never look up another provider. */
  withNode?(node: NodeProvider): RuntimeProvider;
  prepare(request: PrepareRequest): Promise<Workspace>;
  launch(request: LaunchRequest): Promise<WorkerRef>;
  deliver(worker: WorkerRef, message: string, deliveryKey: string): Promise<void>;
  observe(worker: WorkerRef): Promise<WorkerObservation>;
  stop(worker: WorkerRef): Promise<void>;
}
/** A runtime consumes a node's workspace and PTY facilities. */
export interface NodeProvider {
  /** Detached throwaway merge, local gates in order, cleanup even on failure. */
  testMerge?(request: TestMergeRequest): Promise<TestMergeResult>;
  /** Refuse while a worker still uses it or local changes would be lost. */
  dispose?(workspace: Workspace): Promise<void>;
  prepare(request: PrepareRequest): Promise<Workspace>;
  launch(request: LaunchRequest): Promise<WorkerRef>;
  deliver(worker: WorkerRef, message: string, deliveryKey: string): Promise<void>;
  observe(worker: WorkerRef): Promise<WorkerObservation>;
  stop(worker: WorkerRef): Promise<void>;
}
