import { FailureLimiter } from "@/lib/auth";
import { login } from "@/lib/auth-http";

export const dynamic = "force-dynamic";

// One limiter per server process, kept across hot reloads in development.
const holder = globalThis as unknown as { __armadaLoginLimiter?: FailureLimiter };

/** The login form's target: sets the session cookie on the right password. */
export async function POST(request: Request) {
  holder.__armadaLoginLimiter ??= new FailureLimiter();
  return login(request, { env: process.env, now: Date.now(), limiter: holder.__armadaLoginLimiter });
}
