import type { OrchestratorDetail, OrchestratorOperation } from "@armada/core";
import {
  type Command,
  isIdempotencyKey,
  isOrchestratorId,
  type OrchestratorCreateRequest,
  type OrchestratorFeedPage,
  type OrchestratorListView,
  parseOperation,
  parseOrchestratorDetail,
  parseOrchestratorEventPage,
  parseOrchestratorList,
} from "./orchestrators.ts";

/**
 * The dashboard's server-side client of the orchestrator routes of the Armada control API (#647's
 * `/api/v1/orchestrators`), as the signed-in viewer. The same server policies serve the CLI and MCP; this client only
 * relays the person's choices with their bearer, which never appears in an error or a log. One request per call:
 * nothing is retried here, and a retry by the person reuses the same `Idempotency-Key` when the outcome is unknown.
 */
export const ORCHESTRATORS_PATH = "/api/v1/orchestrators";

/**
 * Why a request did not succeed, in the terms the page acts on:
 * - `unavailable`: this server does not offer orchestrators (yet), or not to this dashboard;
 * - `stale`: the orchestrator moved past the revision the page saw; reload it, then decide again;
 * - `session`: the session is expired or refused; sign in again;
 * - `uncertain`: the answer was lost or the server is reconciling; the same request may be repeated as is;
 * - `rejected`: a definite refusal (invalid, not allowed, not found, a limit, no native continuity).
 */
export type OrchestratorFailure = "unavailable" | "stale" | "session" | "uncertain" | "rejected";

export class OrchestratorApiError extends Error {
  override readonly name = "OrchestratorApiError";
  constructor(
    message: string,
    readonly failure: OrchestratorFailure,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }
  /** Repeating the request with the same key cannot apply it twice and may still be needed. */
  get retrySameKey(): boolean {
    return this.failure === "uncertain";
  }
}

