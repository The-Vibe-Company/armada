import { API_FAILURE_HELP, type ApiFailureCode } from "@armada/core";
import type {
  DockerLaunchInput,
  ExecInput,
  ExecResult,
  GoldenLaunchInput,
  InterruptInput,
  InterruptResult,
  LaunchEnvelope,
  LaunchInput,
  ListInput,
  ListResult,
  LogsInput,
  LogsResult,
  ModalLaunchReceipt,
  OutputGetInput,
  OutputsListInput,
  OutputsListResult,
  PinnedModalLaunchInput,
  PinnedModalLaunchReceipt,
  SandboxStatus,
  SendInput,
  SendResult,
  StatusInput,
  SteerInput,
  SteerResult,
  StopInput,
  StopResult,
  TemplateLaunchInput,
  TemplateLaunchResult,
  ViewerTokenInput,
  ViewerTokenResult,
  WaitInput,
  WaitResult,
} from "@armada/core/contract";
import type { ServerFailureCode } from "@armada/core/contract/failures";
import { streamSandboxEvents } from "@armada/core/contract/sandbox-events";
import { sandboxOutputOperations } from "@armada/core/contract/sandbox-outputs";
import { sandboxViewerOperations } from "@armada/core/contract/sandbox-viewer";
import { sandboxEventStream } from "./events.ts";
import { apiUrl, jsonPost, type RequestPolicy, requestApi, TEMPLATE_LAUNCH_ROUTE } from "./request.ts";
import { sandboxClient } from "./sandboxes.ts";

interface EventReference {
  id: string;
  sandboxId: string;
  ref: string;
  createdAt: string;
}

export type SandboxEvent = EventReference &
  (
    | { kind: "transition"; sequence: null; status?: SandboxStatus["status"]; statusReason?: string | null }
    | { kind: "runtime_event"; sequence: string; event?: LogsResult["events"][number] }
  );

export interface EventStreamInput {
  sandbox: string;
  /** Last processed global event ID, or `"tail"` to start at the live frontier. Omit to replay retained history. */
  cursor?: string;
}

export interface SandboxEventState {
  cursor: string;
  transition?: Extract<SandboxEvent, { kind: "transition" }>;
  runtimeEvent?: Extract<SandboxEvent, { kind: "runtime_event" }>;
}

/** Track the latest reference of each kind for a single sandbox. */
export const reduceSandboxEvent: (state: SandboxEventState | undefined, event: SandboxEvent) => SandboxEventState = (
  state,
  event,
) => {
  if (state && BigInt(event.id) <= BigInt(state.cursor)) return state;
  return {
    ...state,
    cursor: event.id,
    ...(event.kind === "transition" ? { transition: event } : { runtimeEvent: event }),
  };
};

export type FailureCode = ServerFailureCode | "unknown_response" | "transport_error";

export type {
  DockerLaunchInput,
  ExecInput,
  ExecResult,
  GoldenLaunchInput,
  InterruptInput,
  InterruptResult,
  LaunchEnvelope,
  LaunchInput,
  ListInput,
  ListResult,
  LogsInput,
  LogsResult,
  ModalLaunchReceipt,
  OutputGetInput,
  OutputsListInput,
  OutputsListResult,
  PinnedModalLaunchInput,
  PinnedModalLaunchReceipt,
  SandboxStatus,
  SendInput,
  SendResult,
  StatusInput,
  SteerInput,
  SteerResult,
  StopInput,
  StopResult,
  TemplateLaunchInput,
  TemplateLaunchResult,
  ViewerTokenInput,
  ViewerTokenResult,
  WaitInput,
  WaitResult,
};
export type LaunchResult = LaunchEnvelope | ModalLaunchReceipt | PinnedModalLaunchReceipt;

const { listSandboxOutputs, readSandboxOutput } = sandboxOutputOperations;

