import { logout } from "@/lib/auth-http";

export const dynamic = "force-dynamic";

/** Clears the session cookie and returns to the login page. */
export function POST(request: Request) {
  return logout(request, { env: process.env });
}
