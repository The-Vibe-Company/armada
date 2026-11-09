import type { GoldenBuildStatus, SandboxProviderId } from "@armada/core";
import {
  type ConnectionMetadataRequest,
  type ConnectionTarget,
  type CreateConnectionRequest,
  type CreateFromCatalogRequest,
  type McpCatalogService,
  type McpConnection,
  parseCatalogService,
  parseConnection,
  safeAuthorizationUrl,
  type UpdateConnectionRequest,
} from "./connections.ts";

/**
 * The dashboard's server-side client of the Armada control API (`/api/v1/*`), for the operations only the
 * server can do (a golden build needs the encrypted Boat key and the caller's GitHub connection; the golden
 * limit is read from the provider the server resolves). It runs in server components and server actions with
 * the signed-in user's session token; the token is a request header only and never appears in an error, a
 * result or a log. One request per call: a failure is reported, never retried.
 */
export class ControlError extends Error {
  override readonly name = "ControlError";
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Options = {
  /** `ARMADA_MCP_URL`; only its origin is used. */
  serverUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** Defaults to `GOLDEN_BUILD_TIMEOUT_MS`; a short read passes its own. */
  timeoutMs?: number;
};

/** Admission and status are short requests; build execution belongs to the durable worker. */
export const GOLDEN_BUILD_TIMEOUT_MS = 10_000;

/** A capacity read is metadata: a page render does not wait on it for long. */
export const CAPABILITIES_TIMEOUT_MS = 10_000;

export type ControlClient = {
  post<T>(route: string, body: Record<string, unknown>): Promise<T>;
};

export function createControlClient(options: Options): ControlClient {
  const origin = originOf(options.serverUrl);
  const doFetch = options.fetch ?? fetch;
  return {
    async post<T>(route: string, body: Record<string, unknown>): Promise<T> {
      if (!origin) throw new ControlError("The Armada server is not configured for this dashboard.");
      let response: Response;
      try {
        response = await doFetch(new URL(`/api/v1/${route}`, origin), {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(options.timeoutMs ?? GOLDEN_BUILD_TIMEOUT_MS),
        });
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
          throw new ControlError(
            "The Armada server did not answer in time. The build may still finish: refresh before trying again.",
          );
        throw new ControlError("The Armada server is unreachable.");
      }
      const parsed = await readJson(response);
      if (response.status === 401)
        throw new ControlError("The Armada server refused this session. Sign in again.", 401);
      if (!response.ok) {
        const failure = isRecord(parsed) ? parsed.error : undefined;
        if (isRecord(failure) && typeof failure.message === "string")
          throw new ControlError(
            failure.message,
            response.status,
            typeof failure.code === "string" ? failure.code : undefined,
          );
        if (typeof failure === "string") throw new ControlError(failure, response.status);
        throw new ControlError(`The Armada server answered ${response.status}.`, response.status);
      }
      return parsed as T;
    },
  };
}

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
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

export type GoldenBuildResult = { name: string; visibility: "org" | "private"; snapshot: string };

export function isGoldenBuildResult(value: unknown): value is GoldenBuildResult {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.snapshot === "string" &&
    (value.visibility === "org" || value.visibility === "private")
  );
}

/**
 * One provider's golden limit for an org, as the Armada server reads it from the backend it resolves for that org
 * and provider (`golden/capabilities {org, provider}`). `maxGoldens` null means the server reports no limit (Modal
 * is unbounded), which is not zero. `unavailable` is a failed read (no access, the provider not configured for the
 * org, an older server, an answer for another provider): the limit is then not known here, and the server still
 * checks it when it builds.
 */
export type GoldenCapabilities = { ok: true; maxGoldens: number | null } | { ok: false; reason: string };

export async function readGoldenCapabilities(
  client: ControlClient,
  org: string,
  provider: SandboxProviderId,
): Promise<GoldenCapabilities> {
  let result: unknown;
  try {
    result = await client.post("golden/capabilities", { org, provider });
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    if (error.status === 404 && error.code === undefined)
      return { ok: false, reason: "This Armada server does not report golden capacity yet." };
    return { ok: false, reason: error.message };
  }
  if (
    isRecord(result) &&
    result.provider === provider &&
    (result.maxGoldens === null ||
      (typeof result.maxGoldens === "number" && Number.isInteger(result.maxGoldens) && result.maxGoldens > 0))
  )
    return { ok: true, maxGoldens: result.maxGoldens };
  return { ok: false, reason: "The Armada server sent an unexpected answer." };
}

export const MCP_CONTROL_PATH = "/api/v1/mcp/";

export type ArmadaApiOptions = {
  /** Any URL on the Armada server, such as `ARMADA_MCP_URL`; only its origin is used. */
  serverUrl: string;
  token: string;
  fetch?: typeof fetch;
};

export type McpControl = ReturnType<typeof createMcpControl>;

/**
 * One authenticated POST to the Armada API: JSON in, a JSON object out, its `{error: {message}}` turned into a
 * {@link ControlError}. `feature` names what an older server does not offer yet.
 */
