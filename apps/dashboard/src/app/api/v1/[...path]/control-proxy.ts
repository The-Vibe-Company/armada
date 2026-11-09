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
  "golden/create",
  "golden/build/status",
  "golden/update",
  "golden/remove",
  "golden/snapshot",
  "golden/connect",
  "sandbox/launch",
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

/** Server-side, same-origin forwarding to the configured Armada control API. */
export async function forwardControl(
  request: Request,
  path: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const upstream = controlOrigin(process.env.ARMADA_MCP_URL);
  if (!upstream) return NextResponse.json({ error: "Armada API is not configured." }, { status: 503 });
  const relative = path.join("/");
  const isPublic = PUBLIC_POST_PATHS.has(relative);
  if (!isPublic && !PRIVATE_POST_PATHS.has(relative))
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  const authorization = request.headers.get("authorization");
  if (!isPublic && !authorization) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Request too large." }, { status: 413 });
  let response: Response;
  try {
    response = await fetchImpl(new URL(`${CONTROL_PREFIX}${relative}`, upstream), {
      method: "POST",
      headers: {
        ...(authorization ? { authorization } : {}),
        "content-type": request.headers.get("content-type") ?? "application/json",
        accept: "application/json",
      },
      ...(body ? { body } : {}),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(
        ["golden/create", "golden/update", "golden/build/status"].includes(relative) ? 15_000 : 660_000,
      ),
    });
  } catch {
    return NextResponse.json({ error: "Armada API is unavailable." }, { status: 502 });
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
