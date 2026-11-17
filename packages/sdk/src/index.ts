import {
  API_FAILURE_HELP,
  type ApiFailureCode,
  type GoldenErrorCode,
  type LaunchErrorCode,
  type ProviderErrorCode,
  type VaultErrorCode,
} from "@armada/core";

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
export interface LaunchInput {
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
  visibility?: "org" | "private";
  skills?: string[];
  skipSkillDefaults?: boolean;
  connections?: string[];
}
export interface LaunchResult {
  sandbox: { id: string; provider: string; status: string; [key: string]: unknown };
  golden: { id: string; [key: string]: unknown };
  promptId: string | null;
  conversationId: string | null;
  ttlSeconds: number;
  expiresAt: string | null;
  [key: string]: unknown;
}
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
  prompt: { id?: string; state?: string; [key: string]: unknown } | null;
  conversationIds: string[];
  expiresAt: string | null;
  [key: string]: unknown;
}
export interface WaitInput extends SandboxRef {
  prompt_id?: string;
  timeout_seconds?: number;
}
export interface SendInput extends SandboxRef {
  prompt: string;
  request_id?: string;
  conversation_id?: string;
  model?: string;
  reasoning_effort?: string;
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
const commonCodes = {
  build_failed: true,
  busy: true,
  conflict: true,
  credential_binding_required: true,
  credential_binding_unsafe: true,
  credential_binding_unsupported: true,
  credential_busy: true,
  credential_refused: true,
  denied: true,
  forbidden: true,
  host_draining: true,
  host_full: true,
  init_failed: true,
  internal: true,
  invalid: true,
  invalid_config: true,
  invalid_request: true,
  missing_credential: true,
  no_credentials: true,
  no_running_turn: true,
  not_found: true,
  payment_required: true,
  prompt_failed: true,
  provider_not_configured: true,
  provider_routing_unavailable: true,
  rate_limited: true,
  sandbox_not_ready: true,
  sandbox_retention_ended: true,
  sandbox_terminal: true,
  setup_failed: true,
  snapshot_failed: true,
  start_failed: true,
  unauthorized: true,
  unavailable: true,
  unknown: true,
  unknown_route: true,
  unsupported: true,
  upstream: true,
} satisfies Record<
  | Exclude<LaunchErrorCode | ProviderErrorCode | VaultErrorCode | GoldenErrorCode, ApiFailureCode>
  | "internal"
  | "unknown_route"
  | "sandbox_terminal"
  | "busy"
  | "denied"
  | "upstream",
  boolean
> &
  Partial<Record<ApiFailureCode, boolean>>;
const retryStatuses = new Set([429, 502, 503, 504]);

/** Service-token client. No provider credentials, filesystem access, or server imports. */
export class Armada {
  private readonly origin: string;
  private readonly fetcher: Fetch;
  private readonly retries: number;
  constructor(private readonly options: ArmadaOptions) {
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
    if (!options.token || /[\r\n]/.test(options.token)) throw new TypeError("A service token is required.");
    this.origin = url.origin;
    // Never call fetch as a method of this client: browsers' native fetch throws
    // "Illegal invocation" for any receiver other than the global object or undefined.
    const fetcher = options.fetch;
    this.fetcher = fetcher ? (input, init) => fetcher(input, init) : (input, init) => globalThis.fetch(input, init);
    this.retries = options.readRetries ?? 0;
    if (!Number.isInteger(this.retries) || this.retries < 0 || this.retries > 3)
      throw new TypeError("readRetries must be between 0 and 3.");
  }
  launch(input: LaunchInput, options?: RequestOptions): Promise<LaunchResult> {
    return this.request("sandbox/launch", input, false, options);
  }
  launchFromTemplate(input: TemplateLaunchInput, options?: RequestOptions): Promise<TemplateLaunchResult> {
    return this.request("templates/launch", input, false, options);
  }
  send(input: SendInput, options?: RequestOptions): Promise<SendResult> {
    return this.request("sandbox/send", input, false, options);
  }
  status(input: StatusInput, options?: RequestOptions): Promise<SandboxStatus> {
    return this.request("sandbox/status", input, true, options);
  }
  wait(input: WaitInput, options?: RequestOptions): Promise<SandboxStatus & { timedOut: boolean }> {
    // Precedence: per-call timeout, then the client timeout, then the server wait plus a margin.
    return this.request("sandbox/wait", input, true, options, ((input.timeout_seconds ?? 60) + 30) * 1000);
  }
  logs(input: LogsInput, options?: RequestOptions): Promise<LogsResult> {
    return this.request("logs/read", input, true, options);
  }
  stop(
    input: SandboxRef & { request_id?: string; only_if_idle?: boolean },
    options?: RequestOptions,
  ): Promise<{ id: string; status: string; preservationNote?: string }> {
    return this.request("sandbox/stop", input, false, options);
  }