export async function controlPost(
  options: ArmadaApiOptions,
  path: string,
  body: object,
  feature = "MCP connections",
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(new URL(path, new URL(options.serverUrl).origin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.token}` },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new ControlError("The Armada server is unreachable.");
  }
  const payload = await readMcpJson(response);
  if (response.ok) {
    if (!payload) throw new ControlError("The Armada server sent something unreadable.", response.status);
    return payload;
  }
  throw failure(response.status, payload, feature);
}

export function createMcpControl(options: ArmadaApiOptions) {
  const post = (operation: string, body: object) => controlPost(options, `${MCP_CONTROL_PATH}${operation}`, body);

  async function connection(operation: string, body: object) {
    const payload = await post(operation, body);
    const parsed = parseConnection(payload.connection);
    if (!parsed) throw new ControlError("The Armada server sent an unexpected connection.");
    return { payload, connection: parsed };
  }

  async function confirm(operation: string, body: ConnectionTarget): Promise<void> {
    const payload = await post(operation, body);
    if (payload.ok !== true) throw new ControlError("The Armada server did not confirm the change.");
  }

  return {
    async list(org: string): Promise<McpConnection[]> {
      const payload = await post("list", { org });
      if (!Array.isArray(payload.connections)) throw new ControlError("The Armada server sent no connection list.");
      // Rows of another org are dropped even if the server sent them: the page shows the selected org only.
      return payload.connections.map(parseConnection).filter((row): row is McpConnection => row?.orgId === org);
    },
    /**
     * The curated services this server offers, with their availability here. An older server without the catalog
     * answers 404, which surfaces as a {@link ControlError} naming the missing feature.
     */
    async catalog(org: string): Promise<McpCatalogService[]> {
      const payload = await controlPost(options, `${MCP_CONTROL_PATH}catalog`, { org }, "the service catalog");
      if (!Array.isArray(payload.services)) throw new ControlError("The Armada server sent no service catalog.");
      return payload.services.map(parseCatalogService).filter((row): row is McpCatalogService => row !== null);
    },
    create: async (request: CreateConnectionRequest) => (await connection("create", request)).connection,
    /** Creates a connection to a catalog service: only its id travels; the server owns its URL and sign-in. */
    createFromCatalog: async (request: CreateFromCatalogRequest) => (await connection("create", request)).connection,
    /** Renames or changes include-by-default, keeping the stored authorization and running sandboxes' access. */
    metadata: async (request: ConnectionMetadataRequest) => (await connection("metadata", request)).connection,
    update: async (request: UpdateConnectionRequest) => (await connection("update", request)).connection,
    status: async (target: ConnectionTarget) => (await connection("status", target)).connection,
    /** Starts or repeats the connection. An OAuth server answers with the URL the browser signs in at. */
    async connect(target: ConnectionTarget): Promise<{ connection: McpConnection; authorizationUrl: string | null }> {
      const { payload, connection: parsed } = await connection("connect", target);
      if (payload.authorizationUrl === undefined || payload.authorizationUrl === null) {
        return { connection: parsed, authorizationUrl: null };
      }
      const authorizationUrl = safeAuthorizationUrl(payload.authorizationUrl);
      if (!authorizationUrl) throw new ControlError("The sign-in address from the server was refused as unsafe.");
      return { connection: parsed, authorizationUrl };
    },
    revoke: (target: ConnectionTarget) => confirm("revoke", target),
    delete: (target: ConnectionTarget) => confirm("delete", target),
    /** Turns a connection off for new launches, or back on. Its stored authorization is kept. */
    setEnabled: async (target: ConnectionTarget & { enabled: boolean }) =>
      (await connection("set-enabled", target)).connection,
    /**
     * The connections bound to one sandbox, as the registry recorded them at launch, limited to what the viewer
     * may see. `id` is the sandbox id.
     */
    async sandboxConnections(target: ConnectionTarget): Promise<McpConnection[]> {
      const payload = await post("sandbox-connections", target);
      if (!Array.isArray(payload.connections)) throw new ControlError("The Armada server sent no connection list.");
      return payload.connections.map(parseConnection).filter((row): row is McpConnection => row?.orgId === target.org);
    },
    /**
     * Completes a browser sign-in. The server matches `state` with the pending authorization it created, which
     * names the org and connection; the dashboard only relays the provider's answer with the viewer's bearer.
     */
    oauthCallback: async (body: { state: string; code: string; issuer?: string }) =>
      (await connection("oauth/callback", body)).connection,
  };
}

async function readMcpJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await response.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The server's `{error: {code, message}}`, in words for the person. Its message is already sanitized. */
function failure(status: number, payload: Record<string, unknown> | null, feature: string): ControlError {
  const error = payload && typeof payload.error === "object" && payload.error !== null ? payload.error : null;
  const message = error && "message" in error && typeof error.message === "string" ? error.message.slice(0, 300) : null;
  if (status === 401) return new ControlError("The Armada server refused this session. Sign in again.", status);
  if (status === 403) return new ControlError(message ?? "You are not allowed to do that.", status);
  if ((status === 404 || status === 405) && (!message || message === "Unknown route.")) {
    return new ControlError(`This Armada server does not offer ${feature} yet.`, status);
  }
  if (status >= 500) return new ControlError(message ?? "The Armada server could not complete the request.", status);
  return new ControlError(message ?? `The Armada server answered ${status}.`, status);
}

/** A golden build job receipt or status (`golden/create`, `golden/update`, `golden/build/status`). */
export function isGoldenBuildStatus(value: unknown): value is GoldenBuildStatus {
  return (
    isRecord(value) &&
    typeof value.jobId === "string" &&
    typeof value.phase === "string" &&
    ["queued", "running", "recovery_required", "succeeded", "failed"].includes(String(value.state)) &&
    (value.errorCode === null || value.errorCode === "build_failed") &&
    (value.result === null || isGoldenBuildResult(value.result))
  );
}

/** `golden/remove {id, org?}`'s answer: the golden is retired; its sandboxes and provider artifacts are kept. */
export type GoldenRemoval = { id: string; removedAt: string; artifacts: "retained" };

export function isGoldenRemoval(value: unknown): value is GoldenRemoval {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.removedAt === "string" &&
    value.artifacts === "retained"
  );
}
