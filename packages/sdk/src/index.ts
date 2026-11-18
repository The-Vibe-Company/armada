import {
  API_FAILURE_HELP,
  type ApiFailureCode,
  type GoldenErrorCode,
  type LaunchErrorCode,
  type ProviderErrorCode,
  type VaultErrorCode,
} from "@armada/core";
import { apiUrl, jsonPost, requestApi, TEMPLATE_LAUNCH_ROUTE } from "./request.ts";
import { sandboxClient } from "./sandboxes.ts";

export type FailureCode =
  | ApiFailureCode
  | LaunchErrorCode
  | ProviderErrorCode
  | VaultErrorCode
  | GoldenErrorCode
  | "invalid"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unsupported"
  | "unavailable"
  | "unknown_response"
  | "transport_error"
  | "internal"
  | "unknown_route"
  | "sandbox_terminal"
  | "busy"
  | "denied"
  | "upstream";
export class ArmadaError extends Error {
  override readonly name = "ArmadaError";
  constructor(
    readonly code: FailureCode,
    readonly status: number,
    readonly serverCode: string | undefined,
    readonly outcomeUnknown: boolean,
    /** Server-requested delay before retrying, from `Retry-After` or the failure body; schedule retries no sooner. */
    readonly retryAfterSeconds?: number,
  ) {
    super(
      code in API_FAILURE_HELP
        ? API_FAILURE_HELP[code as ApiFailureCode]
        : `Armada request failed (${code}, HTTP ${status}).`,
    );
  }
}
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface ArmadaOptions {
  token: string;
  url?: string;
  fetch?: Fetch;
  timeoutMs?: number;
  /** Extra attempts for read-only status, wait and logs. Mutations are never retried. Default 0, maximum 3. */
  readRetries?: number;
}
export interface SandboxRef {
  id: string;
  org?: string;
}
/** Launch from a golden on Boat or Modal. */
export interface GoldenLaunchInput {
  golden: string;
  harness: "claude" | "codex" | "opencode";
  org?: string;
  provider?: "boat" | "modal";
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  ttlSeconds?: number;
  size?: "small" | "medium" | "large" | "xlarge";
  repo?: string;
  credentialId?: string;
  idempotencyKey?: string;
  externalRef?: string;
  /** Default true: stop the sandbox once every pull request it opened is merged and the agent is idle. */
  stopWhenWorkMerged?: boolean;
  visibility?: "org" | "private";
  skills?: string[];
  skipSkillDefaults?: boolean;
  connections?: string[];
}
type DockerLaunchFields = {
  org?: string;
  provider: "docker";
  harness: "claude" | "codex" | "opencode";
  /** Omit to use the caller's compatible personal default, frozen at admission. */
  credentialId?: string;
  credentialVersion?: number;
  externalRef?: string;
  /** First prompt: omit it or send a non-blank one; a blank prompt is refused before launch. */
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  ttlSeconds?: number;
  visibility?: "private";
  skills?: string[];
  skipSkillDefaults?: boolean;
  /** Default true: stop the sandbox once every pull request it opened is merged and the agent is idle. */
  stopWhenWorkMerged?: boolean;
  /** MCP connection UUIDs. */
  connections?: string[];
  variables?: { key: string; variableId: string; version: number }[];
  secrets?: { key: string; secretId: string; version: number }[];
} & ({ requestId: string; idempotencyKey?: never } | { idempotencyKey: string; requestId?: never });
/** Launch on a registered Docker host from the official Armada environment. There is no golden. */
export type DockerHostLaunchInput = DockerLaunchFields & {
  hostId: string;
  snapshotId?: never;
  /** Checkouts with bounded history: enough to find a merge base with the default branch. */
  repos?: { url: string; branch?: string; dir?: string }[];
};
/** Launch from a Docker snapshot, which selects its host and workspace; repos are refused. */
export type DockerSnapshotLaunchInput = DockerLaunchFields & {
  snapshotId: string;
  /** Optional; when present it must be the snapshot's host. */
  hostId?: string;
  repos?: never;
};
export type DockerLaunchInput = DockerHostLaunchInput | DockerSnapshotLaunchInput;
export type LaunchInput = GoldenLaunchInput | DockerLaunchInput;
export interface GoldenLaunchResult {
  sandbox: { id: string; provider: string; status: string; [key: string]: unknown };
  golden: { id: string; [key: string]: unknown };
  promptId: string | null;
  conversationId: string | null;
  ttlSeconds: number;
  expiresAt: string | null;
  [key: string]: unknown;
}
/** A Docker launch has no golden; the prompt and conversation IDs are null until a first prompt is recorded. */
export interface DockerLaunchResult {
  sandbox: {
    id: string;
    provider: "docker";
    status: string;
    hostId: string;
    externalRef?: string;
    [key: string]: unknown;
  };
  golden: null;
  promptId?: string | null;
  conversationId?: string | null;
  ttlSeconds: number;
  expiresAt: string;
  [key: string]: unknown;
}
export type LaunchResult = GoldenLaunchResult | DockerLaunchResult;
export interface TemplateLaunchInput {
  org: string;
  id: string;
  revision?: number;
  requestKey: string;
  prompt?: string;
  ttlSeconds?: number;
  size?: "small" | "medium" | "large" | "xlarge";
  repo?: string;
  skills?: string[];
  skipSkillDefaults?: boolean;
  /** Model credential account, when the template revision pins none. */
  modelAccount?: { id: string; version: number };
  /** Opaque caller reference recorded on the sandbox; refused for Docker templates. */
  externalRef?: string;
  /** Default true: stop the sandbox once every pull request it opened is merged and the agent is idle. */
  stopWhenWorkMerged?: boolean;
}
/** A durable launch request: `state` is "succeeded", "failed" or still "reconciling"/"allocating". Replay `requestKey` to read it again. */
export interface TemplateLaunchReceipt {
  requestId: string;
  state: string;
  id: string;
  /** Set on failed requests; `null` while a replayed request is still in progress. */
  reason?: string | null;
  message?: string;
  status?: string;
  promptId?: string | null;
  conversationId?: string | null;
  [key: string]: unknown;
}
/** Golden admission refused the launch before any request was recorded (HTTP 200, no `requestId`). Nothing was launched. */
export interface TemplateLaunchRefusal {
  requestId?: undefined;
  state: "failed";
  reason: GoldenErrorCode;
  message: string;
}
/** Narrow with `result.requestId !== undefined` before reading the receipt. */
export type TemplateLaunchResult = TemplateLaunchReceipt | TemplateLaunchRefusal;
export interface StatusInput extends SandboxRef {
  prompt_id?: string;
  recorded?: boolean;
}
export interface SandboxStatus {
  id: string;
  status: string;
  settled: boolean;
  statusReason: string | null;
  /** The selected prompt; `state` is "queued" while a Docker runtime has not admitted it yet. */
  prompt: {
    promptId: string;
    conversationId: string | null;
    state: string;
    reason: string | null;
    [key: string]: unknown;
  } | null;
  conversationIds: string[];
  expiresAt: string | null;
  [key: string]: unknown;
}
export interface WaitInput extends SandboxRef {
  prompt_id?: string;
  timeout_seconds?: number;
}
/** A send to a golden (Boat or Modal) sandbox. A Docker sandbox refuses this shape unless it is a `DockerSendInput`. */
export interface SendInput extends SandboxRef {
  /** The whole serialized request body is limited to 128 KiB; a larger one fails with HTTP 413 before dispatch. */
  prompt: string;
  request_id?: string;
  conversation_id?: string;
  /** Per-turn override; a Docker sandbox refuses it. */
  model?: string;
  /** Per-turn override; a Docker sandbox refuses it. */
  reasoning_effort?: string;
}
/**
 * A send to a Docker sandbox. The prompt is queued durably under `request_id` (a lowercase UUID), so retry
 * uncertain delivery with the same `request_id` and identical input. Without one the server generates a key
 * (the receipt's `requestId`) and a retry queues the prompt again, so supply it to replay. Model and effort
 * stay pinned to launch, so per-turn overrides are refused.
 */
