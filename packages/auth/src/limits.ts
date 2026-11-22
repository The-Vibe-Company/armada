export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
export const LOGIN_TTL_MS = 10 * 60 * 1000;

export const OAUTH_SCOPE = "armada";

export const MCP_PATH = "/mcp";

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
