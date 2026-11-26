import { CONTROL_BODY_MAX_BYTES } from "@armada/core";
import {
  controlRouteKey,
  isAntigravityLoginPath,
  operations,
  PUBLIC_CONTROL_ROUTES,
  skillpackOperations,
  streamSandboxEvents,
} from "@armada/core/contract";

const CONTROL_PREFIX = "/api/v1/";
const MAX_BODY_BYTES = CONTROL_BODY_MAX_BYTES;

/** POST routes the public endpoint forwards with a bearer. */
const PRIVATE_POST_PATHS: ReadonlySet<string> = new Set([
  ...Object.values(operations)
    .filter(
      (operation) =>
        operation.route.method === "POST" &&
        !operation.route.path.includes("{") &&
        !("directServer" in operation) &&
        !("anonymous" in operation),
    )
    .map(({ route }) => controlRouteKey(route)),
  "creds/accounts/models",
  "creds/defaults/set",
  "templates/create",
  "templates/list",
  "templates/get",
  "templates/publish",
  "templates/delete",
  "routines/create",
  "routines/list",
  "routines/get",
  "routines/update",
  "routines/enable",
  "routines/pause",
  "routines/delete",
  "routines/history",
  "routines/preview",
  "variables/list",
  "variables/read",
  "variables/set",
  "variables/update",
  "variables/revoke",
  "variables/delete",
  "secrets/list",
  "secrets/set",
  "secrets/rotate",
  "secrets/revoke",
  "secrets/delete",
  "secrets/upload",
  "secrets/commit",
  "github/status",
  "github/connect",
  "github/reconnect",
  "github/disconnect",
  "github/install",
  "org/invitations/create",
  "org/invitations/list",
  "org/invitations/resend",
  "org/invitations/revoke",
  "org/invitations/accept",
  "org/invitations/preview",
  "creds/set",
  "creds/list",
  "creds/rm",
  "creds/accounts/set",
  "creds/accounts/rename",
  "creds/accounts/limits",
  "creds/accounts/default",
  "creds/accounts/remove",
  "creds/accounts/usage",
  "creds/accounts/auth-capabilities",
  "golden/size-policy",
  "golden/create",
  "golden/build/status",
  "golden/build/find",
  "golden/build/cancel",
  "golden/update",
  "golden/update-add-repos",
  "golden/remove",
  "golden/retirement/dry-run",
  "golden/retirement/reconcile",
  "golden/snapshot",
  "golden/connect",
  "docker/hosts/register-token",
  "docker/hosts/list",
  "docker/hosts/limits",
  "docker/hosts/retention",
  "docker/snapshots/list",
  "docker/snapshots/get",
  "docker/snapshots/create",
  "docker/snapshots/rebuild",
  "docker/hosts/revoke",
  "golden/visibility",
  "mcp/list",
  "mcp/catalog",
  "mcp/metadata",
  "mcp/create",
  "mcp/update",
  "mcp/connect",
  "mcp/status",
  "mcp/set-enabled",
  "mcp/sandbox-connections",
  "mcp/revoke",
  "mcp/delete",
  "mcp/oauth/callback",
]);

type ControlVerb = "GET" | "POST" | "DELETE";
const SANDBOX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Failures the proxy raises itself use the API's typed envelope, so integrations decode one shape. */
const PROXY_FAILURE_CODE = {
  400: "invalid",
  401: "unauthorized",
  404: "unknown_route",
  413: "invalid",
  502: "upstream",
  503: "dependency_unavailable",
} as const;

