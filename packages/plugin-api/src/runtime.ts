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
export interface WorkerObservation {
  state: "starting" | "running" | "stopped" | "failed" | "unknown";
  reply?: string;
  /** CLI activity is independent of the operating-system process state. */
  activity?: "working" | "idle";
}
export interface RuntimeProvider extends ProviderConnection {
  /** Owns its workspace and authenticates workers through Armada web, instead of a node socket. */
  readonly needsLaunchToken?: boolean;
  /** The host supplies facilities; plugins never look up another provider. */
  withNode?(node: NodeProvider): RuntimeProvider;
  prepare(request: PrepareRequest): Promise<Workspace>;
  /** Read-only recovery of one native create with an unknown outcome. Never repeats creation. */
  recover?(request: PrepareRequest & { worker: Omit<WorkerRef, "handle">; since: string }): Promise<WorkerRef | null>;
  launch(request: LaunchRequest): Promise<WorkerRef>;
  deliver(worker: WorkerRef, message: string, deliveryKey: string): Promise<void>;
  observe(worker: WorkerRef): Promise<WorkerObservation>;
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
  launch(request: LaunchRequest): Promise<WorkerRef>;
  deliver(worker: WorkerRef, message: string, deliveryKey: string): Promise<void>;
  observe(worker: WorkerRef): Promise<WorkerObservation>;
  stop(worker: WorkerRef): Promise<void>;
}
