import type { Harness } from "./contract.ts";

/**
 * The contract between Armada and a placement: the machines agents run on.
 * v0 has one implementation (boat.dev); local, SSH and other clouds implement the same interface later.
 *
 * Ids are the provider's own (for boat, `bx_...` sandboxes and saved-snapshot names). Every call takes the
 * sandbox it acts on; a provider holds no per-sandbox state, so one instance serves any number of callers.
 */
export interface Provider {
  readonly id: string;
  readonly harnesses: readonly Harness[];
  /** What each harness can do here. Callers branch on this, never on the harness name. */
  readonly capabilities: Readonly<Record<Harness, HarnessCapabilities>>;

  /** Starts a blank sandbox to build a golden in. It is not frozen until `snapshot`. */
  createGolden(request: CreateGoldenRequest): Promise<SandboxInfo>;
  /** Freezes a sandbox under a name. The save runs after the call returns: poll `getSnapshot` until it settles. */
  snapshot(request: SnapshotRequest): Promise<SnapshotInfo>;
  getSnapshot(name: string): Promise<SnapshotInfo>;
  /** Removes a snapshot. Sandboxes already started from it are not affected. */
  deleteSnapshot(name: string): Promise<void>;
  /** Starts a sandbox from a snapshot. */
  fork(request: ForkRequest): Promise<SandboxInfo>;

  get(sandboxId: string): Promise<SandboxInfo>;
  list(request?: ListRequest): Promise<Page<SandboxInfo>>;

  /** Queues work for a harness. Without `conversationId` it opens a new conversation. */
  prompt(request: PromptRequest): Promise<PromptReceipt>;
  getPrompt(request: { sandboxId: string; promptId: string }): Promise<PromptState>;
  /** Gives a running turn a new message without stopping it. Refused with `no_running_turn` when nothing runs. */
  steer(request: SteerRequest): Promise<SteerReceipt>;
  /** Stops the running turn of one conversation, or of every conversation when none is named. */
  interrupt(request: InterruptRequest): Promise<void>;
  exec(request: ExecRequest): Promise<ExecResult>;
  /** Events oldest first, after `cursor`. Poll with the cursor of the previous page. */
  events(request: EventsRequest): Promise<EventPage>;

  /** Removes the machine and keeps the disk and the conversations. */
  stop(request: { sandboxId: string }): Promise<void>;
  /** Removes the sandbox and its disk for good. */
  delete(request: { sandboxId: string }): Promise<DeleteReceipt>;
}

export interface HarnessCapabilities {
  /**
   * How a steer reaches a running turn: `native` joins the turn, `restart` interrupts it and continues the
   * same conversation, `none` is refused.
   */
  steer: "native" | "restart" | "none";
  interrupt: boolean;
  /** A prompt can continue an earlier conversation, including after the sandbox stopped. */
  resume: boolean;
  /** Several conversations of one sandbox work at the same time. */
  parallelConversations: boolean;
  /** `reasoningEffort` is accepted. */
  reasoningEffort: boolean;
  /** `fast` is accepted (for some models only: the provider refuses the others with `invalid_request`). */
  fast: boolean;
  /** Partial answers arrive as events with `partial: true`. */
  streamsPartials: boolean;
  /** Tool calls and their results arrive in events. */
  toolEvents: boolean;
  /** The agent can ask for approval before acting, and the caller can answer. */
  approvals: boolean;
}

export type SandboxState =
  | "starting" // machine being created or prepared; commands wait for it
  | "ready" // accepts commands and prompts
  | "running" // an agent turn is in progress
  | "stopping" // the disk is being saved
  | "stopped" // machine removed, disk kept
  | "failed";

export interface SandboxInfo {
  id: string;
  name: string;
  state: SandboxState;
  /** The provider's own state name, for diagnosis. */
  providerState: string;
  /** Why the sandbox failed, when it did. */
  error?: string;
  labels: Readonly<Record<string, string>>;
  createdAt?: Date;
  stoppedAt?: Date;
  /** When the provider stops it by itself (the TTL). */
  expiresAt?: Date;
}

export interface SnapshotInfo {
  name: string;
  status: "saving" | "ready" | "failed";
  error?: string;
  sourceSandboxId?: string;
  createdAt?: Date;
}

export interface Page<T> {
  items: T[];
  /** Pass it back as `cursor` for the next page; null on the last one. */
  cursor: string | null;
}

export interface CreateGoldenRequest {
  name?: string;
  labels?: Record<string, string>;
  /** Seconds before the provider stops the sandbox by itself. */
  ttlSeconds?: number;
  /** Retrying with the same key returns the same sandbox instead of starting a second one. */
  idempotencyKey?: string;
}

