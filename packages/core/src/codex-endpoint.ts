/** Versioned runtime configuration; the API key is delivered separately in the private harness environment. */
export interface CodexEndpoint {
  version: 1;
  baseUrl: string;
  apiVersion?: string;
}
export const CODEX_ENDPOINT_ENV = "ARMADA_CODEX_ENDPOINT";

/** Accept a pasted Responses URL without losing Azure's project-scoped path. */
export function parseCodexEndpoint(value: unknown): CodexEndpoint {
  const fail = (): never => {
    throw new Error("Invalid Codex endpoint: use an HTTPS Responses-compatible base URL and optional apiVersion.");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    typeof row.baseUrl !== "string" ||
    Object.keys(row).some((key) => !["version", "baseUrl", "apiVersion"].includes(key))
  )
    return fail();
  let url: URL;
  try {
    url = new URL(row.baseUrl);
  } catch {
    return fail();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return fail();
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/responses$/, "");
  if (
    row.apiVersion !== undefined &&
    (typeof row.apiVersion !== "string" || !/^[A-Za-z0-9.-]{1,80}$/.test(row.apiVersion))
  )
    return fail();
  return {
    version: 1,
    baseUrl: url.toString().replace(/\/$/, ""),
    ...(row.apiVersion ? { apiVersion: row.apiVersion as string } : {}),
  };
}