function fail(status: keyof typeof PROXY_FAILURE_CODE, message: string): Response {
  return Response.json(
    { error: { code: PROXY_FAILURE_CODE[status], message: status === 404 ? "Unknown route." : message } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/** Bound raw streamed bytes before decoding/forwarding, including absent/chunked length. */
async function boundedBody(request: Request, maxBytes: number): Promise<ArrayBuffer | null> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw Error("too_large");
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        void reader.cancel().catch(() => {});
        throw Error("too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return length ? bytes.buffer : null;
}

type UpstreamFetch = (input: URL, init: RequestInit) => Promise<Response>;
type ViewerReader = () => Promise<{ token: string | null } | null>;
type ForwardOptions = { eventStream?: boolean; viewerToken?: string };

/** Server-side, same-origin forwarding to the configured Armada control API. */
export function forwardControl(request: Request, path: readonly string[], fetchImpl: UpstreamFetch = fetch) {
  return forwardRequest(request, path, fetchImpl);
}

export async function forwardControlGet(
  request: Request,
  path: readonly string[],
  readViewer: ViewerReader,
  fetchImpl: UpstreamFetch = fetch,
) {
  if (path.length !== 1 || path[0] !== controlRouteKey(streamSandboxEvents.route)) {
    return forwardControl(request, path, fetchImpl);
  }
  if (request.headers.get("authorization")?.trim()) {
    return forwardRequest(request, path, fetchImpl, { eventStream: true });
  }
  const viewer = await readViewer();
  if (!viewer?.token) {
    return Response.json(
      { error: { code: "unauthorized", message: "Sign in again." } },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    );
  }
  return forwardDashboardEventStream(request, viewer.token, fetchImpl);
}

export function forwardDashboardEventStream(request: Request, viewerToken: string, fetchImpl: UpstreamFetch = fetch) {
  return forwardRequest(request, [controlRouteKey(streamSandboxEvents.route)], fetchImpl, {
    eventStream: true,
    viewerToken,
  });
}

async function forwardRequest(
  request: Request,
  path: readonly string[],
  fetchImpl: UpstreamFetch,
  options?: ForwardOptions,
): Promise<Response> {
  const upstream = controlOrigin(process.env.ARMADA_MCP_URL);
  if (!upstream) return fail(503, "Armada API is not configured.");
  if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE")
    return fail(404, "Not found.");
  const method: ControlVerb = request.method;
  const sandboxOutputs = method === "GET" ? sandboxOutputsPath(request.url) : null;
  const relative = sandboxOutputs ?? path.join("/");
  const eventStream =
    Boolean(options?.eventStream) &&
    method === streamSandboxEvents.route.method &&
    relative === controlRouteKey(streamSandboxEvents.route);
  const forwardedHeaders = new Headers();
  if (sandboxOutputs && !sandboxOutputs.endsWith("/outputs")) {
    for (const name of ["range", "if-range"]) {
      const value = request.headers.get(name);
      if (value) forwardedHeaders.set(name, value);
    }
  }
  if (eventStream) {
    const cursor = request.headers.get("last-event-id");
    if (cursor) forwardedHeaders.set("last-event-id", cursor);
  }
  const sandboxDeletion =
    method === "DELETE" && path.length === 2 && path[0] === "sandboxes" && SANDBOX_ID.test(path[1] ?? "");
  const sandboxRelayTicket =
    method === "POST" &&
    path.length === 3 &&
    path[0] === "sandboxes" &&
    SANDBOX_ID.test(path[1] ?? "") &&
    path[2] === "relay-ticket";
  const publicMethods: readonly string[] = Object.hasOwn(PUBLIC_CONTROL_ROUTES, relative)
    ? (PUBLIC_CONTROL_ROUTES[relative] ?? [])
    : [];
  const isPublic = publicMethods.includes(method);
  const antigravityLogin =
    (method === "POST" || method === "DELETE") && isAntigravityLoginPath(`${CONTROL_PREFIX}${relative}`);
  if (
    !eventStream &&
    !sandboxOutputs &&
    !sandboxDeletion &&
    !sandboxRelayTicket &&
    !antigravityLogin &&
    !isPublic &&
    !(method === "POST" && PRIVATE_POST_PATHS.has(relative))
  )
    return fail(404, "Not found.");
  let authorization: string | null;
  if (options?.viewerToken !== undefined) {
    authorization = options.viewerToken ? `Bearer ${options.viewerToken}` : null;
  } else {
    authorization = request.headers.get("authorization")?.trim() || null;
  }
  if (!isPublic && !authorization) return fail(401, "Unauthorized.");
  let body: ArrayBuffer | null = null;
  try {
    if (method === "POST")
      body = await boundedBody(request, relative === "docker/snapshots/create" ? 1024 * 1024 : MAX_BODY_BYTES);
  } catch (error) {
    return error instanceof Error && error.message === "too_large"
      ? fail(413, "Request too large.")
      : fail(400, "Invalid request body.");
  }
  const target = new URL(`${CONTROL_PREFIX}${relative}`, upstream);
  if (
    method === "GET" ||
    sandboxDeletion ||
    relative === controlRouteKey(skillpackOperations.listSkillpackCatalog.route) ||
    relative === controlRouteKey(skillpackOperations.listSkillpackVersions.route)
  )
    target.search = new URL(request.url).search;
  let response: Response;
  try {
    response = await fetchImpl(target, {
      method,
      headers: {
        ...Object.fromEntries(forwardedHeaders),
        ...(authorization ? { authorization } : {}),
        ...(method === "POST" ? { "content-type": request.headers.get("content-type") ?? "application/json" } : {}),
        accept: eventStream ? streamSandboxEvents.outputMediaType : "application/json",
      },
      ...(body ? { body } : {}),
      redirect: isPublic ? "manual" : "error",
      cache: "no-store",
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(
          [
            "golden/create",
            "golden/update",
            "golden/update-add-repos",
            "golden/build/status",
            "golden/build/find",
            "golden/build/cancel",
          ].includes(relative)
            ? 15_000
            : 660_000,
        ),
      ]),
    });
  } catch {
    return fail(502, "Armada API is unavailable.");
  }
  const headers = new Headers();
  if (isPublic && response.status === 302 && response.headers.has("location"))
    headers.set("location", response.headers.get("location")!);
  const contentType = response.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  // Preserve the configured Armada upstream's fixed, numeric phase timings.
  const serverTiming = response.headers.get("server-timing");
  if (serverTiming) headers.set("server-timing", serverTiming);
  // Clients schedule retries from the upstream's delay; forward only well-formed values.
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (
    retryAfter &&
    (/^\d{1,10}$/.test(retryAfter) ||
      (/^[a-z]{3}, \d{2} [a-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/i.test(retryAfter) &&
        Number.isFinite(Date.parse(retryAfter))))
  )
    headers.set("retry-after", retryAfter);
  if (sandboxOutputs) {
    // A download must stay an attachment the browser never sniffs; the length is exact only for an unencoded body.
    for (const name of ["content-disposition", "x-content-type-options", "accept-ranges", "content-range", "etag"]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    const length = response.headers.get("content-length");
    if (length && !response.headers.has("content-encoding")) headers.set("content-length", length);
  }
  if (eventStream && response.headers.get("x-accel-buffering") === "no") headers.set("x-accel-buffering", "no");
  headers.set("cache-control", sandboxOutputs || eventStream ? "private, no-store" : "no-store");
  return new Response(response.body, { status: response.status, headers });
}

const SANDBOX_OUTPUTS =
  /^\/api\/v1\/(sandboxes\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/outputs(?:\/[^/]+)?)$/;

/**
 * The authenticated sandbox outputs list and download, read from the raw request path rather than the
 * decoded catch-all segments, so an encoded filename is forwarded as the single segment the caller sent.
 * URL parsing has already resolved dot segments, so none can retarget the request.
 */
function sandboxOutputsPath(url: string): string | null {
  return SANDBOX_OUTPUTS.exec(new URL(url).pathname)?.[1] ?? null;
}

function controlOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}
