// The gate in front of the whole dashboard (Next.js "proxy", formerly
// middleware). Every page, route and server action goes through it; only the
// build's static files, the icons and the web manifest do not, since they carry
// no fleet data (the sign-in pages show the icon too).
// Once the accounts variables are set, it checks the Better Auth session in
// full (signed cookie cache, then the accounts database), not just the
// cookie's presence. With none of them set, the shared-password gate (THE-834)
// applies, unchanged; with some but not all, or with neither gate, the
// dashboard fails closed.
import type { NextRequest } from "next/server";
import { accountsGuard, incompleteAccounts, type SessionState } from "@/lib/accounts-http";
import { accounts } from "@/lib/accounts-server";
import { accountsModeOf } from "@/lib/accounts-settings";
import { guard } from "@/lib/auth-http";

async function session(request: NextRequest): Promise<SessionState> {
  try {
    const a = await accounts();
    if (!a) return "unavailable";
    // No refresh here: cookies the proxy would set are lost.
    const found = await a.auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } });
    return found ? "signed-in" : "none";
  } catch (err) {
    // The detail stays in the server log (the database host, never its token).
    console.error(`armada dashboard: sign-in unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return "unavailable";
  }
}

export function proxy(request: NextRequest) {
  const mode = accountsModeOf(process.env);
  if (mode.kind === "accounts") return accountsGuard(request, { env: process.env, session });
  if (mode.kind === "incomplete") return incompleteAccounts(request, { env: process.env, missing: mode.missing });
  return guard(request, { env: process.env, now: Date.now() });
}

export const config = {
  // _next/webpack-hmr is the development-only hot reload socket.
  matcher: [
    "/((?!_next/static/|_next/webpack-hmr|icon\\.svg$|icon\\.png$|apple-icon\\.png$|icon-192\\.png$|icon-512\\.png$|manifest\\.webmanifest$|favicon\\.ico$).*)",
  ],
};
