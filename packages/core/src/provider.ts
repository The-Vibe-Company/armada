import type { Harness } from "./contract.ts";
import type { MachineSize } from "./machine-size.ts";
import type { ModelConnectionTestResult } from "./model-connection-test.ts";
import type { PlanLimit } from "./plan-limit.ts";
import type { ProviderTarget } from "./sandbox-provider.ts";

/**
 * The contract between Armada and a placement: the machines agents run on.
 * v0 has one implementation (boat.dev); local, SSH and other clouds implement the same interface later.
 *
 * Ids are the provider's own (for boat, `bx_...` sandboxes and saved-snapshot names). Every call takes the
 * sandbox it acts on; a provider holds no per-sandbox state, so one instance serves any number of callers.
 */
export interface GitHubRuntimeConfiguration {
  version: 1;
  revision: string;
  retired?: readonly string[];
  repositories?: readonly string[];
  generation: string;
  url: string;
  capability: string;
  expiresAt: number;
  /** Non-secret Git author identity, only on the enrolled runtime GitHub path. */
  identity?: { name: string; email: string };
}

export interface Provider {
  /** Private GitHub-only configuration, never exec argv or a public command receipt. */
  configureGitHub?(request: {
    sandboxId: string;
    configuration: GitHubRuntimeConfiguration | null;
  }): Promise<{ acknowledged: boolean }>;
  /** Fixed capability check of live compute. Shares the output reader transport and never resumes. */
  probeOutputs?(request: { sandboxId: string; signal?: AbortSignal }): Promise<boolean>;
  /** Fixed bounded read of the declared output directory (`/home/user/outputs`) of live compute
   * through the provider's own channel: never caller commands or the agent runtime, never starts or
   * resumes compute. Null means unavailable: not live (stopped, stopping, starting), or a failed read.
   * Stopped workspaces use the separate retained reader where supported. */
  readOutputs?(request: {
    sandboxId: string;
    signal?: AbortSignal;
  }): Promise<import("./sandbox-outputs.ts").OutputFile[] | null>;
  listOutputEntries?(request: {
    sandboxId: string;
    signal?: AbortSignal;
  }): Promise<import("./sandbox-output-limits.ts").OutputEntry[] | null>;
  /** Fixed read of the declared directory of one retained stop. Never starts compute.
   * Null is retryable. "gone" means the provider definitively has no readable retained workspace. */
  openRetainedOutputs?(request: { sandboxId: string; signal: AbortSignal }): Promise<
    | {
        entries: import("./sandbox-output-limits.ts").OutputEntry[];
        readChunk(chunk: import("./sandbox-output-limits.ts").OutputChunkRequest): Uint8Array | null;
      }
    | "gone"
    | null
  >;
  /** Plaintext bytes allowed by this transport in one read. */
  readonly outputReadBytes?: number;
  readonly outputReadConcurrency?: number;
  readOutputChunk?(request: {
    sandboxId: string;
    signal?: AbortSignal;
    chunk: import("./sandbox-output-limits.ts").OutputChunkRequest;
  }): Promise<Uint8Array | null>;
  /** Read-only fixed sampler. Null means isolation/runtime is unsupported or not attested. */
  observeResources?(sandboxId: string): Promise<import("./resource-observation.ts").ProviderResourceObservation | null>;
  readonly id: string;
  readonly harnesses: readonly Harness[];
  /** What each harness can do here. Callers branch on this, never on the harness name. */
  readonly capabilities: Readonly<Partial<Record<Harness, HarnessCapabilities>>>;
  /** Maximum independent goldens supported by this backend; omitted means no backend limit. */
  readonly maxGoldens?: number;
  /** Stable non-secret backend account identity, when supported. */
  backendIdentity?(): Promise<{ id: string }>;
  /** Immutable credential selection, never the secret or mutable profile label. */
  managementIdentity?(): Promise<{ scope: "org" | "user"; ownerId: string }>;
  /** Private authenticated runtime configuration; must complete before a model turn starts. */
  configureMcp?(request: {
    sandboxId: string;
    configuration: {
      revision: string;
      servers: Record<
        string,
        | { type: "http"; url: string; headers?: Record<string, string> }
        | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
      >;
    };
  }): Promise<void | { revision: string }>;

