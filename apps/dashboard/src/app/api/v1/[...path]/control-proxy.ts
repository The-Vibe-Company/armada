import { PUBLIC_CONTROL_ROUTES } from "@armada/core";
import { NextResponse } from "next/server";

const CONTROL_PREFIX = "/api/v1/";
const MAX_BODY_BYTES = 128 * 1024;

/** POST routes the public endpoint forwards with a bearer. */
export const PRIVATE_POST_PATHS: ReadonlySet<string> = new Set([
  "golden/adopt",
  "github/runtime-status",
  "sandbox/resume",
  "sandbox/delete",
  "skillpack/connection",
  "creds/accounts/models",
  "creds/defaults/set",
  "skillpack/catalog",
  "skillpack/versions",
  "skills/defaults/get",
  "skills/defaults/set",
  "templates/create",
  "templates/list",
  "templates/get",
  "templates/publish",
  "templates/delete",
  "templates/launch",
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
  "account/status",
  "account/logout",
  "github/status",
  "github/refresh",
  "github/connect",
  "github/reconnect",
  "github/disconnect",
  "github/install",
  "token/list",
  "token/create",
  "token/revoke",
  "org/invitations/create",
  "org/invitations/list",
  "org/invitations/resend",
  "org/invitations/revoke",
  "org/invitations/accept",
  "org/invitations/preview",
  "org/create",
  "org/list",
  "org/provider/status",
  "org/provider/connect",
  "org/provider/disconnect",
  "members/list",
  "members/add",
  "members/role",
  "members/remove",
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
  "golden/list",
  "golden/capabilities",
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
  "launch/options",
  "sandbox/launch",
  "sandbox/launch-sized-v1",
  "sandbox/launch-access-v1",
  "sandbox/bind-credential",
  "sandbox/list",
  "sandbox/detail",
  "sandbox/status",
  "sandbox/recovery",
  "sandbox/report",
  "sandbox/advice",
  "sandbox/send",
  "sandbox/test-model-connection",
  "sandbox/stop",
  "sandbox/extend",
  "sandbox/wait",
  "sandbox/exec",
  "sandbox/steer",
  "sandbox/interrupt",
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
  "logs/read",
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
  return NextResponse.json(
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

/** Server-side, same-origin forwarding to the configured Armada control API. */
export async function forwardControl(
  request: Request,
  path: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const upstream = controlOrigin(process.env.ARMADA_MCP_URL);
  if (!upstream) return fail(503, "Armada API is not configured.");
  if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE")
    return fail(404, "Not found.");
  const method: ControlVerb = request.method;
  const relative = path.join("/");
  const sandboxDeletion =
    method === "DELETE" && path.length === 2 && path[0] === "sandboxes" && SANDBOX_ID.test(path[1] ?? "");
  const publicMethods: readonly string[] = Object.hasOwn(PUBLIC_CONTROL_ROUTES, relative)
    ? PUBLIC_CONTROL_ROUTES[relative as keyof typeof PUBLIC_CONTROL_ROUTES]
    : [];
  const isPublic = publicMethods.includes(method);
  if (!sandboxDeletion && !isPublic && !(method === "POST" && PRIVATE_POST_PATHS.has(relative)))
    return fail(404, "Not found.");
  const authorization = request.headers.get("authorization");
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
  if (method === "GET" || sandboxDeletion || relative === "skillpack/catalog" || relative === "skillpack/versions")
    target.search = new URL(request.url).search;
  let response: Response;
  try {
    response = await fetchImpl(target, {
      method,
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(method === "POST" ? { "content-type": request.headers.get("content-type") ?? "application/json" } : {}),
        accept: "application/json",
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
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

export function controlOrigin(value: string | undefined): string | null {
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