export type OrchestratorApiOptions = {
  /** `ARMADA_MCP_URL`; only its origin is used. */
  serverUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/** Reads and admissions are short; a launch runs in the server's own worker, never inside this request. */
const TIMEOUT_MS = 15_000;
const LIST_LIMIT = 100;
const EVENT_LIMIT = 500;

export type OrchestratorApi = ReturnType<typeof createOrchestratorApi>;

export function createOrchestratorApi(options: OrchestratorApiOptions) {
  const origin = originOf(options.serverUrl);

  async function call(method: "GET" | "POST", path: string, body?: object, key?: string): Promise<unknown> {
    if (!origin)
      throw new OrchestratorApiError("The Armada server is not configured for this dashboard.", "unavailable");
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(new URL(path, origin), {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
          ...(key ? { "idempotency-key": key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      });
    } catch {
      throw new OrchestratorApiError(
        method === "GET"
          ? "The Armada server did not answer. Retrying…"
          : "The Armada server did not confirm the request. Sending it again is safe: it is applied once.",
        "uncertain",
      );
    }
    const payload = await readJson(response);
    if (response.ok) return payload;
    throw failureOf(response.status, payload);
  }

  function path(id: string, suffix = ""): string {
    if (!isOrchestratorId(id)) throw new OrchestratorApiError("That orchestrator does not exist.", "rejected", 404);
    return `${ORCHESTRATORS_PATH}/${encodeURIComponent(id)}${suffix}`;
  }

  function receipt(payload: unknown, orchestratorId?: string): OrchestratorOperation {
    const operation = parseOperation(payload);
    if (!operation || (orchestratorId !== undefined && operation.orchestratorId !== orchestratorId))
      throw new OrchestratorApiError("The Armada server sent an unexpected receipt.", "uncertain");
    return operation;
  }

  function requireKey(key: string): string {
    if (!isIdempotencyKey(key)) throw new OrchestratorApiError("That request is not valid.", "rejected", 400);
    return key;
  }

  return {
    /**
     * `GET /orchestrators/capabilities`: whether this server admits orchestrators now. Feature-off servers answer
     * `enabled: false` with a reason (such as `native_conformance_required`); older servers have no such route.
     */
    async capabilities(): Promise<OrchestratorCapabilities> {
      let payload: unknown;
      try {
        payload = await call("GET", `${ORCHESTRATORS_PATH}/capabilities`);
      } catch (error) {
        if (error instanceof OrchestratorApiError && error.failure === "unavailable")
          return { enabled: false, reason: null, message: error.message };
        throw error;
      }
      return parseCapabilities(payload);
    },
    async list(orgId: string, cursor?: string | null): Promise<OrchestratorListView> {
      const query = new URLSearchParams({ orgId, limit: String(LIST_LIMIT) });
      if (cursor) query.set("cursor", cursor);
      return parseOrchestratorList(await call("GET", `${ORCHESTRATORS_PATH}?${query}`), orgId);
    },
    /** Every read and write names the organization (`orgId`): the server checks the viewer's membership in it. */
    async detail(orgId: string, id: string): Promise<OrchestratorDetail> {
      return parseOrchestratorDetail(await call("GET", `${path(id)}?${new URLSearchParams({ orgId })}`), id);
    },
    async events(orgId: string, id: string, cursor?: string | null): Promise<OrchestratorFeedPage> {
      const query = new URLSearchParams({ orgId, limit: String(EVENT_LIMIT) });
      if (cursor) query.set("cursor", cursor);
      return parseOrchestratorEventPage(await call("GET", `${path(id, "/events")}?${query}`), id);
    },
    /** 202 with the create receipt, which names the new orchestrator's id. */
    async create(request: OrchestratorCreateRequest, key: string): Promise<OrchestratorOperation> {
      try {
        return receipt(await call("POST", ORCHESTRATORS_PATH, request, requireKey(key)));
      } catch (error) {
        // Create has no revision to be stale against: a bare conflict may follow a launch whose outcome could not be
        // recorded. It is treated as unknown, so the same request (same key) is sent again, never a second create.
        // A server before #662's size contract refuses the field as invalid: say what to change.
        if (
          error instanceof OrchestratorApiError &&
          request.size !== undefined &&
          error.status === 400 &&
          error.code === "invalid_request"
        )
          throw new OrchestratorApiError(
            "This Armada server does not accept a machine size for orchestrators yet. Choose Default and try again.",
            "rejected",
            error.status,
            error.code,
          );
        if (error instanceof OrchestratorApiError && error.failure === "stale")
          throw new OrchestratorApiError(
            "Armada could not confirm whether it was created. Trying again cannot create it twice.",
            "uncertain",
            error.status,
            error.code,
          );
        throw error;
      }
    },
    /** `message` and `steer` carry text; `stop` and `resume` only the fence. */
    async command(
      orgId: string,
      id: string,
      command: Command,
      expectedRevision: number,
      key: string,
      text?: string,
    ): Promise<OrchestratorOperation> {
      const body =
        command === "message" || command === "steer" ? { orgId, expectedRevision, text } : { orgId, expectedRevision };
      return receipt(await call("POST", path(id, `/${command}`), body, requireKey(key)), id);
    },
  };
}

/** Words for the codes the server sends without a sentence. */
const CODE_WORDS: Record<string, string> = {
  not_found: "That orchestrator does not exist, or it is not yours.",
  invalid_request: "The Armada server refused the request as invalid. Reload and try again.",
  unavailable: "Orchestrators are unavailable on this Armada server right now.",
};

export type OrchestratorCapabilities = { enabled: boolean; reason: string | null; message: string };

const REASONS: Record<string, string> = {
  native_conformance_required:
    "Orchestrators are turned off on this Armada server until each provider passes its native conformance checks.",
};

/** `{version: 1, enabled, reason?}`. Anything else, or another version, reads as not enabled. */
export function parseCapabilities(value: unknown): OrchestratorCapabilities {
  if (!isRecord(value) || value.version !== 1 || typeof value.enabled !== "boolean")
    return { enabled: false, reason: null, message: "The Armada server sent unexpected orchestrator capabilities." };
  const reason = typeof value.reason === "string" ? value.reason.slice(0, 80) : null;
  if (value.enabled) return { enabled: true, reason, message: "" };
  return {
    enabled: false,
    reason,
    message: (reason && REASONS[reason]) ?? "Orchestrators are turned off on this Armada server.",
  };
}

/** The server's `{error: {code, message}}` (already sanitized), classified for the page. */
export function failureOf(status: number, payload: unknown): OrchestratorApiError {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
  const code = typeof error?.code === "string" ? error.code : undefined;
  const raw = typeof error?.message === "string" ? error.message.slice(0, 300) : null;
  // The candidate server (#662) answers its bare code as the message: that is no sentence for a person.
  const message = raw && raw !== code ? raw : (CODE_WORDS[code ?? ""] ?? null);
  // A server without these routes: an unknown POST route is 404 "Unknown route.", a GET is refused with 405.
  if (status === 405 || (status === 404 && (!message || message === "Unknown route.")))
    return new OrchestratorApiError(
      "This Armada server does not offer orchestrators yet.",
      "unavailable",
      status,
      code,
    );
  if (status === 401)
    return new OrchestratorApiError("Your session expired or was refused. Sign in again.", "session", status, code);
  // A bare `conflict` (#662) covers a stale revision and a busy orchestrator alike: either way the page re-reads it and
  // the person decides again, under a new key.
  if (status === 409 && (code === "conflict" || /stale|revision/i.test(`${code ?? ""} ${raw ?? ""}`)))
    return new OrchestratorApiError(
      "This orchestrator changed or is busy. It is up to date now: check it and try again.",
      "stale",
      status,
      code,
    );
  if (status === 503 || status === 502 || status === 504)
    return new OrchestratorApiError(
      message ?? "The Armada server could not confirm the result. Sending it again is safe: it is applied once.",
      "uncertain",
      status,
      code,
    );
  if (status === 403)
    return new OrchestratorApiError(message ?? "You are not allowed to do that.", "rejected", status, code);
  if (status === 404)
    return new OrchestratorApiError(message ?? "That orchestrator does not exist.", "rejected", status, code);
  return new OrchestratorApiError(message ?? `The Armada server answered ${status}.`, "rejected", status, code);
}

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
