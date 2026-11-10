import { type NextRequest, NextResponse } from "next/server";
import { oauthCallbackInput } from "@/lib/connections";
import { ControlError, createMcpControl } from "@/lib/control";
import { readViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { originFromHeaders } from "@/lib/routes";

export const dynamic = "force-dynamic";

/**
 * An MCP server's authorization page sends the browser back here with `state`, `code` and `iss`. The signed-in
 * person's dashboard session is read on this (the dashboard's) domain, and the answer is relayed server-side to
 * the Armada API with their bearer: `POST /api/v1/mcp/oauth/callback {state, code, issuer}`. The API matches the
 * state with the pending authorization it created, which fixes the org and connection; nothing here trusts the
 * URL for that. The browser always lands on `/tools`, which rereads the real status. The code and any
 * provider error text are never shown, logged or forwarded in a redirect.
 */
export async function GET(request: NextRequest) {
  const origin = originFromHeaders(request.headers, request.url);
  const input = oauthCallbackInput(request.nextUrl.searchParams);
  const viewer = await readViewer();
  if (!viewer?.token) {
    // Without a session the code cannot be relayed; it expires unused at the API. Nothing of it is kept.
    return land(origin, "/login", { next: "/tools" });
  }
  if (input.kind === "denied") return land(origin, "/tools", { oauth: "denied" });
  if (input.kind === "invalid") return land(origin, "/tools", { oauth: "failed" });

  const url = mcpUrl();
  if (!url) return land(origin, "/tools", { oauth: "failed" });
  const control = createMcpControl({ serverUrl: url, token: viewer.token });
  try {
    const connection = await control.oauthCallback({
      state: input.state,
      code: input.code,
      ...(input.issuer ? { issuer: input.issuer } : {}),
    });
    return land(origin, "/tools", { connection: connection.id, oauth: "returned" });
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    console.error("MCP OAuth callback was refused by the Armada API.", { status: error.status ?? null });
    return land(origin, "/tools", { oauth: "failed" });
  }
}

/** A redirect that carries no referrer (the callback URL holds the code) and is never cached. */
function land(origin: string, path: string, query: Record<string, string>) {
  const target = new URL(path, origin);
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
  const response = NextResponse.redirect(target, 303);
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}
