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
/** Vault-backed control routes (templates, routines, variables, secrets, skill defaults) accept at most this. */
export const VAULT_CONTROL_BODY_MAX_BYTES = 64 * 1024;
/** The effective body limit of a published integration route, through both public boundaries. */
export function controlBodyMaxBytes(route: string): number {
  return route.startsWith("templates/") ? VAULT_CONTROL_BODY_MAX_BYTES : CONTROL_BODY_MAX_BYTES;
}
