import {
  API_FAILURE_HELP,
  type ApiFailureCode,
  type GoldenErrorCode,
  type LaunchErrorCode,
  type ProviderErrorCode,
  type VaultErrorCode,
} from "@armada/core";
import type { FailureCode, Fetch } from "./index.ts";

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

export interface RequestPolicy {
  fetch: Fetch;
  timeoutMs: number;
  signal?: AbortSignal | null | undefined;
  /** SDK deadlines include caller cancellation. The CLI uses its explicit signal as the entire budget. */
  combineSignal?: boolean;
  token?: string;
  renewToken?: () => Promise<string>;
  readOnly?: boolean;
  readRetries?: number;
}

interface Failure {
  code: FailureCode;
  serverCode?: string | undefined;
  outcomeUnknown: boolean;
  retryAfterSeconds?: number | undefined;
}

export type RequestResult =
  | { kind: "transport"; failure: Failure; timedOut: boolean }
  | {
      kind: "response";
      response: Response;
      payload: unknown;
      bodyReadFailed: boolean;
      rawCode?: string;
      failure?: Failure;
    };

export function apiUrl(origin: string, path: string): URL {
  if (!path.startsWith("/")) throw new TypeError("API paths must start with '/'.");
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new TypeError("API paths must stay on the Armada origin.");
  return url;
}

export function jsonPost(body: unknown): RequestInit {
  const bodyText = JSON.stringify(body);
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(bodyText !== undefined ? { body: bodyText } : {}),
  };
}

/** Shared JSON transport. Callers validate their own success receipts and choose how to present errors. */
export async function requestApi(
  url: URL,
  requestInit: RequestInit | (() => RequestInit),
  policy: RequestPolicy,
): Promise<RequestResult> {
  const { fetch, signal: callerSignal, combineSignal, timeoutMs, renewToken, readOnly, readRetries = 0 } = policy;
  const deadline = combineSignal ? AbortSignal.timeout(timeoutMs) : undefined;
  const signal = deadline
    ? callerSignal
      ? AbortSignal.any([callerSignal, deadline])
      : deadline
    : (callerSignal ?? AbortSignal.timeout(timeoutMs));
  let token = policy.token;
  let renewed = false;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      const init = typeof requestInit === "function" ? requestInit() : requestInit;
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      headers.accept = "application/json";
      if (token !== undefined) headers.authorization = `Bearer ${token}`;
      response = await fetch(url, { ...init, headers, redirect: "error", signal });
    } catch (error) {
      return {
        kind: "transport",
        failure: { code: "transport_error", outcomeUnknown: !readOnly },
        timedOut: signal.aborted || (error instanceof Error && error.name === "TimeoutError"),
      };
    }
    if (response.status === 401 && renewToken && !renewed) {
      token = await renewToken();
      renewed = true;
      continue;
    }
    let payload: unknown = null;
    let bodyReadFailed = false;
    let text: string | undefined;
    try {
      text = await response.text();
    } catch {
      bodyReadFailed = true;
    }
    if (text !== undefined) {
      try {
        payload = JSON.parse(text);
      } catch {
        // The caller decides whether an empty or malformed success body is valid.
      }
    }
    if (response.ok) return { kind: "response", response, payload, bodyReadFailed };

    const { status, headers } = response;
    const error = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    const retryAfterSeconds = retryAfter(headers.get("retry-after"), error);
    if (status === 503 && error === "temporarily_unavailable") {
      return {
        kind: "response",
        response,
        payload,
        bodyReadFailed,
        failure: { code: "unavailable", serverCode: error, outcomeUnknown: false, retryAfterSeconds },
      };
    }
    // A server-requested delay belongs to the caller's scheduler.
    if (
      readOnly &&
      retryStatuses.has(status) &&
      attempt < readRetries &&
      retryAfterSeconds === undefined &&
      !headers.has("retry-after") &&
      !signal.aborted
    )
      continue;
    const rawCode =
      error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
    const code: FailureCode =
      rawCode && (Object.hasOwn(API_FAILURE_HELP, rawCode) || Object.hasOwn(commonCodes, rawCode))
        ? (rawCode as FailureCode)
        : "unknown_response";
    return {
      kind: "response",
      response,
      payload,
      bodyReadFailed,
      ...(rawCode !== undefined ? { rawCode } : {}),
      failure: {
        code,
        serverCode: rawCode && /^[a-z][a-z0-9_]{0,99}$/.test(rawCode) ? rawCode : undefined,
        outcomeUnknown: !readOnly && (status >= 500 || code === "outcome_unknown"),
        retryAfterSeconds,
      },
    };
  }
}

/** Accept only a delay in seconds or an HTTP date (header), or a whole number of seconds (failure body). */
function retryAfter(header: string | null, error: unknown): number | undefined {
  const seconds = (value: number) => (Number.isFinite(value) && value >= 0 ? Math.ceil(value) : undefined);
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
