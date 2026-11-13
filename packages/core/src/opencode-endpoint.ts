/** Private OpenCode provider connection configuration; credentials are sealed separately from this DTO. */
export interface OpenCodeEndpoint {
  version: 1;
  baseUrl: string;
  models: string[];
  /** Absent preserves existing OpenAI-compatible connections. */
  protocol?: "anthropic" | "azure";
}
export const OPENCODE_ENDPOINT_ENV = "ARMADA_OPENCODE_ENDPOINT";
/**
 * The provider ID the runtime gives a custom OpenCode connection; OpenCode reports its models, and so prices are
 * keyed, as `armada/<model>` (packages/agent-runtime/src/opencode-endpoint.ts).
 */
export const OPENCODE_CONNECTION_PROVIDER = "armada";
export function parseOpenCodeEndpoint(value: unknown): OpenCodeEndpoint {
  const fail = (): never => {
    throw new Error("Invalid OpenCode endpoint: HTTPS baseUrl and 1-32 model IDs required.");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    (row.protocol !== undefined && row.protocol !== "anthropic" && row.protocol !== "azure") ||
    typeof row.baseUrl !== "string" ||
    row.baseUrl.length > 4096 ||
    Object.keys(row).some((key) => !["version", "baseUrl", "models", "protocol"].includes(key))
  )
    return fail();
  let url: URL;
  try {
    url = new URL(row.baseUrl);
  } catch {
    return fail();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) return fail();
  if (row.protocol === "azure") {
    // Azure v1 only: deployment-scoped/versioned legacy URLs are a different contract.
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/responses$/, "");
    if (!url.pathname.endsWith("/openai/v1")) return fail();
  }
  if (!isConnectionModelList(row.models)) return fail();
  return {
    version: 1,
    baseUrl: url.toString().replace(/\/+$/, ""),
    models: [...new Set(row.models)],
    ...(row.protocol === "anthropic" || row.protocol === "azure" ? { protocol: row.protocol } : {}),
  };
}

/** A provider's exact model or deployment ID, as a connection declares it. */
export const CONNECTION_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,192}$/;
/** At most this many models per connection. */
export const MAX_CONNECTION_MODELS = 32;

function isConnectionModelList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_CONNECTION_MODELS &&
    value.every((id) => typeof id === "string" && CONNECTION_MODEL_ID.test(id))
  );
}

/** 1-32 exact model IDs, deduplicated in order. */
export function parseConnectionModels(value: unknown): string[] {
  if (!isConnectionModelList(value)) throw new Error("A connection lists 1-32 exact model IDs.");
  return [...new Set(value)];
}