export interface DockerSendInput extends SandboxRef {
  /** The whole serialized request body is limited to 128 KiB (below Docker's 256 KiB admission limit); a larger one fails with HTTP 413 before dispatch. */
  prompt: string;
  /** Supply it to make a retry replay instead of queuing the prompt again. */
  request_id?: string;
  /** A lowercase conversation UUID of the sandbox. Default: the latest. */
  conversation_id?: string;
  model?: never;
  reasoning_effort?: never;
}
export interface SendResult {
  id: string;
  promptId: string;
  conversationId: string;
  status: "queued" | "running" | "finished" | "failed" | "interrupted";
  requestId?: string;
}
export interface LogsInput extends SandboxRef {
  cursor?: string;
  conversationId?: string;
  limit?: number;
  all?: boolean;
  follow?: boolean;
  direction?: "forward" | "backward";
  maxBytes?: number;
  coalesce?: boolean;
}
export interface LogsResult {
  events: { id: string; at: number; kind: string; [key: string]: unknown }[];
  cursor: string | null;
  hasMore: boolean;
  settled: boolean;
  [key: string]: unknown;
}
interface ExecResult {
  id: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}
/** Loopback hosts never leave this machine: localhost, 127.0.0.0/8 and ::1. Other names depend on the resolver. */
function loopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Service-token client. No provider credentials, filesystem access, or server imports. */
export class Armada {
  private readonly origin: string;
  private readonly fetcher: Fetch;
  private readonly retries: number;
  private readonly timeoutMs: number | undefined;
  // An ECMAScript private field: JSON.stringify, util.inspect and Object.keys never expose the bearer token.
  readonly #token: string;
  constructor(options: ArmadaOptions) {
    const url = new URL(options.url ?? "https://armada.thevibecompany.co");
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new TypeError("Use an HTTP(S) Armada origin.");
    // The bearer token rides on the first request, so cleartext HTTP is only safe on this machine.
    if (url.protocol === "http:" && !loopbackHost(url.hostname))
      throw new TypeError("Use an HTTPS Armada origin; plain HTTP is only accepted for loopback hosts.");
    if (!options.token || /[\r\n]/.test(options.token)) throw new TypeError("A service token is required.");
    this.#token = options.token;
    this.timeoutMs = options.timeoutMs;
    this.origin = url.origin;
    // Never call fetch as a method of this client: browsers' native fetch throws
    // "Illegal invocation" for any receiver other than the global object or undefined.
    const fetcher = options.fetch;
    this.fetcher = fetcher ? (input, init) => fetcher(input, init) : (input, init) => globalThis.fetch(input, init);
    this.retries = options.readRetries ?? 0;
    if (!Number.isInteger(this.retries) || this.retries < 0 || this.retries > 3)
      throw new TypeError("readRetries must be between 0 and 3.");
  }
  readonly #sandboxes = sandboxClient(this.request.bind(this));

