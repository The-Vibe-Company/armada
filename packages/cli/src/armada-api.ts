import { AuthError } from "@armada/auth";
import type { InvitationApiError, InvitationErrorReason } from "@armada/core";
import type { SessionStore } from "./session.ts";

export const DEFAULT_ARMADA_API_URL = "https://armada.thevibecompany.co";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ArmadaApiIo {
  env: NodeJS.ProcessEnv;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  session: SessionStore;
  timeoutMs?: number;
}

export interface ArmadaApiOptions {
  /** The CLI --url value. It takes precedence over ARMADA_URL and the default origin. */
  url?: string;
  /** Retain safe server error codes for versioned API clients. */
  preserveServerErrors?: boolean;
}

export class ArmadaApiError extends AuthError {
  constructor(
    readonly serverCode: string,
    readonly status: number,
    message: string,
  ) {
    super(message, status === 400 ? "usage" : status === 409 || status === 403 ? "conflict" : "unavailable");
  }
}

/** A deliberately small client for Armada's HTTP API. It never contacts an auth/database provider. */
export interface ArmadaApiClient {
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

/**
 * Create an authenticated client for Armada's own API.
 *
 * ARMADA_TOKEN is intentionally checked before the saved session, allowing automation with a
 * clean HOME. A saved login is the fallback. The token is never retained in thrown errors.
 */
export async function createArmadaApiClient(io: ArmadaApiIo, options: ArmadaApiOptions = {}): Promise<ArmadaApiClient> {
  // An explicit environment token needs no HOME/session read and never inherits a stale session origin.
  const environmentToken = io.env.ARMADA_TOKEN;
  let saved = environmentToken ? null : await io.session.read();
  const origin = armadaApiUrl(options.url ?? io.env.ARMADA_URL);
  let token = environmentToken || saved?.accessToken;
  if (!token) throw new AuthError("Set ARMADA_TOKEN or run armada login.", "unauthorized");
  const timeoutMs = io.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!environmentToken && saved && Date.parse(saved.expiresAt) - Date.now() <= 60_000) {
    saved = await refresh(origin, io, saved.refreshToken, saved, timeoutMs);
    token = saved.accessToken;
  }