function formatArmadaErrorMessage(code: FailureCode, status: number, serverCode: string | undefined) {
  if (Object.hasOwn(API_FAILURE_HELP, code)) return API_FAILURE_HELP[code as ApiFailureCode];
  const label = code === "unknown_response" && serverCode ? `${code}: ${serverCode}` : code;
  return status > 0 ? `Armada request failed (${label}, HTTP ${status}).` : `Armada request failed (${label}).`;
}

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
    message?: string,
  ) {
    super(message ?? formatArmadaErrorMessage(code, status, serverCode));
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
  /** Extra attempts for read-only status, wait, logs, list and outputs. Mutations are never retried. Default 0, maximum 3. */
  readRetries?: number;
}
export type SandboxRef = Pick<StatusInput, "id" | "org">;

const defaultOrigin = "https://armada.thevibecompany.co";

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
    const url = new URL(options.url ?? defaultOrigin);
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

  launch(input: PinnedModalLaunchInput, options?: RequestOptions): Promise<PinnedModalLaunchReceipt>;
  launch(
    input: Extract<LaunchInput, { provider: "modal"; golden: string }>,
    options?: RequestOptions,
  ): Promise<ModalLaunchReceipt>;
  launch(input: Extract<LaunchInput, { provider: "docker" }>, options?: RequestOptions): Promise<ModalLaunchReceipt>;
  launch(input: Extract<LaunchInput, { provider: "boat" }>, options?: RequestOptions): Promise<LaunchEnvelope>;
  launch(input: LaunchInput, options?: RequestOptions): Promise<LaunchResult>;
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

  list(input: ListInput = {}, options?: RequestOptions) {
    return this.#sandboxes.list<ListResult>(input, options);
  }
  interrupt(input: InterruptInput, options?: RequestOptions) {
    return this.#sandboxes.interrupt<InterruptResult>(input, options);
  }
  steer(input: SteerInput, options?: RequestOptions) {
    return this.#sandboxes.steer<SteerResult>(input, options);
  }
  exec(input: ExecInput, options?: RequestOptions) {
    return this.#sandboxes.exec<ExecResult>(
      input,
      options,
      Math.max(300000, ((input.timeout_seconds ?? 120) + 30) * 1000),
    );
  }
  /** Use an Armada client configured with the direct server URL for viewer token minting. */
  async createViewerToken(input: ViewerTokenInput, options?: RequestOptions) {
    if (this.origin === defaultOrigin)
      throw new TypeError("Viewer token minting requires the direct Armada server URL.");
    const operation = sandboxViewerOperations.mint;
    return this.requestJson<ViewerTokenResult>(
      operation.route.path,
      () => jsonPost(input),
      operation.readOnly,
      options,
    );
  }

  readonly events: {
    stream: (input: EventStreamInput, options?: RequestOptions) => AsyncGenerator<SandboxEvent, void>;
  } = {
    stream: ({ sandbox, cursor }, options) => {
      const { route, outputMediaType } = streamSandboxEvents;
      let initial = true;
      const controller = new AbortController();
      const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      const stream = sandboxEventStream(
        { sandbox, ...(cursor === undefined ? {} : { cursor }) },
        async (lastId) => {
          const query = new URLSearchParams({ sandbox });
          const headers = new Headers({ accept: outputMediaType });
          if (lastId !== undefined) {
            if (initial || lastId === "tail") query.set("cursor", lastId);
            else headers.set("last-event-id", lastId);
          }
          initial = false;

          try {
            const { response } = await this.fetchResponse(
              `${route.path}?${query}`,
              { method: route.method, headers },
              true,
              { ...options, signal },
              undefined,
              (response) => response.ok,
            );
            const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
            if (contentType === outputMediaType && response.body)
              return { body: response.body, status: response.status };
            await response.body?.cancel().catch(() => {});
            throw new ArmadaError("unknown_response", response.status, undefined, false);
          } catch (error) {
            if (
              error instanceof ArmadaError &&
              (error.code === "transport_error" || [429, 502, 503, 504].includes(error.status))
            )
              return { retryAfterMs: Math.max(1000, (error.retryAfterSeconds ?? 0) * 1000) };
            throw error;
          }
        },
        signal,
        (message, status) => new ArmadaError("unknown_response", status, undefined, false, undefined, message),
      );
      const close = stream.return.bind(stream);
      stream.return = (value) => {
        controller.abort();
        return close(value);
      };
      return stream;
    },
  };

  readonly outputs = {
    list: async (input: OutputsListInput, options?: RequestOptions) => {
      const { route, readOnly } = listSandboxOutputs;
      const parsedId = listSandboxOutputs.input.path.id.safeParse(input.id);
      if (!parsedId.success) throw new TypeError("Invalid sandbox ID.");
      return this.requestJson<OutputsListResult>(
        route.path.replace("{id}", parsedId.data),
        { method: route.method },
        readOnly,
        options,
      );
    },
    /** Stream a stored output and expose its response headers, including ETag and Content-Range. */
    get: async (input: OutputGetInput, options?: RequestOptions) => {
      const { route, readOnly } = readSandboxOutput;
      const parsedId = readSandboxOutput.input.path.id.safeParse(input.id);
      if (!parsedId.success) throw new TypeError("Invalid sandbox ID.");
      const parsedName = readSandboxOutput.input.path.name.safeParse(input.name);
      if (!parsedName.success) throw new TypeError("Invalid output name.");
      const path = route.path.replace("{id}", parsedId.data).replace("{name}", encodeURIComponent(parsedName.data));
      const headers = new Headers({ accept: "*/*" });
      if (input.range !== undefined) headers.set("range", input.range);
      if (input.ifRange !== undefined) headers.set("if-range", input.ifRange);
      const { response } = await this.fetchResponse(
        path,
        { method: route.method, headers },
        readOnly,
        options,
        undefined,
        (response) => response.ok || response.status === 416,
      );
      return response;
    },
  };

  private request<T>(
    route: string,
    body: unknown,
    readOnly: boolean,
    options?: RequestOptions,
    defaultTimeoutMs?: number,
  ) {
    return this.requestJson<T>(`/api/v1/${route}`, () => jsonPost(body), readOnly, options, defaultTimeoutMs);
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit | (() => RequestInit),
    readOnly: boolean,
    options?: RequestOptions,
    defaultTimeoutMs?: number,
  ) {
    const { response, payload, bodyReadFailed } = await this.fetchResponse(
      path,
      init,
      readOnly,
      options,
      defaultTimeoutMs,
    );
    if (bodyReadFailed) throw new ArmadaError("transport_error", 0, undefined, !readOnly);
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new ArmadaError("unknown_response", response.status, undefined, !readOnly);
    return payload as T;
  }

  private async fetchResponse(
    path: string,
    init: RequestInit | (() => RequestInit),
    readOnly: boolean,
    options: RequestOptions = {},
    defaultTimeoutMs?: number,
    streamResponse?: RequestPolicy["streamResponse"],
  ) {
    const timeoutMs =
      options.timeoutMs ??
      (defaultTimeoutMs !== undefined
        ? this.timeoutMs !== undefined
          ? Math.max(this.timeoutMs, defaultTimeoutMs)
          : defaultTimeoutMs
        : (this.timeoutMs ?? 300000));
    const result = await requestApi(apiUrl(this.origin, path), init, {
      fetch: (url, init) => this.fetcher(String(url), init),
      token: this.#token,
      timeoutMs,
      signal: options.signal,
      combineSignal: true,
      readOnly,
      readRetries: this.retries,
      ...(streamResponse ? { streamResponse } : {}),
    });
    if (result.kind === "transport")
      throw new ArmadaError(result.failure.code, 0, undefined, result.failure.outcomeUnknown);
    const { response, failure } = result;
    if (failure)
      throw new ArmadaError(
        failure.code,
        response.status,
        failure.serverCode,
        failure.outcomeUnknown,
        failure.retryAfterSeconds,
      );
    return result;
  }
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
