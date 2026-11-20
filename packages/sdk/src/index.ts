import { API_FAILURE_HELP, type ApiFailureCode } from "@armada/core";
import type {
  DockerLaunchInput,
  ExecResult,
  GoldenLaunchInput,
  LaunchEnvelope,
  LaunchInput,
  LogsInput,
  LogsResult,
  PinnedModalLaunchInput,
  SandboxStatus,
  SendInput,
  SendResult,
  StatusInput,
  StopInput,
  StopResult,
  TemplateLaunchInput,
  TemplateLaunchResult,
  WaitInput,
  WaitResult,
} from "@armada/core/contract";
import type { ServerFailureCode } from "@armada/core/contract/failures";
import { apiUrl, jsonPost, requestApi, TEMPLATE_LAUNCH_ROUTE } from "./request.ts";
import { sandboxClient } from "./sandboxes.ts";

export type FailureCode = ServerFailureCode | "unknown_response" | "transport_error";

export type {
  DockerLaunchInput,
  GoldenLaunchInput,
  LaunchInput,
  LogsInput,
  LogsResult,
  PinnedModalLaunchInput,
  SandboxStatus,
  SendInput,
  SendResult,
  StatusInput,
  TemplateLaunchInput,
  TemplateLaunchResult,
  WaitInput,
};
export type LaunchResult = LaunchEnvelope;

/**
 * An Armada request failure. When `retryAfterSeconds` is set from the `Retry-After`
 * header or the failure body, wait at least that many seconds before retrying.
 */
export class ArmadaError extends Error {
  override readonly name = "ArmadaError";
  constructor(
    readonly code: FailureCode,
    readonly status: number,
    readonly serverCode: string | undefined,
    readonly outcomeUnknown: boolean,
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
export type SandboxRef = Pick<StatusInput, "id" | "org">;

function loopbackHost(hostname: string) {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Service-token client. No provider credentials, filesystem access, or server imports. */
export class Armada {
  private readonly origin: string;
  private readonly fetcher: Fetch;
  private readonly retries: number;
  private readonly timeoutMs: number | undefined;
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
    if (url.protocol === "http:" && !loopbackHost(url.hostname))
      throw new TypeError("Use an HTTPS Armada origin; plain HTTP is only accepted for loopback hosts.");
    if (!options.token || /[\r\n]/.test(options.token)) throw new TypeError("A service token is required.");
    this.#token = options.token;
    this.timeoutMs = options.timeoutMs;
    this.origin = url.origin;
    const fetcher = options.fetch;
    this.fetcher = fetcher ? (input, init) => fetcher(input, init) : (input, init) => globalThis.fetch(input, init);
    this.retries = options.readRetries ?? 0;
    if (!Number.isInteger(this.retries) || this.retries < 0 || this.retries > 3)
      throw new TypeError("readRetries must be between 0 and 3.");
  }
  readonly #sandboxes = sandboxClient(this.request.bind(this));

  launch(input: LaunchInput, options?: RequestOptions) {
    return this.#sandboxes.launch<LaunchResult>(input, options);
  }
  launchFromTemplate(input: TemplateLaunchInput, options?: RequestOptions) {
    return this.request<TemplateLaunchResult>(TEMPLATE_LAUNCH_ROUTE, input, false, options);
  }
  send(input: SendInput, options?: RequestOptions) {
    return this.#sandboxes.send<SendResult>(input, options);
  }
  status(input: StatusInput, options?: RequestOptions) {
    return this.#sandboxes.status<SandboxStatus>(input, options);
  }
  wait(input: WaitInput, options?: RequestOptions) {
    return this.#sandboxes.wait<WaitResult>(input, options, ((input.timeout_seconds ?? 60) + 30) * 1000);
  }
  logs(input: LogsInput, options?: RequestOptions) {
    return this.#sandboxes.logs<LogsResult>(input, options);
  }
  stop(input: StopInput, options?: RequestOptions) {
    return this.#sandboxes.stop<StopResult>(input, options);
  }

  /** UTF-8 file helpers over authorized exec. Requires guest `base64`; not a binary transfer API. */
  readonly files = {
    read: async (input: SandboxRef & { path: string }, options?: RequestOptions) => {
      const result = await this.#sandboxes.exec<ExecResult>(
        { id: input.id, ...(input.org ? { org: input.org } : {}), command: `cat < ${shellPath(input.path)}` },
        options,
      );
      checkExec(result);
      return result.stdout;
    },
    write: async (input: SandboxRef & { path: string; content: string }, options?: RequestOptions) => {
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
  ) {
    const result = await requestApi(apiUrl(this.origin, `/api/v1/${route}`), () => jsonPost(body), {
      fetch: (url, init) => this.fetcher(String(url), init),
      token: this.#token,
      timeoutMs: options.timeoutMs ?? this.timeoutMs ?? defaultTimeoutMs,
      signal: options.signal,
      combineSignal: true,
      readOnly,
      readRetries: this.retries,
    });
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
function shellPath(path: string) {
  if (!path || path.includes("\0")) throw new TypeError("A nonempty file path without NUL is required.");
  return `'${path.replace(/'/g, `'"'"'`)}'`;
}
function checkExec(result: ExecResult) {
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
}) {
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