export interface SnapshotRequest {
  sandboxId: string;
  name: string;
}

export interface ForkRequest {
  /** The snapshot to start from. */
  from: string;
  name?: string;
  labels?: Record<string, string>;
  /** Environment variables of this sandbox only: the way credentials reach it. Values are secrets. */
  env?: Record<string, string>;
  ttlSeconds?: number;
  idempotencyKey?: string;
}

export interface ListRequest {
  /** Only sandboxes carrying every one of these labels. */
  labels?: Record<string, string>;
  states?: readonly SandboxState[];
  limit?: number;
  cursor?: string;
}

export interface PromptRequest {
  sandboxId: string;
  harness: Harness;
  text: string;
  conversationId?: string;
  model?: string;
  reasoningEffort?: string;
  fast?: boolean;
}

export const PROMPT_STATUSES = ["queued", "running", "finished", "failed", "interrupted"] as const;
export type PromptStatus = (typeof PROMPT_STATUSES)[number];

/** A turn that will not change any more. */
export function isFinalPromptStatus(status: PromptStatus): boolean {
  return status === "finished" || status === "failed" || status === "interrupted";
}

export interface PromptReceipt {
  promptId: string;
  conversationId: string;
  status: PromptStatus;
}

export interface PromptState {
  promptId: string;
  conversationId?: string;
  status: PromptStatus;
  done: boolean;
}

export interface SteerRequest {
  sandboxId: string;
  text: string;
  /** Required when the sandbox has several conversations. */
  conversationId?: string;
}

export interface SteerReceipt {
  conversationId: string;
  promptId: string;
  /** How the provider delivered it, e.g. `native`, `fallback`, `late`. */
  mode?: string;
}

export interface InterruptRequest {
  sandboxId: string;
  conversationId?: string;
}

export interface ExecRequest {
  sandboxId: string;
  command: string;
  cwd?: string;
  /** Synchronous commands only. */
  timeoutSeconds?: number;
  /** Starts the command and returns without waiting for it. */
  detached?: boolean;
}

export type ExecResult =
  | { detached: false; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }
  | { detached: true; processId: number };

export interface EventsRequest {
  sandboxId: string;
  /** From the previous page's `cursor`; absent reads from the start. */
  cursor?: string;
  conversationId?: string;
  limit?: number;
}

export interface EventPage {
  events: AgentEvent[];
  /** Where to continue: equals the request's cursor when nothing was new. Absent only on an empty first read. */
  cursor?: string;
  /** More events are already waiting: read again without pausing. */
  hasMore: boolean;
}

export interface DeleteReceipt {
  operationId?: string;
  status: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input?: unknown;
  /** Absent until the tool finished. */
  result?: { output: unknown; isError: boolean };
}

interface EventBase {
  id: string;
  /** Milliseconds since the epoch. */
  at: number;
  conversationId?: string;
  /** The turn the event belongs to. */
  promptId?: string;
}

/** The common event stream: the same for every harness and provider. */
export type AgentEvent =
  | (EventBase & { kind: "prompt"; text: string; status: PromptStatus; reason?: string })
  | (EventBase & { kind: "message"; text: string; partial: boolean; model?: string; tools: ToolCall[] })
  | (EventBase & { kind: "steer"; text: string; mode?: string })
  /** An event this version does not know: kept whole so no news is lost. */
  | (EventBase & { kind: "other"; type: string; data: unknown });

export type ProviderErrorCode =
  | "unauthorized"
  | "payment_required"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  /** The harness has no key or subscription on the provider's account: only its owner can fix it. */
  | "provider_not_configured"
  /** A steer when no turn runs. */
  | "no_running_turn"
  | "sandbox_not_ready"
  /** Any other refusal because of the state of a resource. */
  | "conflict"
  | "rate_limited"
  /** The provider failed or has no capacity. */
  | "unavailable"
  | "unknown";

export interface ProviderErrorInit {
  provider: string;
  code: ProviderErrorCode;
  message: string;
  status?: number;
  /** The provider's own error code. */
  providerCode?: string;
  /** The same call may succeed later. A call that starts a sandbox is safe to repeat only with an idempotency key. */
  retryable: boolean;
  retryAfterSeconds?: number;
  requestId?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** What every provider throws for a refused or failed call. Its message never holds a key or a request body. */
export class ProviderError extends Error {
  override readonly name = "ProviderError";
  readonly provider: string;
  readonly code: ProviderErrorCode;
  readonly status: number | undefined;
  readonly providerCode: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly requestId: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(init: ProviderErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.provider = init.provider;
    this.code = init.code;
    this.status = init.status;
    this.providerCode = init.providerCode;
    this.retryable = init.retryable;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.requestId = init.requestId;
    this.details = init.details;
  }
}
