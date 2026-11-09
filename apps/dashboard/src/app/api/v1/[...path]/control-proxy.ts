import { NextResponse } from "next/server";

const CONTROL_PREFIX = "/api/v1/";
const MAX_BODY_BYTES = 128 * 1024;

const PUBLIC_POST_PATHS = new Set(["auth/refresh", "auth/exchange", "auth/email/start", "auth/email/verify"]);
const PRIVATE_POST_PATHS = new Set([
  "account/status",
  "account/logout",
  "github/status",
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
  "creds/accounts/default",
  "creds/accounts/remove",
  "creds/accounts/usage",
  "creds/accounts/auth-capabilities",
  "golden/list",
  "golden/capabilities",
  "golden/size-policy",
  "golden/create",
  "golden/build/status",
  "golden/update",
  "golden/remove",
  "golden/retirement/dry-run",
  "golden/retirement/reconcile",
  "golden/snapshot",
  "golden/connect",
  "sandbox/launch",
  "sandbox/launch-sized-v1",
  "sandbox/bind-credential",
  "sandbox/list",
  "sandbox/detail",
  "sandbox/status",
  "sandbox/advice",
  "sandbox/send",
  "sandbox/stop",
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

type ControlVerb = "GET" | "POST";
const ORCHESTRATOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only the actual owner API shapes. No delegated/private callback or arbitrary tail. */
function orchestratorPath(method: ControlVerb, path: readonly string[]): boolean {
  if (path[0] !== "orchestrators") return false;
  if (path.length === 1) return true;
  if (method === "POST" && path.length === 2 && path[1] === "reconcile") return true;
  if (method === "GET" && path.length === 2 && path[1] === "capabilities") return true;
  if (!path[1] || !ORCHESTRATOR_ID.test(path[1])) return false;
  return method === "GET"
    ? path.length === 2 || (path.length === 3 && path[2] === "events")
    : path.length === 3 && ["message", "steer", "stop", "resume"].includes(path[2] ?? "");
}

function fail(status: number, error: string): Response {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

/** Bound raw streamed bytes before decoding/forwarding, including absent/chunked length. */
async function boundedBody(request: Request): Promise<ArrayBuffer | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw Error("too_large");
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_BODY_BYTES) {
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
  if (request.method !== "GET" && request.method !== "POST") return fail(404, "Not found.");
  const method: ControlVerb = request.method;
  const relative = path.join("/");
  const orchestrator = orchestratorPath(method, path);
  const isPublic = method === "POST" && PUBLIC_POST_PATHS.has(relative);
  if (!orchestrator && !(method === "POST" && (isPublic || PRIVATE_POST_PATHS.has(relative))))
    return fail(404, "Not found.");
  const authorization = request.headers.get("authorization");
  if (!isPublic && !authorization) return fail(401, "Unauthorized.");
  let body: ArrayBuffer | null = null;
  try {
    if (method === "POST") body = await boundedBody(request);
  } catch (error) {
    return error instanceof Error && error.message === "too_large"
      ? fail(413, "Request too large.")
      : fail(400, "Invalid request body.");
  }
  const target = new URL(`${CONTROL_PREFIX}${relative}`, upstream);
  if (orchestrator) target.search = new URL(request.url).search;
  const idempotencyKey = orchestrator && method === "POST" ? request.headers.get("idempotency-key") : null;
  let response: Response;
  try {
    response = await fetchImpl(target, {
      method,
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(idempotencyKey !== null ? { "idempotency-key": idempotencyKey } : {}),
        ...(method === "POST" ? { "content-type": request.headers.get("content-type") ?? "application/json" } : {}),
        accept: "application/json",
      },
      ...(body ? { body } : {}),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(
          ["golden/create", "golden/update", "golden/build/status"].includes(relative) ? 15_000 : 660_000,
        ),
      ]),
    });
  } catch {
    return fail(502, "Armada API is unavailable.");
  }
  const headers = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
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
