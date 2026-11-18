/** Public control routes shared by the server dispatcher and dashboard transport. */
export const PUBLIC_CONTROL_ROUTES = {
  "auth/methods": ["GET"],
  "auth/authorize": ["GET"],
  "auth/exchange": ["POST"],
  "auth/email/start": ["POST"],
  "auth/email/verify": ["POST"],
  "auth/refresh": ["POST"],
  "github/oauth/callback": ["GET", "POST"],
} as const;

/**
 * Largest serialized JSON request body the public control API accepts, in bytes. The
 * dashboard proxy (`/api/v1/*`) and the server dispatcher both refuse a larger body with
 * HTTP 413 before any handler runs, so it bounds every field, including a send prompt.
 */
export const CONTROL_BODY_MAX_BYTES = 128 * 1024;
/**
 * Vault-backed control routes accept at most this. The server refuses a larger body with
 * the opaque vault refusal (HTTP 400, code "invalid"), not 413.
 */
export const VAULT_CONTROL_BODY_MAX_BYTES = 64 * 1024;
/** Control routes the server reads with the strict vault body reader. */
export function vaultControlRoute(route: string): boolean {
  return (
    route === "skillpack/catalog" ||
    route === "skillpack/versions" ||
    ["skills/defaults/", "templates/", "routines/", "variables/", "secrets/"].some((prefix) => route.startsWith(prefix))
  );
}
/** The largest body a client may send to a control route through either public boundary. */
export function controlBodyMaxBytes(route: string): number {
  return vaultControlRoute(route) ? VAULT_CONTROL_BODY_MAX_BYTES : CONTROL_BODY_MAX_BYTES;
}