  /** UTF-8 file helpers over authorized exec. Requires guest `base64`; not a binary transfer API. */
  readonly files = {
    read: async (input: SandboxRef & { path: string }, options?: RequestOptions): Promise<string> => {
      const result = await this.request<ExecResult>(
        "sandbox/exec",
        { id: input.id, ...(input.org ? { org: input.org } : {}), command: `cat < ${shellPath(input.path)}` },
        false,
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
      const result = await this.request<ExecResult>(
        "sandbox/exec",
        {
          id: input.id,
          ...(input.org ? { org: input.org } : {}),
          command: `printf '%s' '${btoa(binary)}' | base64 -d > ${shellPath(input.path)}`,
        },
        false,
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
    const deadline = AbortSignal.timeout(options.timeoutMs ?? this.options.timeoutMs ?? defaultTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(`${this.origin}/api/v1/${route}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal,
        });
      } catch {
        // No automatic transport replay: acceptance may already have happened.
        throw new ArmadaError("transport_error", 0, undefined, !readOnly);
      }
      let text = "";
      try {
        text = await response.text();
      } catch {
        // A success body that fails or hits the deadline after headers is a transport failure,
        // not a malformed payload; a mutation may already have been accepted. A failure status
        // keeps its HTTP status and Retry-After, classified below without the body.
        if (response.ok) throw new ArmadaError("transport_error", 0, undefined, !readOnly);
      }
      let value: unknown = null;
      try {
        value = JSON.parse(text);
      } catch {
        // Malformed payloads are classified below as unknown_response.
      }
      const error = value && typeof value === "object" && "error" in value ? value.error : undefined;
      const retryAfterSeconds = response.ok ? undefined : retryAfter(response.headers.get("retry-after"), error);
      // A draining or auth-unavailable server refuses with this body before dispatching anything.
      if (
        response.status === 503 &&
        value &&
        typeof value === "object" &&
        "error" in value &&
        value.error === "temporarily_unavailable"
      )
        throw new ArmadaError("unavailable", 503, "temporarily_unavailable", false, retryAfterSeconds);
      if (response.ok) {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new ArmadaError("unknown_response", response.status, undefined, !readOnly);
        return value as T;
      }
      // A server-requested delay belongs to the caller's scheduler: never replay early.
      if (
        readOnly &&
        retryStatuses.has(response.status) &&
        attempt < this.retries &&
        retryAfterSeconds === undefined &&
        !response.headers.has("retry-after") &&
        !signal.aborted
      )
        continue;
      const rawCode =
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined;
      const code: FailureCode =
        rawCode && (Object.hasOwn(API_FAILURE_HELP, rawCode) || Object.hasOwn(commonCodes, rawCode))
          ? (rawCode as FailureCode)
          : "unknown_response";
      // Untrusted messages/details may echo secrets; errors retain only the code and status.
      const serverCode = rawCode && /^[a-z][a-z0-9_]{0,99}$/.test(rawCode) ? rawCode : undefined;
      throw new ArmadaError(
        code,
        response.status,
        serverCode,
        !readOnly && (response.status >= 500 || code === "outcome_unknown"),
        retryAfterSeconds,
      );
    }
  }
}
const MAX_RETRY_AFTER_SECONDS = 86_400;
/** Accept only a delay in seconds or an HTTP date (header), or a whole number of seconds (failure body). */
function retryAfter(header: string | null, error: unknown): number | undefined {
  const seconds = (value: number) =>
    Number.isFinite(value) && value >= 0 ? Math.min(Math.ceil(value), MAX_RETRY_AFTER_SECONDS) : undefined;
  if (header !== null) {
    const text = header.trim();
    if (/^\d{1,10}$/.test(text)) return seconds(Number(text));
    const date = /[a-z]{3}, \d{2} [a-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/i.test(text) ? Date.parse(text) : Number.NaN;
    if (Number.isFinite(date)) return seconds(Math.max(0, (date - Date.now()) / 1000));
  }
  if (!error || typeof error !== "object") return undefined;
  const details = "details" in error && error.details && typeof error.details === "object" ? error.details : undefined;
  const value =
    "retryAfterSeconds" in error
      ? error.retryAfterSeconds
      : details && "retryAfterSeconds" in details
        ? details.retryAfterSeconds
        : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) ? seconds(value) : undefined;
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