  launch(input: DockerLaunchInput, options?: RequestOptions): Promise<DockerLaunchResult>;
  launch(input: GoldenLaunchInput, options?: RequestOptions): Promise<GoldenLaunchResult>;
  launch(input: LaunchInput, options?: RequestOptions): Promise<LaunchResult>;
  launch(input: LaunchInput, options?: RequestOptions): Promise<LaunchResult> {
    return this.#sandboxes.launch(input, options);
  }
  launchFromTemplate(input: TemplateLaunchInput, options?: RequestOptions): Promise<TemplateLaunchResult> {
    return this.request(TEMPLATE_LAUNCH_ROUTE, input, false, options);
  }
  send(input: SendInput | DockerSendInput, options?: RequestOptions): Promise<SendResult> {
    return this.#sandboxes.send(input, options);
  }
  status(input: StatusInput, options?: RequestOptions): Promise<SandboxStatus> {
    return this.#sandboxes.status(input, options);
  }
  wait(input: WaitInput, options?: RequestOptions): Promise<SandboxStatus & { timedOut: boolean }> {
    // Precedence: per-call timeout, then the client timeout, then the server wait plus a margin.
    return this.#sandboxes.wait(input, options, ((input.timeout_seconds ?? 60) + 30) * 1000);
  }
  logs(input: LogsInput, options?: RequestOptions): Promise<LogsResult> {
    return this.#sandboxes.logs(input, options);
  }
  stop(
    input: SandboxRef & { request_id?: string; only_if_idle?: boolean },
    options?: RequestOptions,
  ): Promise<{ id: string; status: string; preservationNote?: string }> {
    return this.#sandboxes.stop(input, options);
  }