  /** Private runner control, not exec/prompt/client-visible credential configuration.
   * Optional until the backend provides native physical-incarnation fencing and ACK. */
  installOrchestratorEpoch?(request: {
    sandboxId: string;
    token: string;
    binding: { epoch: string; physicalGeneration: string };
    url: string;
  }): Promise<{ acknowledged: boolean }>;
  /** Read-only native work observation. Missing port is unavailable, never log-silence quiescence. */
  observeOrchestrator?(request: { sandboxId: string; physicalGeneration: string; conversationId?: string }): Promise<{
    physicalGeneration: string;
    state: "active" | "quiescent" | "unknown";
    evidence: string;
    eventWatermark: number;
    acknowledgedSequence: number;
    nativeSessionId: string | null;
  }>;
  /** Private no-text native handshake on an ALREADY active incarnation. This does
   * not restore compute or prove a checkpoint. Unsupported harnesses must refuse. */
  verifyOrchestratorSession?(request: {
    sandboxId: string;
    physicalGeneration: string;
    conversationId: string;
    nativeSessionId: string;
    harness: Harness;
    model: string;
    reasoningEffort?: string;
    cwd?: string;
  }): Promise<{ physicalGeneration: string; conversationId: string; nativeSessionId: string; verified: true }>;
  /** Private active-incarnation interrupt; never activates stopped compute. */
  quiesceOrchestrator?(request: { sandboxId: string; physicalGeneration: string }): Promise<{ acknowledged: boolean }>;
  scrubOrchestratorEpoch?(request: {
    sandboxId: string;
    physicalGeneration: string;
    tokenHash?: string;
  }): Promise<{ acknowledged: boolean }>;

  /**
   * Starts a blank sandbox to build a golden in. It is not frozen until `snapshot`.
   * The sandbox gets none of the account's secrets or model credentials (`noEnv`).
   * Callers inject credentials later, per sandbox, through `fork`'s `env`.
   */
  createGolden(request: CreateGoldenRequest): Promise<SandboxInfo>;
  /** Read-only durable reservation discovery after an interrupted golden create. Never creates,
   * replays commands, releases capacity or treats absence as proof. The provider must verify the
   * exact request key, owner, immutable target and recorded management authority. */
  findGoldenBuilder?(request: {
    requestKey: string;
    ownerId: string;
    target: ProviderTarget;
    /** The job's recorded, confirmed-unpublished artifact, already retired AND collected. Snapshot
     * history consisting only of this artifact is then no reason to retain the builder. */
    collected?: string;
  }): Promise<{ sandboxId: string; disposition: "disposable" | "retained" } | null>;
  /** Recovery-only disposal, rechecking exact reservation/provenance/retention under the
   * provider lifecycle lease. Never invokes create, build commands or snapshot cleanup. */
  disposeGoldenBuilder?(request: {
    requestKey: string;
    ownerId: string;
    target: ProviderTarget;
    sandboxId: string;
    /** See findGoldenBuilder. */
    collected?: string;
  }): Promise<DeleteReceipt>;
  /** Authorized credential-free golden restoration, never a normal agent fork. Source is derived
   * exclusively from the bound snapshot; optional prior ID must match that image's own source. */
  restoreGoldenMaster?(request: { snapshotId: string; sandboxId?: string }): Promise<SandboxInfo>;
  /** Freezes a sandbox using a requested label. SnapshotInfo.name is the authoritative provider
   * reference (it may differ from the label); use it for polling, fork and deletion. */
  snapshot(request: SnapshotRequest): Promise<SnapshotInfo>;
  getSnapshot(name: string): Promise<SnapshotInfo>;
  /** Removes a snapshot. Sandboxes already started from it are not affected. */
  deleteSnapshot(name: string): Promise<void>;
  /** Providers that remove a deleted snapshot's artifact after deletion returns (Modal keeps a
   * durable tombstone until no machine references the image and its source can be leased).
   * Collects what it can now and reports whether the named snapshot's artifact is gone. The
   * snapshot retirement worker retries "pending" so collection never depends on a user request. */
  collectRetiredSnapshot?(name: string): Promise<"collected" | "pending">;
  /** Starts a sandbox from a snapshot. */
  fork(request: ForkRequest, beforeDispatch?: ProviderDispatchGuard): Promise<SandboxInfo>;

