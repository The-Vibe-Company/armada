import { PROVIDER_PAYMENT_REQUIRED_MESSAGE, ProviderError, type ProviderErrorCode } from "@armada/core";
import { FetchError, RequiredError, ResponseError } from "@boatdev/sdk";

export const PROVIDER_ID = "boat";

interface Envelope {
  status?: number;
  code?: string;
  message?: string;
  requestId?: string;
  details?: Record<string, unknown>;
  retryAfterSeconds?: number;
  window?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function seconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Reads boat's `{ ok: false, code, message, error: { details }, requestId }` envelope; any body that is not one is tolerated. */
function readEnvelope(body: unknown): Envelope {
  if (!isRecord(body)) return {};
  const error = isRecord(body.error) ? body.error : {};
  const details = isRecord(error.details) ? error.details : undefined;
  const envelope: Envelope = {};
  const code = text(body.code) ?? text(error.code);
  const message = text(body.message) ?? text(error.message);
  const requestId = text(body.requestId);
  const retryAfter = seconds(body.retryAfterSeconds) ?? seconds(body.retryAfter) ?? seconds(details?.retryAfter);
  if (typeof body.status === "number") envelope.status = body.status;
  if (code) envelope.code = code;
  if (message) envelope.message = message;
  if (requestId) envelope.requestId = requestId;
  if (details) envelope.details = details;
  if (retryAfter !== undefined) envelope.retryAfterSeconds = retryAfter;
  const window = text(body.window) ?? text(details?.window);
  if (window) envelope.window = window;
  return envelope;
}

const NOT_READY_RETRYABLE = new Set(["sandbox_starting", "sandbox_resuming", "sandbox_securing"]);
const NOT_READY = new Set(["machine_not_running", "sandbox_not_ready", "sandbox_not_promptable", "sandbox_stopping"]);

interface Classified {
  code: ProviderErrorCode;
  retryable: boolean;
}

function classify(status: number, providerCode: string | undefined, envelope: Envelope): Classified {
  switch (status) {
    case 400:
      return providerCode === "machine_not_running"
        ? { code: "sandbox_not_ready", retryable: false }
        : { code: "invalid_request", retryable: false };
    case 401:
      return { code: "unauthorized", retryable: false };
    case 402:
      return { code: "payment_required", retryable: false };
    case 403:
      return { code: "forbidden", retryable: false };
    case 404:
      return { code: "not_found", retryable: false };
    case 409:
      if (providerCode === "provider_not_configured") return { code: "provider_not_configured", retryable: false };
      if (providerCode === "no_running_turn") return { code: "no_running_turn", retryable: false };
      if (providerCode && NOT_READY_RETRYABLE.has(providerCode)) return { code: "sandbox_not_ready", retryable: true };
      if (providerCode && NOT_READY.has(providerCode)) return { code: "sandbox_not_ready", retryable: false };
      return { code: "conflict", retryable: providerCode === "idempotency_in_progress" };
    case 429:
      // Only a per-minute window or the IP limit clears by itself soon: an hourly, daily or concurrency limit does not.
      return {
        code: "rate_limited",
        retryable: providerCode === "IP_RATE_LIMIT_EXCEEDED" || envelope.window === "minute",
      };
    case 502:
      return { code: "unavailable", retryable: envelope.details?.retryable === true };
    default:
      return status >= 500 ? { code: "unavailable", retryable: true } : { code: "unknown", retryable: false };
  }
}

async function fromResponse(response: Response, cause: unknown): Promise<ProviderError> {
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  const envelope = readEnvelope(body);
  const status = response.status;
  const providerCode = envelope.code;
  const { code, retryable } = classify(status, providerCode, envelope);
  const headerRetry = Number(response.headers.get("retry-after"));
  const retryAfterSeconds =
    envelope.retryAfterSeconds ?? (Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry : undefined);
  return new ProviderError({
    provider: PROVIDER_ID,
    code,
    message:
      code === "payment_required"
        ? PROVIDER_PAYMENT_REQUIRED_MESSAGE
        : (envelope.message ?? `boat.dev answered ${status}${providerCode ? ` (${providerCode})` : ""}.`),
    status,
    ...(providerCode ? { providerCode } : {}),
    retryable,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
    ...(envelope.details ? { details: envelope.details } : {}),
    cause,
  });
}

/** Turns anything a boat call throws into a `ProviderError`; one already typed passes through. */
export async function toProviderError(error: unknown): Promise<ProviderError> {
  if (error instanceof ProviderError) return error;
  if (error instanceof ResponseError) return fromResponse(error.response, error);
  if (error instanceof FetchError) {
    return new ProviderError({
      provider: PROVIDER_ID,
      code: "unavailable",
      message: `boat.dev could not be reached: ${error.cause.message}`,
      retryable: true,
      cause: error,
    });
  }
  if (error instanceof RequiredError) {
    return new ProviderError({
      provider: PROVIDER_ID,
      code: "invalid_request",
      message: `Missing request field: ${error.field}.`,
      retryable: false,
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError({ provider: PROVIDER_ID, code: "unknown", message, retryable: false, cause: error });
}

export function invalidRequest(message: string): ProviderError {
  return new ProviderError({ provider: PROVIDER_ID, code: "invalid_request", message, retryable: false });
}

export function unexpectedAnswer(what: string): ProviderError {
  return new ProviderError({
    provider: PROVIDER_ID,
    code: "unknown",
    message: `boat.dev answered with an unexpected ${what}.`,
    retryable: false,
  });
}