  /** UTF-8 file helpers over authorized exec. Requires guest `base64`; not a binary transfer API. */
  readonly files = {
    read: async (input: SandboxRef & { path: string }, options?: RequestOptions): Promise<string> => {
      const result = await this.#sandboxes.exec<ExecResult>(
        { id: input.id, ...(input.org ? { org: input.org } : {}), command: `cat < ${shellPath(input.path)}` },
        options,
      );
      checkExec(result);
      return result.stdout;
    },
    write: async (input: SandboxRef & { path: string; content: string }, options?: RequestOptions): Promise<void> => {
      const bytes = new TextEncoder().encode(input.content);
      if (bytes.length > 32768) throw new RangeError("File writes are limited to 32 KiB.");
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const result = await this.#sandboxes.exec<ExecResult>(
        {
          id: input.id,
          ...(input.org ? { org: input.org } : {}),
          command: `printf '%s' '${btoa(binary)}' | base64 -d > ${shellPath(input.path)}`,
        },
        options,
      );
      checkExec(result);
    },
  };

  private async request<T>(
    route: string,
    body: unknown,
    readOnly: boolean,
    options: RequestOptions = {},
    defaultTimeoutMs = 300000,
  ): Promise<T> {
    const result = await requestApi(
      apiUrl(this.origin, `/api/v1/${route}`),
      // Serialize each attempt within the shared deadline.
      () => jsonPost(body),
      {
        fetch: (url, init) => this.fetcher(String(url), init),
        token: this.#token,
        timeoutMs: options.timeoutMs ?? this.timeoutMs ?? defaultTimeoutMs,
        signal: options.signal,
        combineSignal: true,
        readOnly,
        readRetries: this.retries,
      },
    );
    if (result.kind === "transport")
      throw new ArmadaError(result.failure.code, 0, undefined, result.failure.outcomeUnknown);
    const { response, payload, failure, bodyReadFailed } = result;
    if (failure)
      throw new ArmadaError(
        failure.code,
        response.status,
        failure.serverCode,
        failure.outcomeUnknown,
        failure.retryAfterSeconds,
      );
    if (bodyReadFailed) throw new ArmadaError("transport_error", 0, undefined, !readOnly);
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new ArmadaError("unknown_response", response.status, undefined, !readOnly);
    return payload as T;
  }
}
function shellPath(path: string): string {
  if (!path || path.includes("\0")) throw new TypeError("A nonempty file path without NUL is required.");
  return `'${path.replace(/'/g, `'"'"'`)}'`;
}
function checkExec(result: ExecResult): void {
  if (result.exitCode !== 0 || result.timedOut || result.truncated)
    throw new ArmadaError("unknown_response", 200, undefined, true);
}

/** Verify before parsing JSON; persist delivery IDs separately to prevent replay within the tolerance. */
export async function verifyWebhookSignature(input: {
  secret: string;
  body: string;
  headers: Headers | Record<string, string>;
  now?: number;
  toleranceSeconds?: number;
}): Promise<boolean> {
  const headers = new Headers(input.headers);
  const timestamp = headers.get("Armada-Webhook-Timestamp") ?? "";
  const id = headers.get("Armada-Webhook-Id") ?? "";
  const signature = headers.get("Armada-Webhook-Signature") ?? "";
  const tolerance = input.toleranceSeconds ?? 300;
  const now = input.now ?? Date.now();
  if (
    !/^\d+$/.test(timestamp) ||
    !id ||
    !/^v1=[0-9a-f]{64}$/.test(signature) ||
    !Number.isFinite(now) ||
    !Number.isSafeInteger(Number(timestamp)) ||
    !Number.isFinite(tolerance) ||
    tolerance < 0 ||
    Math.abs(now / 1000 - Number(timestamp)) > tolerance
  )
    return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = Uint8Array.from(signature.slice(3).match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  return crypto.subtle.verify("HMAC", key, bytes, encoder.encode(`${timestamp}.${id}.${input.body}`));
}
