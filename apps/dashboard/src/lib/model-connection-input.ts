import { parseClaudeEndpoint, parseCodexEndpoint, parseCredentialValue } from "@armada/core";
import type { AccountKind } from "./model-accounts";

/** Compose only on the server: never copy a key into hidden fields or client state. */
export function customAccountValue(
  kind: AccountKind,
  data: FormData,
): { ok: true; value: string } | { ok: false; error: string } {
  if (kind !== "openai" && kind !== "anthropic")
    return { ok: false, error: "Choose an API-key account for a custom endpoint." };
  try {
    const baseUrl = data.get("baseUrl");
    const rawVersion = data.get("apiVersion");
    if (typeof baseUrl !== "string" || (rawVersion !== null && typeof rawVersion !== "string")) throw Error();
    const apiVersion = typeof rawVersion === "string" ? rawVersion.trim() : "";
    if (kind === "anthropic" && apiVersion) throw Error();
    const endpoint =
      kind === "openai"
        ? parseCodexEndpoint({ version: 1, baseUrl: baseUrl.trim(), ...(apiVersion ? { apiVersion } : {}) })
        : parseClaudeEndpoint({ version: 1, baseUrl: baseUrl.trim(), auth: data.get("endpointAuth") });
    const key = data.get("value");
    if (typeof key !== "string" || key.trim().startsWith("{")) throw Error();
    return { ok: true, value: parseCredentialValue(kind, JSON.stringify({ endpoint, apiKey: key.trim() })) };
  } catch {
    return {
      ok: false,
      error:
        kind === "openai"
          ? "Enter an HTTPS Responses base URL and an API key. URL credentials, query strings and fragments are not supported."
          : "Enter an HTTPS Claude gateway base URL, choose bearer or API-key authentication, and paste the key. URL credentials, query strings and fragments are not supported.",
    };
  }
}
