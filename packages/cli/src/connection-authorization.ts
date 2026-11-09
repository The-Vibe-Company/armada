import { AuthError } from "@armada/auth";
import type { AuthIo } from "./auth-commands.ts";
import { control } from "./control.ts";

export interface ConnectionStatus {
  connection: {
    id: string;
    name?: string;
    orgId?: string;
    scope?: "personal" | "org";
    transport?: "http" | "sse" | "stdio";
    authType?: "auto" | "none" | "bearer" | "headers" | "oauth";
    accountLabel?: string;
    toolCount?: number;
    resourceCount?: number;
    promptCount?: number;
    status: "connected" | "not_connected" | "needs_reconnect" | "unavailable" | "disabled";
    lastError?: string;
  };
  authorizationUrl?: string;
}

/** Only backend-issued HTTPS authorizations are handed to a browser; never a CLI-supplied issuer. */
export function authorizationUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || /[\r\n\0]/.test(value))
      throw new Error();
    return url.href;
  } catch {
    throw new AuthError("The server returned an unsafe authorization URL.", "unavailable");
  }
}

/** One browser handoff, then authoritative connection state; a URL alone never means connected. */
export async function authorizeConnection(
  auth: AuthIo,
  initial: ConnectionStatus,
  body: { org: string; id: string },
  options: { noBrowser: boolean; timeoutSeconds: number },
): Promise<ConnectionStatus> {
  validateConnectionStatus(initial);
  if (initial.authorizationUrl) {
    const url = authorizationUrl(initial.authorizationUrl);
    if (options.noBrowser) auth.err(`Complete authorization in your browser: ${url}\n`);
    else auth.open(url);
  }
  const deadline = auth.now().getTime() + options.timeoutSeconds * 1000;
  for (;;) {
    const result = await control<ConnectionStatus>(auth, "mcp/status", body);
    validateConnectionStatus(result);
    if (result.connection.id !== body.id) throw new AuthError("The server returned another connection.", "unavailable");
    if (result.connection.status === "connected") return result;
    if (
      result.connection.status === "unavailable" ||
      result.connection.status === "disabled" ||
      !initial.authorizationUrl
    ) {
      throw new AuthError("Connection is not available; reconnect it or check its server-side status.", "unavailable");
    }
    const remaining = deadline - auth.now().getTime();
    if (remaining <= 0)
      throw new AuthError(
        "Authorization timed out. Check armada mcp status; no connection was assumed.",
        "unavailable",
      );
    await (auth.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(Math.min(1000, remaining));
  }
}

export function validateConnectionStatus(value: ConnectionStatus): void {
  const statuses = ["connected", "not_connected", "needs_reconnect", "unavailable", "disabled"];
  if (
    !value ||
    !value.connection ||
    typeof value.connection.id !== "string" ||
    !statuses.includes(value.connection.status) ||
    (value.authorizationUrl !== undefined && typeof value.authorizationUrl !== "string")
  )
    throw new AuthError("The server returned an invalid connection status.", "unavailable");
}