  return {
    async request<T>(path: string, init: RequestInit = {}): Promise<T> {
      const url = apiUrl(origin, path);
      let response: Response;
      try {
        response = await io.fetch(url, {
          ...init,
          // Bun has an independent fetch idle deadline. The explicit AbortSignal
          // owns this request's budget, including long synchronous golden builds.
          ...{ timeout: false },
          headers: {
            ...headers(init.headers),
            authorization: `Bearer ${token}`,
            accept: "application/json",
          },
          redirect: "error",
          signal: init.signal ?? AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new AuthError("Armada could not reach the server.", "unavailable");
      }

      if (response.status === 401 && !environmentToken && saved) {
        saved = await refresh(origin, io, saved.refreshToken, saved, timeoutMs);
        token = saved.accessToken;
        try {
          response = await io.fetch(url, {
            ...init,
            ...{ timeout: false },
            headers: { ...headers(init.headers), authorization: `Bearer ${token}`, accept: "application/json" },
            redirect: "error",
            signal: init.signal ?? AbortSignal.timeout(timeoutMs),
          });
        } catch {
          throw new AuthError("Armada could not reach the server.", "unavailable");
        }
      }
      const payload: unknown = await response.json().catch(() => null);
      if (response.ok) return normalizeProviderDto(path, payload) as T;
      // Interior responses may contain provider failures or guest secrets. Never relay raw text.
      if (isSandboxInteriorPath(path) && response.status !== 401) {
        const denied = response.status === 403;
        throw new AuthError(
          denied
            ? "Sandbox interior access requires current organization membership and the owner or an org admin."
            : response.status === 404
              ? "Sandbox not found or not accessible."
              : `Sandbox operation failed (${response.status}). Check access and sandbox status before retrying.`,
          denied || response.status === 404 ? "conflict" : "unavailable",
        );
      }
      // Invitation tokens can be present in a rejected body. Never trust server error text here.
      if (path.startsWith("/api/v1/org/invitations/")) {
        const messages: Record<number, string> = {
          400: "Invalid invitation request. Check the email, role or invitation token.",
          401: "Log in personally with the invitation recipient's verified email to accept; otherwise update your Armada login.",
          403: "Invitation request forbidden. Management requires an org admin; acceptance requires a personal login with the matching verified email.",
          404: "Invitation or organization not found or not visible.",
          409: "Invitation conflict or rate limit. Check membership, expiry, revocation and resend state before retrying.",
          503: "Invitation service unavailable. Check invitation status before retrying; email may not have been sent.",
        };
        throw new AuthError(
          invitationReasonMessage(payload) ??
            messages[response.status] ??
            `Invitation request failed (${response.status}).`,
          response.status === 401
            ? "unauthorized"
            : response.status === 400
              ? "usage"
              : response.status === 403 || response.status === 404 || response.status === 409
                ? "conflict"
                : "unavailable",
        );
      }
      if (response.status === 401) throw new AuthError("Run armada login or update ARMADA_TOKEN.", "unauthorized");
      if (options.preserveServerErrors) {
        const code =
          payload && typeof payload === "object" && "error" in payload
            ? (payload as { error?: { code?: unknown } }).error?.code
            : undefined;
        throw new ArmadaApiError(
          typeof code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : "unavailable",
          response.status,
          apiMessage(payload, `Armada server request failed (${response.status}).`),
        );
      }
      if (response.status === 403) throw new AuthError(apiMessage(payload, "Armada refused this request."), "conflict");
      throw new AuthError(apiMessage(payload, `Armada server request failed (${response.status}).`), "unavailable");
    },
  };
}

async function refresh(
  origin: string,
  io: ArmadaApiIo,
  refreshToken: string,
  saved: NonNullable<Awaited<ReturnType<SessionStore["read"]>>>,
  timeoutMs: number,
): Promise<NonNullable<Awaited<ReturnType<SessionStore["read"]>>>> {
  let response: Response;
  try {
    response = await io.fetch(apiUrl(origin, "/api/v1/auth/refresh"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ refreshToken }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new AuthError("Armada could not reach the server.", "unavailable");
  }
  const value = (await response.json().catch(() => null)) as {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
  } | null;
  if (
    !response.ok ||
    !value ||
    typeof value.accessToken !== "string" ||
    typeof value.refreshToken !== "string" ||
    typeof value.expiresAt !== "string"
  )
    throw new AuthError("Run armada login again.", "unauthorized");
  const updated = {
    ...saved,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
  };
  await io.session.write(updated);
  return updated;
}

/** Accept only an HTTP(S) origin; this prevents provider URLs from becoming API targets. */
export function armadaApiUrl(value: string | undefined): string {
  const address = value || DEFAULT_ARMADA_API_URL;
  try {
    const url = new URL(address.includes("://") ? address : `https://${address}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    return url.origin;
  } catch {
    throw new AuthError("Use an HTTP(S) Armada API URL.", "usage");
  }
}

function apiUrl(origin: string, path: string): URL {
  if (!path.startsWith("/")) throw new AuthError("API paths must start with '/'.", "usage");
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new AuthError("API paths must stay on the Armada origin.", "usage");
  return url;
}

function headers(value: RequestInit["headers"]): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(new Headers(value).entries());
}

function apiMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return fallback;
  const error = (payload as Record<string, unknown>).error;
  const message = typeof error === "object" && error !== null ? (error as Record<string, unknown>).message : undefined;
  return typeof message === "string" && message.length > 0 ? message : fallback;
}

/** Read pre-provider Boat responses during a rolling server/CLI upgrade. */
function normalizeProviderDto(path: string, payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const body = payload as Record<string, unknown>;
  const identity = (value: unknown, sandbox = false): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const row = value as Record<string, unknown>;
    if (row.provider !== undefined) return row;
    const legacyId = sandbox ? "boatId" : "boatSandboxId";
    if (!(legacyId in row) && !("boatSnapshotId" in row)) return row;
    return {
      ...row,
      provider: "boat",
      modal: null,
      providerSandboxId: row[legacyId] ?? null,
      ...(!sandbox ? { providerSnapshotId: row.boatSnapshotId ?? null } : {}),
    };
  };
  if (path === "/api/v1/golden/list" && Array.isArray(body.goldens))
    return { ...body, goldens: body.goldens.map((row) => identity(row)) };
  if (path === "/api/v1/sandbox/launch")
    return { ...body, sandbox: identity(body.sandbox, true), golden: identity(body.golden) };
  return payload;
}

/** Untrusted responses may echo the request; only recognized reason names select local text. */
function invitationReasonMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return undefined;
  const error = payload.error;
  if (!error || typeof error !== "object" || !("reason" in error) || typeof error.reason !== "string") return undefined;
  const messages: Record<InvitationErrorReason, string> = {
    invalid: "Invalid invitation request. Check the email, role or invitation token.",
    personal_login_required:
      "Accept using a personal Armada login, not a service token. Unset ARMADA_TOKEN and run armada login.",
    wrong_email: "Sign in with the invitation recipient's verified email before accepting.",
    unverified_email: "Verify your account email before accepting this invitation.",
    not_found: "Invitation not found. Check the token from the invitation email.",
    expired: "Invitation expired. Ask an organization admin to resend it.",
    revoked: "Invitation revoked. Ask an organization admin for a new invitation.",
    used: "Invitation already used. Check your organization memberships.",
    already_member: "You are already a member of this organization. Existing membership is unchanged.",
    rate_limited: "Invitation rate limit reached. Wait before retrying.",
    pending_exists:
      "A pending invitation already exists. List invitations and resend or revoke the existing invitation.",
  };
  if (!Object.hasOwn(messages, error.reason)) return undefined;
  const reason = error.reason as InvitationErrorReason;
  const { retryAfterSeconds } = error as InvitationApiError["error"];
  const retry =
    reason === "rate_limited" &&
    Number.isSafeInteger(retryAfterSeconds) &&
    typeof retryAfterSeconds === "number" &&
    retryAfterSeconds >= 0
      ? ` Retry after ${retryAfterSeconds} seconds.`
      : "";
  return `${messages[reason]}${retry}`;
}

function isSandboxInteriorPath(path: string): boolean {
  return (
    /^\/api\/v1\/sandbox\/(?:detail|status|send|steer|interrupt|exec|stop|wait)$/.test(path) ||
    path === "/api/v1/logs/read" ||
    path === "/api/v1/mcp/sandbox-connections"
  );
}
