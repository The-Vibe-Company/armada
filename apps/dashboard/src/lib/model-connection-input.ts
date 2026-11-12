import { parseCodexEndpoint, parseCredentialValue } from "@armada/core";
import type { AccountKind } from "./model-accounts";

/** Compose only on the server: never copy a key into hidden fields or client state. */
export function customCodexAccountValue(
  kind: AccountKind,
  data: FormData,
): { ok: true; value: string } | { ok: false; error: string } {
  if (kind !== "openai") return { ok: false, error: "Custom endpoint fields currently support Codex only." };
  try {
    const baseUrl = data.get("baseUrl");
    const rawVersion = data.get("apiVersion");
    if (typeof baseUrl !== "string" || (rawVersion !== null && typeof rawVersion !== "string")) throw Error();
    const apiVersion = typeof rawVersion === "string" ? rawVersion.trim() : "";
    const endpoint = parseCodexEndpoint({ version: 1, baseUrl: baseUrl.trim(), ...(apiVersion ? { apiVersion } : {}) });
    const key = data.get("value");
    if (typeof key !== "string" || key.trim().startsWith("{")) throw Error();
    return { ok: true, value: parseCredentialValue("openai", JSON.stringify({ endpoint, apiKey: key.trim() })) };
  } catch {
    return {
      ok: false,
      error:
        "Enter an HTTPS Responses base URL and an API key. URL credentials, query strings and fragments are not supported.",
    };
  }
}