  get(sandboxId: string, options?: { signal?: AbortSignal }): Promise<SandboxInfo>;
  list(request?: ListRequest): Promise<Page<SandboxInfo>>;

  /** One runtime-owned API-key connection probe; never starts/resumes a machine or a conversation. */
  testModelConnection?(request: {
    sandboxId: string;
    harness: "claude" | "codex" | "opencode";
    model: string;
    signal?: AbortSignal;
  }): Promise<ModelConnectionTestResult>;
  /** Trusted final-harness-only bootstrap. Never applied to exec, golden build or init. */
  configureReadableVariables?(request: {
    sandboxId: string;
    harness: Harness;
    variables: Record<string, string>;
  }): Promise<void>;
  /** Queues work for a harness. Without `conversationId` it opens a new conversation. */
  prompt(request: PromptRequest): Promise<PromptReceipt>;
  getPrompt(request: { sandboxId: string; promptId: string; signal?: AbortSignal }): Promise<PromptState>;
  /** Gives a running turn a new message without stopping it. Refused with `no_running_turn` when nothing runs. */
  steer(request: SteerRequest): Promise<SteerReceipt>;
  /** Stops the running turn of one conversation, or of every conversation when none is named. */
  interrupt(request: InterruptRequest): Promise<void>;
  exec(request: ExecRequest): Promise<ExecResult>;
  /** Optional one-shot native usage observation. Empty or an all-null diagnostic
   * row means unavailable, never zero tokens.
   * Rows are final per-prompt/model snapshots; retries replace rather than add counters. */
  collectTurnUsage?(request: {
    sandboxId: string;
    promptId: string;
    conversationId?: string;
    harness: Harness;
  }): Promise<import("./sandbox-usage.ts").TurnTokenUsage[]>;
  /** Prepares a forked VM's native harness executable to start in a recorded working directory. */
  prepareNativeHarnessCwd?(request: PrepareNativeHarnessCwdRequest): Promise<void>;
  /** Registers a transient public key and returns a pinned SSH endpoint. */
  sshKey(request: SshKeyRequest): Promise<SshConnection>;
  /** Events oldest first, after `cursor`. Poll with the cursor of the previous page. */
  events(request: EventsRequest): Promise<EventPage>;

