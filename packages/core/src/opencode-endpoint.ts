/** Private OpenCode OpenAI-compatible connection configuration; credentials are sealed separately from this DTO. */
export interface OpenCodeEndpoint {
  version: 1;
  baseUrl: string;
  models: string[];
}
export const OPENCODE_ENDPOINT_ENV = "ARMADA_OPENCODE_ENDPOINT";
export function parseOpenCodeEndpoint(value: unknown): OpenCodeEndpoint {
  const fail = (): never => {
    throw new Error("Invalid OpenCode endpoint: HTTPS baseUrl and 1-32 model IDs required.");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    typeof row.baseUrl !== "string" ||
    row.baseUrl.length > 4096 ||
    Object.keys(row).some((key) => !["version", "baseUrl", "models"].includes(key))
  )
    return fail();
  let url: URL;
  try {
    url = new URL(row.baseUrl);
  } catch {
    return fail();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) return fail();
  if (
    !Array.isArray(row.models) ||
    row.models.length < 1 ||
    row.models.length > 32 ||
    row.models.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,192}$/.test(id))
  )
    return fail();
  return { version: 1, baseUrl: url.toString().replace(/\/+$/, ""), models: [...new Set(row.models as string[])] };
}
