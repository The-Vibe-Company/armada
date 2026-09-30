// Better Auth's routes: GitHub sign-in and its callback, email verification,
// sign-out, sessions and organizations. While accounts are not configured the
// shared-password gate applies and these routes do not exist (404); its own
// /api/auth/login and /api/auth/logout routes take precedence over this one.
import { accounts } from "@/lib/accounts-server";

export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  const a = await accounts();
  if (!a) return Response.json({ error: "not found" }, { status: 404 });
  return a.auth.handler(request);
}

export { handle as GET, handle as POST };