  /** Interrupt and prove all relevant turns settled. Refuse while interruption is pending. */
  quiesce?(request: InterruptRequest): Promise<void>;
  /** Reset the physical lifetime without restoring or replacing compute. Returns the confirmed hard deadline. */
  extendLifetime?(request: { sandboxId: string; ttlSeconds: number }): Promise<Date>;
  /** Removes compute through the provider's stop policy. Automatic idle requires
   * retained workspace/conversation state and must refuse a compute-only fallback. */
  stop(request: { sandboxId: string; requireRetention?: boolean }): Promise<void>;
  /** Removes the sandbox and its disk for good. */
  delete(request: { sandboxId: string }, beforeDispatch?: ProviderDispatchGuard): Promise<DeleteReceipt>;
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

/** Canonical provider-neutral compute states; shared by types and safe diagnostics. */
export const SANDBOX_STATES = ["starting", "ready", "running", "stopping", "stopped", "failed"] as const;
export type SandboxState = (typeof SANDBOX_STATES)[number];

export interface SandboxInfo {
  id: string;
  name: string;
  state: SandboxState;
  /** The provider's own state name, for diagnosis. */
  providerState: string;
  /** Trusted physical/runtime incarnation, changing on restore or volatile runner replacement. Not a label. */
  physicalGeneration?: string;
  /** Why the sandbox failed, when it did. */
  error?: string;
  labels: Readonly<Record<string, string>>;
  createdAt?: Date;
  stoppedAt?: Date;
  /** SDK-confirmed physical exit, without claiming a fresh resumable checkpoint. */
  physicalExitConfirmed?: boolean;
  /** Closed ordinary-stop receipt: current disk was not saved. */
  stopNote?: "checkpoint_failed_disk_not_retained";
  /** When the provider stops it by itself (the TTL). */
  expiresAt?: Date;
  /** `host:port` of the SSH server when the machine has no public IPv4. */
  sshEndpoint?: string;
}

export interface SnapshotInfo {
  /** Immutable underlying artifact fingerprint; never a saved-handle delete argument. */
  artifactId?: string;
  /** Provider-persisted source credential authority, when available (required for Modal retirement). */
  managementAuthority?: { scope: "org" | "user"; ownerId: string };
  /** Authoritative provider reference, not necessarily the requested label or underlying disk artifact ID. */
  name: string;
  status: "saving" | "ready" | "failed";
  error?: string;
  /** Source correlation returned by the provider; required to safely accept a remapped reference in secure builds. */
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

/** Server-side guard checked immediately before a provider dispatches a durable launch mutation. */
export type ProviderDispatchGuard = () => Promise<void>;

export interface ForkRequest {
  /** Server-owned Armada UUID for a row-first Modal allocation. */
  modalLaunchId?: string;
  size?: MachineSize;
  /** The snapshot to start from. */
  from: string;
  name?: string;
  labels?: Record<string, string>;
  /** Environment variables of this sandbox only: the way credentials reach it. Values are secrets. */
  env?: Record<string, string>;
  /**
   * Give the sandbox none of the account's secrets. A fork of a no-env sandbox stays no-env;
   * pass this anyway so a snapshot that was saved wrong cannot leak the account.
   * `env` still applies and is how Armada injects its own credentials.
   */
  noEnv?: boolean;
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
  /** Trusted server cancellation, never persisted or sent as model input. */
  signal?: AbortSignal;
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
  /** This admission restored a physically stopped machine; renew the durable lease. */
  resumed?: boolean;
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
  /** Durable runtime identity; native providers do not support this field. */
  requestId?: string;
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
  /** Durable runtime identity; native providers do not support this field. */
  requestId?: string;
  sandboxId: string;
  conversationId?: string;
}

export interface SshKeyRequest {
  sandboxId: string;
  /** OpenSSH public key only. */
  key: string;
}

export interface SshConnection {
  sshEndpoint: string;
  /** Provider-trusted SSH login; omitted for the standard user account. Never request input. */
  username?: "user" | "root";
  /** OpenSSH host key to pin; never use TOFU for golden builders. */
  hostKey: string;
}

export interface PrepareNativeHarnessCwdRequest {
  sandboxId: string;
  harness: Harness;
  cwd: string;
}

export interface ExecRequest {
  /** Durable runtime identity; native providers do not support this field. */
  requestId?: string;
  /** Caller cancellation for provider admission/retries where supported. */
  signal?: AbortSignal;
  /** Private lifecycle sampler: refuse rather than resuming stopped compute. */
  onlyIfRunning?: boolean;
  /** Trusted diagnostic phase only; not shell input. Boat omits it from the HTTP command body. */
  preservationStage?: "collect_exec" | "chunk_exec";
  /** Fixed private output collection, logged by the server once per reason. */
  outputCollection?: boolean;
  /** Trusted capture correlation only; never forwarded as command input. */
  preservationContext?: {
    source: "user_stop" | "lifecycle_stop" | "managed_child_stop" | "unspecified";
    captureId: string;
  };
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
  /** Server-side read cancellation; no prompt or mutation is implied. */
  signal?: AbortSignal;
  sandboxId: string;
  /** From the previous page's `cursor`; absent reads from the start. */
  cursor?: string;
  conversationId?: string;
  /** Backward reads start at the end; cursor then anchors an exclusive older boundary. */
  direction?: "forward" | "backward";
  /** Raw events inspected, before optional page-local coalescing (1..1000; default 100). */
  limit?: number;
  /** UTF-8 JSON events-array budget (256..1048576; default 262144). A larger event is returned alone, or replaced by event_truncated above 1 MiB. */
  maxBytes?: number;
  /** Coalesce consecutive identified messages only from an authoritative snapshot; delta-only runs remain raw. */
  coalesce?: boolean;
}

export interface EventPage {
  /** Only an authenticated Armada journal archive reader sets this provenance. */
  source?: "armada-runtime";
  /** Server lifecycle failure, not an entry in the guest journal or proof of inference. */
  runtimeFailure?: { status: "failed"; reason: string };
  events: AgentEvent[];
  /** Exclusive oldest boundary for the next backward read. Events are always chronological. */
  olderCursor?: string;
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
  /** MCP server provenance when reported by the harness. */
  server?: string;
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
  | (EventBase & { kind: "prompt"; text: string; status: PromptStatus; reason?: string; limit?: PlanLimit })
  | (EventBase & {
      kind: "message";
      text: string;
      partial: boolean;
      /** Native logical assistant message identity, not the journal event id. */
      messageId?: string;
      /** Append a delta; replace the message text with a snapshot. Absent on legacy events. */
      textMode?: "delta" | "snapshot";
      model?: string;
      /** Native nested-agent parent. A non-null value is not main-thread model evidence. */
      parentToolUseId?: string;
      /** Tool results are not assistant response model evidence. */
      responseKind?: "assistant" | "tool_result";
      /** Provider-retracted response; retained in history but not execution evidence. */
      retracted?: boolean;
      tools: ToolCall[];
    })
  | (EventBase & { kind: "steer"; text: string; mode?: string })
  /** An event this version does not know: kept whole so no news is lost. */
  | (EventBase & { kind: "other"; type: string; data: unknown });

export type ProviderErrorCode =
  | "unauthorized"
  | "payment_required"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  /** The server provider setup is incomplete; an Armada administrator must fix it. */
  | "provider_routing_unavailable"
  /** The harness has no key or subscription on the provider's account: only its owner can fix it. */
  | "provider_not_configured"
  /** A steer when no turn runs. */
  | "no_running_turn"
  | "sandbox_not_ready"
  /** The selected Docker host has no free sandbox slots. */
  | "host_full"
  /** The selected Docker host is draining for uninstall and takes no new work. */
  | "host_draining"
  /** Any other refusal because of the state of a resource. */
  | "conflict"
  /** A Docker sandbox's host-local retention ended: its disk is gone, so retrying cannot help. */
  | "sandbox_retention_ended"
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

/** The provider's known pre-admission start-limit signal, not an ambiguous transport failure. */
export function isProviderStartRateLimit(error: ProviderError): boolean {
  return error.provider === "boat" && error.code === "rate_limited" && error.status === 429;
}

/** Explicit non-mutating provider refusals, not transport failures or ambiguous conflicts. */
export function isNonMutatingProviderRefusal(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    !error.details?.resourceReceipt &&
    !error.details?.keepSource &&
    ([
      "unauthorized",
      "forbidden",
      "not_found",
      "invalid_request",
      "payment_required",
      "host_full",
      "host_draining",
      "provider_not_configured",
      "provider_routing_unavailable",
    ].includes(error.code) ||
      isProviderStartRateLimit(error) ||
      (error.provider === "modal" &&
        error.code === "conflict" &&
        (error.providerCode === "fork_source_busy" || error.providerCode === "snapshot_source_busy")))
  );
}
