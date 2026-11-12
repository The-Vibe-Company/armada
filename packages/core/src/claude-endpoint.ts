/** Stable, non-secret runtime configuration for an Anthropic Messages gateway. */
export interface ClaudeEndpoint {
  version: 1;
  baseUrl: string;
  auth: "api-key" | "bearer";
}
export const CLAUDE_ENDPOINT_ENV = "ARMADA_CLAUDE_ENDPOINT";

export function parseClaudeEndpoint(value: unknown): ClaudeEndpoint {
  const fail = (): never => {
    throw new Error("Invalid Claude gateway: use an HTTPS base URL and api-key or bearer authentication.");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    typeof row.baseUrl !== "string" ||
    row.baseUrl.length > 4096 ||
    (row.auth !== "api-key" && row.auth !== "bearer") ||
    Object.keys(row).some((key) => !["version", "baseUrl", "auth"].includes(key))
  )
    return fail();
  let url: URL;
  try {
    url = new URL(row.baseUrl);
  } catch {
    return fail();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return fail();
  return { version: 1, baseUrl: url.toString().replace(/\/+$/, ""), auth: row.auth as ClaudeEndpoint["auth"] };
}
