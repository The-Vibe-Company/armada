import { accountsModeOf } from "@/lib/accounts-settings";
import { FailureLimiter } from "@/lib/auth";
import { login } from "@/lib/auth-http";

export const dynamic = "force-dynamic";

// One limiter per server process, kept across hot reloads in development.
const holder = globalThis as unknown as { __armadaLoginLimiter?: FailureLimiter };

/** The login form's target: sets the session cookie on the right password. */
export async function POST(request: Request) {
  // Accounts replace the shared password once configured: its routes are gone then.
  if (accountsModeOf(process.env).kind === "accounts") return Response.json({ error: "not found" }, { status: 404 });
  holder.__armadaLoginLimiter ??= new FailureLimiter();
  return login(request, { env: process.env, now: Date.now(), limiter: holder.__armadaLoginLimiter });
}
