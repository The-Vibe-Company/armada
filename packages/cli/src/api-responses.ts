import { AuthError, bearerKind } from "@armada/auth";
import {
  API_FAILURE_HELP,
  type ApiFailureCode,
  githubHydrationPhase,
  launchFailureHelp,
  TEMPLATE_REFUSAL_HELP,
} from "@armada/core";
import type { commandClient } from "@armada/sdk/commands";
import { validApiReceipt } from "./api-receipts.ts";
import { sandboxFailure } from "./sandbox-errors.ts";

export class ArmadaApiError extends AuthError {
  constructor(
    readonly serverCode: string,
    readonly status: number,
    message: string,
    readonly details?: Readonly<{ phase: string }>,
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
            : status === 401
              ? "unauthorized"
              : status === 409 || status === 403
                ? "conflict"
                : "unavailable",
    );
  }
}

type SdkCommandResponse = Parameters<Parameters<typeof commandClient>[2]>[0];

function isSandboxLaunchPath(path: string) {
  return path === "/api/v1/sandbox/launch";
}

const TEMPLATE_LAUNCH_UNKNOWN =
  "Template launch outcome unknown. Retry with the same template ID, request key and body; never use a new key while the outcome is unknown.";

export function decodeApiResponse(
  result: SdkCommandResponse,
  path: string,
  url: URL,
  environmentToken: string | undefined,
  preserveServerErrors = false,
) {
  if (result.kind === "transport") {
    throw new AuthError(
      path === "/api/v1/templates/launch"
        ? TEMPLATE_LAUNCH_UNKNOWN
        : result.timedOut
          ? `The server did not answer in time; the operation may have been accepted.${
              isSandboxLaunchPath(path) ? " Run armada ls to check before retrying." : ""
            }`
          : isSandboxLaunchPath(path)
            ? "Launch outcome unknown. Run armada ls to check before retrying."
            : "Armada could not reach the server.",
      "unavailable",
    );
  }
  const { response, payload, rawCode: failureCode } = result;
  if (
    response.ok &&
    path === "/api/v1/templates/launch" &&
    (!payload || typeof payload !== "object" || Array.isArray(payload))
  )
    throw new ArmadaApiError("unavailable", response.status, TEMPLATE_LAUNCH_UNKNOWN);
  if (response.ok) {
    if (!validApiReceipt(path, payload))
      throw new ArmadaApiError(
        "unavailable",
        response.status,
        "Armada returned an invalid success receipt. The operation may have been accepted; inspect its state before retrying. For sandbox operations, run armada info <id> or armada ls. Do not replay a mutation blindly.",
      );
    return payload;
  }
  if (response.status === 409 && failureCode === "host_full")
    throw new ArmadaApiError(
      "host_full",
      409,
      "The selected Docker host is full. Stop a sandbox on that host or raise its limit before retrying.",
    );
  if (response.status === 404 && (!failureCode || failureCode === "unknown_route"))
    throw new ArmadaApiError(
      "unavailable",
      response.status,
      `This Armada deployment at ${url.origin} does not serve ${url.pathname}; the dashboard or server may be out of date. Ask an administrator to verify the deployment.`,
    );
  if (path === "/api/v1/templates/launch" && response.status >= 500)
    throw new ArmadaApiError("unavailable", response.status, TEMPLATE_LAUNCH_UNKNOWN);
  if (path.startsWith("/api/v1/templates/")) {
    const known: Record<string, string> = {
      "Template revision unavailable.":
        "Template revision unavailable. Get the template and choose an existing revision.",
      ...Object.fromEntries(
        Object.entries(TEMPLATE_REFUSAL_HELP).map(([reason, help]) => [`Template launch refused: ${reason}.`, help]),
      ),
      "Template name or request key already exists.":
        "Template name or request key already exists. Choose another template name or inspect the original launch request.",
      "Request key already used with a different request.":
        "Request key already used with a different request. Retry only the original key and body until its outcome is known.",
    };
    const fallback: Record<number, string> = {
      400: "Invalid template request. Check the definition, IDs, versions and supported overrides. Secret bindings require IDs and versions; inline secret values are not accepted.",
      401: "Run armada login or update ARMADA_TOKEN.",
      403: "Template access denied. Current membership is required; only admins can mutate organization templates.",
      404: "Template or revision not found or not visible.",
      409: "Template reference changed or is unavailable. Check its snapshot, connections, variable and model-account versions before retrying.",
    };
    const message = apiMessage(payload, "");
    throw new ArmadaApiError(
      resourceFailureCode(response.status),
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
  if (isSandboxLaunchPath(path)) {
    const help = launchFailureHelp(
      failureCode,
      (payload as { error?: { details?: unknown } })?.error?.details,
      apiMessage(payload, ""),
    );
    if (help && failureCode)
      throw new ArmadaApiError(
        failureCode,
        response.status,
        help,
        undefined,
        ["invalid_request", "no_credentials"].includes(failureCode) ? 2 : 1,
      );
  }
  if (isSandboxLaunchPath(path) && response.status >= 500)
    throw new AuthError("Launch outcome unknown. Run armada ls to check before retrying.", "unavailable");
  const sandboxError = sandboxFailure(path, response.status, failureCode, apiMessage(payload, ""));
  if (sandboxError)
    throw new ArmadaApiError(
      sandboxError.code,
      response.status,
      sandboxError.message,
      undefined,
      sandboxError.exitCode,
    );
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
  if (response.status === 401)
    throw new AuthError(
      environmentToken && bearerKind(environmentToken) === "service"
        ? "API key is invalid, expired, or revoked. Update ARMADA_TOKEN."
        : "Run armada login or update ARMADA_TOKEN.",
      "unauthorized",
    );
  if (preserveServerErrors) {
    throw new ArmadaApiError(
      result.failure?.serverCode && result.failure.serverCode.length <= 80 && failureCode ? failureCode : "unavailable",
      response.status,
      apiMessage(payload, `Armada server request failed (${response.status}) at ${url.origin}.`),
    );
  }
  if (response.status === 403) throw new AuthError(apiMessage(payload, "Armada refused this request."), "conflict");
  throw new AuthError(apiMessage(payload, `Armada server request failed (${response.status}).`), "unavailable");
}

function resourceFailureCode(status: number) {
  switch (status) {
    case 400:
      return "invalid";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    default:
      return "unavailable";
  }
}

function apiMessage(payload: unknown, fallback: string) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return fallback;
  const error = (payload as Record<string, unknown>).error;
  const message = typeof error === "object" && error !== null ? (error as Record<string, unknown>).message : undefined;
  return typeof message === "string" && message.length > 0 ? message : fallback;
}

function isSandboxInteriorPath(path: string) {
  return (
    /^\/api\/v1\/sandbox\/(?:status|send|steer|interrupt|exec|stop|extend|wait)$/.test(path) ||
    /^\/api\/v1\/sandboxes\/[0-9a-f-]+(?:\?.*)?$/i.test(path) ||
    path === "/api/v1/logs/read" ||
    path === "/api/v1/mcp/sandbox-connections"
  );
}
