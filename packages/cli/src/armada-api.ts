import { AuthError } from "@armada/auth";
import {
  API_FAILURE_HELP,
  APPLICATION_VAULT_CONFLICT_MESSAGES,
  type ApiFailureCode,
  githubHydrationPhase,
  type InvitationApiError,
  type InvitationErrorReason,
  TEMPLATE_REFUSAL_HELP,
} from "@armada/core";
import { sandboxFailure } from "./sandbox-errors.ts";
import type { SessionStore } from "./session.ts";

export const DEFAULT_ARMADA_API_URL = "https://armada.thevibecompany.co";
const DEFAULT_TIMEOUT_MS = 10_000;
const TEMPLATE_LAUNCH_UNKNOWN =
  "Template launch outcome unknown. Retry with the same template ID, request key and body; never use a new key while the outcome is unknown.";

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
    readonly details?: Readonly<{ phase: string }>,
    readonly legacyCode?: string,
    exitCode?: 1 | 2,
  ) {
    super(
      message,
      exitCode === 2
        ? "usage"
        : exitCode === 1
          ? "unavailable"
          : status === 400
            ? "usage"
            : status === 409 || status === 403
              ? "conflict"
              : "unavailable",
    );
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
      const signal = init.signal ?? AbortSignal.timeout(timeoutMs);
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
          signal,
        });
      } catch (error) {
        throw new AuthError(
          path === "/api/v1/templates/launch"
            ? TEMPLATE_LAUNCH_UNKNOWN
            : signal.aborted || (error instanceof Error && error.name === "TimeoutError")
              ? `The server did not answer in time; the operation may have been accepted.${
                  path === "/api/v1/sandbox/launch" ? " Run armada list to check before retrying." : ""
                }`
              : path === "/api/v1/sandbox/launch"
                ? "Launch outcome unknown. Run armada list to check before retrying."
                : "Armada could not reach the server.",
          "unavailable",
        );
      }

      if (response.status === 401 && !environmentToken && saved) {
        saved = await refresh(origin, io, saved.refreshToken, saved, timeoutMs, init.signal ?? undefined);
        token = saved.accessToken;
        try {
          response = await io.fetch(url, {
            ...init,
            ...{ timeout: false },
            headers: { ...headers(init.headers), authorization: `Bearer ${token}`, accept: "application/json" },
            redirect: "error",
            signal,
          });
        } catch (error) {
          throw new AuthError(
            path === "/api/v1/templates/launch"
              ? TEMPLATE_LAUNCH_UNKNOWN
              : signal.aborted || (error instanceof Error && error.name === "TimeoutError")
                ? `The server did not answer in time; the operation may have been accepted.${
                    path === "/api/v1/sandbox/launch" ? " Run armada list to check before retrying." : ""
                  }`
                : path === "/api/v1/sandbox/launch"
                  ? "Launch outcome unknown. Run armada list to check before retrying."
                  : "Armada could not reach the server.",
            "unavailable",
          );
        }
      }
      const payload: unknown = await response.json().catch(() => null);
      if (
        response.ok &&
        path === "/api/v1/templates/launch" &&
        (!payload || typeof payload !== "object" || Array.isArray(payload))
      )
        throw new ArmadaApiError("unavailable", response.status, TEMPLATE_LAUNCH_UNKNOWN);
      if (response.ok) return normalizeProviderDto(path, payload) as T;
      const failureCode =
        payload && typeof payload === "object" && "error" in payload
          ? (payload as { error?: { code?: string } }).error?.code
          : undefined;
      // Older control servers used not_found for both resource misses and route misses.
      // Compare only the fixed legacy sentinel; never echo untrusted response text.
      const legacyUnknownRoute =
        failureCode === "not_found" &&
        (payload as { error?: { message?: unknown } }).error?.message === "Unknown route.";
      if (response.status === 404 && (!failureCode || failureCode === "unknown_route" || legacyUnknownRoute))
        throw new ArmadaApiError(
          "unavailable",
          response.status,
          `This Armada deployment at ${origin} does not serve ${url.pathname}; the dashboard or server may be out of date. Ask an administrator to verify the deployment.`,
        );
      // Vault writes can be echoed by an upstream failure. Only closed local text is safe.
      if (path.startsWith("/api/v1/variables/") || path.startsWith("/api/v1/secrets/")) {
        const known: Record<string, string> = {
          [APPLICATION_VAULT_CONFLICT_MESSAGES.versionChanged]:
            "Version conflict. List entries and retry with the current --expected-version.",
          [APPLICATION_VAULT_CONFLICT_MESSAGES.inactive]:
            "Entry revoked or deleted. Revocation is terminal; delete a revoked entry before reusing its name.",
          [APPLICATION_VAULT_CONFLICT_MESSAGES.nameInUse]:
            "Name already in use, including revoked entries. Delete the old entry before reusing its name.",
        };
        const message = apiMessage(payload, "");
        const messages: Record<number, string> = {
          400: "Invalid application vault request. Check the name (uppercase, non-reserved), value (valid UTF-8, no NUL, at most 8 KiB; secrets cannot be empty), ID and version.",
          401: "Run armada login or update ARMADA_TOKEN.",
          403: "Application vault access denied. Current membership is required; only admins can mutate organization entries.",
          404: "Application vault entry or organization not found or not visible.",
          409: "Application vault conflict. List entries and check the current version, duplicate name or revoked status before retrying.",
        };
        throw new ArmadaApiError(
          response.status === 400
            ? "invalid"
            : response.status === 401
              ? "unauthorized"
              : response.status === 403
                ? "forbidden"
                : response.status === 404
                  ? "not_found"
                  : response.status === 409
                    ? "conflict"
                    : "unavailable",
          response.status,
          (response.status === 409 && Object.hasOwn(known, message) ? known[message] : undefined) ??
            messages[response.status] ??
            "Application vault unavailable. Check entry status before retrying.",
        );
      }
      if (path === "/api/v1/templates/launch" && response.status >= 500)
        throw new ArmadaApiError("unavailable", response.status, TEMPLATE_LAUNCH_UNKNOWN);
      if (path.startsWith("/api/v1/templates/")) {
        const known: Record<string, string> = {
          "Template revision changed.":
            "Template revision changed. Get the current revision and retry with --expected-revision.",
          "Template revision unavailable.":
            "Template revision unavailable. Get the template and choose an existing revision.",
          ...Object.fromEntries(
            Object.entries(TEMPLATE_REFUSAL_HELP).map(([reason, help]) => [
              `Template launch refused: ${reason}.`,
              help,
            ]),
          ),
          "Template name or request key already exists.":
            "Template name or request key already exists. Choose another template name or inspect the original launch request.",
          "Request key already used with a different request.":
            "Request key already used with a different request. Retry only the original key and body until its outcome is known.",
        };
        const fallback: Record<number, string> = {
          400: "Invalid template request. Check the definition, IDs, versions and supported overrides. Secret bindings are not supported.",
          401: "Run armada login or update ARMADA_TOKEN.",
          403: "Template access denied. Current membership is required; only admins can mutate organization templates.",
          404: "Template or revision not found or not visible.",
          409: "Template reference changed or is unavailable. Check its golden, connections, variable and model-account versions before retrying.",
        };
        const message = apiMessage(payload, "");
        throw new ArmadaApiError(
          response.status === 400
            ? "invalid"
            : response.status === 401
              ? "unauthorized"
              : response.status === 403
                ? "forbidden"
                : response.status === 404
                  ? "not_found"
                  : response.status === 409
                    ? "conflict"
                    : "unavailable",
          response.status,
          (Object.hasOwn(known, message) ? known[message] : undefined) ??
            fallback[response.status] ??
            "Template operation unavailable. For launch, retain the original request key and body; its outcome may be unknown.",
        );
      }
      if (failureCode && Object.hasOwn(API_FAILURE_HELP, failureCode)) {
        const phase =
          failureCode === "github_hydration_failed"
            ? githubHydrationPhase((payload as { error?: { details?: { phase?: unknown } } }).error?.details?.phase)
            : undefined;
        throw new ArmadaApiError(
          failureCode,
          response.status,
          API_FAILURE_HELP[failureCode as ApiFailureCode] + (phase ? ` Failing phase: ${phase}.` : ""),
          phase ? { phase } : undefined,
        );
      }
      if (path === "/api/v1/sandbox/launch" && response.status >= 500)
        throw new AuthError("Launch outcome unknown. Run armada list to check before retrying.", "unavailable");
      const sandboxError = sandboxFailure(path, response.status, failureCode, apiMessage(payload, ""));
      if (sandboxError)
        throw new ArmadaApiError(
          sandboxError.code,
          response.status,
          sandboxError.message,
          undefined,
          sandboxError.legacyCode,
          sandboxError.exitCode,
        );
      // Interior responses may contain provider failures or guest secrets. Never relay raw text.
      if (isSandboxInteriorPath(path) && response.status !== 401) {
        const denied = response.status === 403;
        throw new AuthError(
          denied
            ? path === "/api/v1/github/refresh"
              ? "GitHub refresh requires current organization membership and the sandbox owner."
              : "Sandbox interior access requires current organization membership and the owner or an org admin."
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
          apiMessage(payload, `Armada server request failed (${response.status}) at ${origin}.`),
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
  signal?: AbortSignal,
): Promise<NonNullable<Awaited<ReturnType<SessionStore["read"]>>>> {
  let response: Response;
  try {
    response = await io.fetch(apiUrl(origin, "/api/v1/auth/refresh"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ refreshToken }),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
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
    /^\/api\/v1\/sandbox\/(?:detail|status|send|steer|interrupt|exec|stop|extend|wait)$/.test(path) ||
    /^\/api\/v1\/sandboxes\/[0-9a-f-]+(?:\?.*)?$/i.test(path) ||
    path === "/api/v1/github/refresh" ||
    path === "/api/v1/logs/read" ||
    path === "/api/v1/mcp/sandbox-connections"
  );
}
