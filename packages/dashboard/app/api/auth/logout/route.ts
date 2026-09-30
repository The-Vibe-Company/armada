import { accountsModeOf } from "@/lib/accounts-settings";
import { logout } from "@/lib/auth-http";

export const dynamic = "force-dynamic";

/** Clears the session cookie and returns to the login page. */
export function POST(request: Request) {
  if (accountsModeOf(process.env).kind !== "off") return Response.json({ error: "not found" }, { status: 404 });
  return logout(request, { env: process.env });
}
