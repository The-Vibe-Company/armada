// The password gate inside server code: a second check behind proxy.ts, so a
// page, route or server action that reads fleet data refuses a viewer without
// a session even if a matcher change ever left it outside the proxy.
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { gateOf, LOGIN_PATH, PASSWORD_VARIABLE, SESSION_COOKIE, validSession } from "./auth";

/** Call first in every server action and data read. Redirects to the login page without a valid session. */
export async function requireSession(): Promise<void> {
  const gate = gateOf(process.env);
  if (gate.kind === "off") return;
  if (gate.kind === "unconfigured")
    throw new Error(`${PASSWORD_VARIABLE} is not configured: the dashboard serves no data`);
  if (!validSession((await cookies()).get(SESSION_COOKIE)?.value, gate.password, Date.now())) redirect(LOGIN_PATH);
}

/** Whether a viewer signs in at all (false with the local-development opt-out). */
export function passwordRequired(): boolean {
  return gateOf(process.env).kind === "password";
}
