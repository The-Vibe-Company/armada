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
import {
  type InvitationView,
  type InviteRole,
  parseInvitation,
  parsePreview,
  type RecipientPreview,
} from "./invitations.ts";
import { parseRoutine, parseRoutineRun, type RoutineInput, routineFailure } from "./routines.ts";
import {
  type LaunchOutcome,
  parseLaunchOutcome,
  parseRevision,
  parseTemplate,
  type TemplateHeader,
  type TemplateRequest,
  type TemplateRevision,
} from "./templates.ts";
import { parseVaultItem, type VaultItem, type VaultKind, type VaultScope } from "./variables.ts";

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
  /** The server's machine-readable `error.reason`, when it sends one (organization invitations do). */
  readonly reason: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  constructor(
    message: string,
    status?: number,
    code?: string,
    detail?: { reason?: string | undefined; retryAfterSeconds?: number | undefined },
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.reason = detail?.reason;
    this.retryAfterSeconds = detail?.retryAfterSeconds;
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
export type GoldenBinding = {
  goldenId: string;
  relation: "current_backend" | "other_backend" | "unbound";
};
export type GoldenCapabilities =
  | { ok: true; maxGoldens: number | null; bindings?: readonly GoldenBinding[] }
  | { ok: false; reason: string };

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
  ) {
    if (
      result.bindings !== undefined &&
      (!Array.isArray(result.bindings) ||
        !result.bindings.every(
          (binding: unknown) =>
            isRecord(binding) &&
            typeof binding.goldenId === "string" &&
            ["current_backend", "other_backend", "unbound"].includes(String(binding.relation)),
        ))
    )
      return { ok: false, reason: "The Armada server sent unexpected binding metadata." };
    return {
      ok: true,
      maxGoldens: result.maxGoldens,
      ...(result.bindings === undefined ? {} : { bindings: result.bindings as GoldenBinding[] }),
    };
  }
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
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(new URL(path, new URL(options.serverUrl).origin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.token}` },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      ...(signal ? { signal } : {}),
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
  const error = payload && isRecord(payload.error) ? payload.error : null;
  const message = typeof error?.message === "string" ? error.message.slice(0, 300) : null;
  const code = typeof error?.code === "string" ? error.code : undefined;
  const detail = {
    reason: typeof error?.reason === "string" ? error.reason : undefined,
    retryAfterSeconds:
      typeof error?.retryAfterSeconds === "number" && Number.isFinite(error.retryAfterSeconds)
        ? error.retryAfterSeconds
        : undefined,
  };
  const make = (text: string, withCode = true) => new ControlError(text, status, withCode ? code : undefined, detail);
  if (status === 401) return make("The Armada server refused this session. Sign in again.", false);
  if (status === 403) return make(message ?? "You are not allowed to do that.");
  if ((status === 404 || status === 405) && (!message || message === "Unknown route.") && !detail.reason) {
    return make(`This Armada server does not offer ${feature} yet.`, false);
  }
  if (status >= 500) return make(message ?? "The Armada server could not complete the request.");
  return make(message ?? `The Armada server answered ${status}.`);
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

/**
 * Organization invitations, control API v1 (#640): `org/invitations/{create,list,resend,revoke,accept}`, POST with
 * the viewer's bearer. The server checks the admin role, the recipient's verified email and the token; the
 * dashboard relays and parses. The accept token is a request body field only, never part of a URL or an error.
 */
export function createInvitationControl(options: ArmadaApiOptions) {
  const post = (operation: string, body: object) =>
    controlPost(options, `/api/v1/org/invitations/${operation}`, body, "organization invitations");

  async function one(operation: string, body: object): Promise<InvitationView> {
    const invitation = parseInvitation((await post(operation, body)).invitation);
    if (!invitation) throw new ControlError("The Armada server sent an unexpected invitation.");
    return invitation;
  }

  return {
    create: (request: { org: string; email: string; role: InviteRole }) => one("create", request),
    /** Every invitation of the org the server returns; the page keeps the pending ones. */
    async list(org: string): Promise<unknown[]> {
      const payload = await post("list", { org });
      if (!Array.isArray(payload.invitations)) throw new ControlError("The Armada server sent no invitation list.");
      return payload.invitations;
    },
    resend: (target: { org: string; id: string }) => one("resend", target),
    revoke: (target: { org: string; id: string }) => one("revoke", target),
    /** What the signed-in recipient may see of the invitation before consenting. Reads only; never joins. */
    async preview(token: string): Promise<RecipientPreview> {
      const preview = parsePreview(await post("preview", { token }));
      if (!preview) throw new ControlError("The Armada server sent an unexpected invitation preview.");
      return preview;
    },
    /** The explicit join. Answers the org now joined. */
    async accept(token: string): Promise<{ orgId: string }> {
      const payload = await post("accept", { token });
      if (payload.accepted !== true || typeof payload.orgId !== "string")
        throw new ControlError("The Armada server did not confirm the invitation.");
      return { orgId: payload.orgId };
    },
  };
}

/**
 * Variables and write-only application secrets (#921's control API, #935's page): `variables/*` and `secrets/*`,
 * POST with the viewer's bearer. Every answer is parsed to metadata only; `readVariable` is the one call that
 * returns a value, and only for a readable variable. There is no secret read: the server has no such route.
 */
export function createVaultControl(options: ArmadaApiOptions) {
  const post = (kind: VaultKind, operation: string, body: object) =>
    controlPost(options, `/api/v1/${kind === "variable" ? "variables" : "secrets"}/${operation}`, body, FEATURE);

  async function item(kind: VaultKind, operation: string, body: object): Promise<VaultItem> {
    const parsed = parseVaultItem(kind, (await post(kind, operation, body)).item);
    if (!parsed) throw new ControlError("The Armada server sent an unexpected answer.");
    return parsed;
  }

  async function list(kind: VaultKind, org: string): Promise<VaultItem[]> {
    const payload = await post(kind, "list", { org });
    if (!Array.isArray(payload.items)) throw new ControlError("The Armada server sent no list.");
    return payload.items
      .map((row: unknown) => parseVaultItem(kind, row))
      .filter((row): row is VaultItem => row?.orgId === org);
  }

  return {
    /** Both kinds of the org the viewer may see: their own personal items and the org's. */
    async list(org: string): Promise<VaultItem[]> {
      const [variables, secrets] = await Promise.all([list("variable", org), list("secret", org)]);
      return [...variables, ...secrets];
    },
    async readVariable(target: { org: string; id: string }): Promise<string> {
      const payload = await post("variable", "read", target);
      if (typeof payload.value !== "string") throw new ControlError("The Armada server sent no value.");
      return payload.value;
    },
    create: (kind: VaultKind, request: { org: string; scope: VaultScope; name: string; value: string }) =>
      item(kind, "set", request),
    updateVariable: (request: { org: string; id: string; expectedVersion: number; name?: string; value?: string }) =>
      item("variable", "update", request),
    /** Replaces a secret's value; the old one is gone for good. */
    rotateSecret: (request: { org: string; id: string; expectedVersion: number; value: string }) =>
      item("secret", "rotate", request),
    revoke: (kind: VaultKind, target: { org: string; id: string; expectedVersion: number }) =>
      item(kind, "revoke", target),
    /** Answers the deleted item's tombstone: its name and final version, no value. */
    async delete(kind: VaultKind, target: { org: string; id: string; expectedVersion: number }) {
      const parsed = parseVaultItem(kind, (await post(kind, "delete", target)).item, { tombstone: true });
      if (!parsed) throw new ControlError("The Armada server sent an unexpected answer.");
      return parsed;
    },
  };
}

const FEATURE = "variables and secrets";

/**
 * Launch templates (#938's control API, #949's page): `templates/*`, POST with the viewer's bearer. Every answer is
 * parsed to the header and the four choices of a revision; a launch's manifest (which carries readable values) is
 * never kept, only its state and sandbox id.
 */
export function createTemplateControl(options: ArmadaApiOptions) {
  const post = (operation: string, body: object) =>
    controlPost(options, `/api/v1/templates/${operation}`, body, "templates");

  async function saved(operation: string, body: object): Promise<{ item: TemplateHeader; revision: TemplateRevision }> {
    const payload = await post(operation, body);
    const item = parseTemplate(payload.item);
    const revision = parseRevision(payload.revision);
    if (!item || !revision) throw new ControlError("The Armada server sent an unexpected template.");
    return { item, revision };
  }

  return {
    /** The org's templates the viewer may see: their own personal ones and the org's. */
    async list(org: string): Promise<TemplateHeader[]> {
      const payload = await post("list", { org });
      if (!Array.isArray(payload.items)) throw new ControlError("The Armada server sent no template list.");
      return payload.items.map(parseTemplate).filter((row): row is TemplateHeader => row?.orgId === org);
    },
    /** One revision, the current one by default. */
    get: (target: { org: string; id: string; revision?: number }) => saved("get", target),
    create: (request: TemplateRequest & { org: string }) => saved("create", request),
    /** Publishes a new immutable revision; a stale `expectedRevision` is refused (409). */
    publish: (request: { org: string; id: string; expectedRevision: number; definition: Record<string, unknown> }) =>
      saved("publish", request),
    async delete(target: { org: string; id: string; expectedRevision: number }): Promise<void> {
      const payload = await post("delete", target);
      if (!isRecord(payload.item)) throw new ControlError("The Armada server did not confirm the deletion.");
    },
    async launch(request: {
      org: string;
      id: string;
      revision: number;
      requestKey: string;
      prompt?: string;
      ttlSeconds?: number;
      size?: string;
      repo?: string;
    }): Promise<LaunchOutcome> {
      const outcome = parseLaunchOutcome(await post("launch", request));
      if (!outcome) throw new ControlError("The Armada server sent an unexpected launch answer.");
      return outcome;
    },
  };
}

/** Owner-scoped routines; no raw provider text or launch manifests enter the dashboard. */
export function createRoutineControl(options: ArmadaApiOptions) {
  async function post(operation: string, body: object) {
    try {
      return await controlPost(options, `/api/v1/routines/${operation}`, body, "routines", AbortSignal.timeout(10_000));
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      throw new ControlError(routineFailure(error.status), error.status, error.code);
    }
  }
  async function saved(operation: string, body: object) {
    const payload = await post(operation, body),
      item = parseRoutine(payload.item);
    if (!item) throw new ControlError("The Armada server sent an unexpected routine.");
    return item;
  }
  return {
    async list(org: string) {
      const payload = await post("list", { org });
      if (!Array.isArray(payload.items)) throw new ControlError("The Armada server sent no routine list.");
      const items = payload.items.map(parseRoutine);
      if (items.some((x) => !x)) throw new ControlError("The Armada server sent an unexpected routine.");
      return items.filter((x): x is NonNullable<typeof x> => !!x && x.orgId === org && x.status !== "deleted");
    },
    create: (request: RoutineInput & { org: string }) => saved("create", request),
    enable: (request: { org: string; id: string; expectedVersion: number }) => saved("enable", request),
    pause: (request: { org: string; id: string; expectedVersion: number }) => saved("pause", request),
    async history(org: string, id: string) {
      const payload = await post("history", { org, id });
      if (!Array.isArray(payload.items)) throw new ControlError("The Armada server sent no run history.");
      const items = payload.items.map(parseRoutineRun);
      if (items.some((x) => !x)) throw new ControlError("The Armada server sent unexpected run history.");
      return items.filter((x): x is NonNullable<typeof x> => !!x);
    },
  };
}
