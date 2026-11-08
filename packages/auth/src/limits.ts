/** Access tokens expire an hour after `created_at`. Refresh tokens expire after 30 days. */
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
export const LOGIN_TTL_MS = 10 * 60 * 1000;

/** The only scope the authorization server grants. */
export const OAUTH_SCOPE = "armada";

/** MCP resource path #464 serves. The resource indicator is the public origin plus this path. */
export const MCP_PATH = "/mcp";

/** `ARMADA_PUBLIC_URL` is an origin. Local http is allowed so a test can stand in for the server. */
export function assertPublicUrl(publicUrl: string): string {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new Error("ARMADA_PUBLIC_URL must be an origin.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const allowed = url.protocol === "https:" || (url.protocol === "http:" && local);
  if (!allowed || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("ARMADA_PUBLIC_URL must be an origin.");
  }
  return url.origin;
}

export function resourceUrl(publicUrl: string): string {
  return `${assertPublicUrl(publicUrl)}${MCP_PATH}`;
}
