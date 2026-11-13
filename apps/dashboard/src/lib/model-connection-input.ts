import {
  connectionModelList,
  connectionPreset,
  parseClaudeEndpoint,
  parseCodexEndpoint,
  parseCredentialValue,
  parseModelPriceOverrides,
  presetConnectionValue,
  VaultError,
} from "@armada/core";
import type { AccountKind } from "./model-accounts";

/** Blank pricing is absent; decimal strings retain the server pricing contract's precision. */
function formModelPrices(data: FormData) {
  const fields = ["priceModel", "priceInput", "priceCachedInput", "priceOutput"].map((name) => {
    const raw = data.get(name);
    if (raw !== null && typeof raw !== "string") throw Error();
    return typeof raw === "string" ? raw.trim() : "";
  });
  if (fields.every((value) => value === "")) return undefined;
  const [model, input, cacheRead, output] = fields;
  return parseModelPriceOverrides({ [model ?? ""]: { input, output, ...(cacheRead ? { cacheRead } : {}) } });
}

/** Compose only on the server: never copy a key into hidden fields or client state. */
export function customAccountValue(
  kind: AccountKind,
  data: FormData,
): { ok: true; value: string } | { ok: false; error: string } {
  if (kind !== "openai" && kind !== "anthropic")
    return { ok: false, error: "Choose an API-key account for a custom endpoint." };
  let prices: ReturnType<typeof formModelPrices>;
  try {
    prices = formModelPrices(data);
  } catch {
    return {
      ok: false,
      error:
        "Enter an exact model ID and non-negative decimal input/output prices in USD per million tokens. Cached input is optional.",
    };
  }
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
    return {
      ok: true,
      value: parseCredentialValue(
        kind,
        JSON.stringify({ endpoint, apiKey: key.trim(), ...(prices ? { prices } : {}) }),
      ),
    };
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

/** Replacement cannot infer a sealed account's route: require an explicit destination choice. */
export function replacementCodexAccountValue(
  data: FormData,
): { ok: true; value: string } | { ok: false; error: string } {
  const mode = data.get("connectionMode");
  if (mode === "custom") return customAccountValue("openai", data);
  if (mode !== "openai") return { ok: false, error: "Choose the replacement connection type." };
  const raw = data.get("value");
  if (typeof raw !== "string" || raw.trim().startsWith("{"))
    return { ok: false, error: "Paste only the API key for the OpenAI default endpoint." };
  try {
    return { ok: true, value: parseCredentialValue("openai", raw) };
  } catch {
    return { ok: false, error: "Paste a valid OpenAI API key." };
  }
}

/** A sealed Claude gateway cannot be inferred on rotation; the destination is explicit. */
export function replacementClaudeAccountValue(
  data: FormData,
): { ok: true; value: string } | { ok: false; error: string } {
  const mode = data.get("connectionMode");
  if (mode !== "anthropic" && mode !== "custom") return { ok: false, error: "Choose the replacement connection type." };
  const raw = data.get("value");
  if (typeof raw !== "string" || raw.trim().startsWith("{"))
    return { ok: false, error: "Paste only the new key, not connection JSON." };
  if (mode === "custom") return customAccountValue("anthropic", data);
  try {
    return { ok: true, value: parseCredentialValue("anthropic", raw) };
  } catch {
    return { ok: false, error: "Paste a valid Anthropic API key." };
  }
}

/**
 * A provider-preset connection (#1483): address, key and ticked or typed models from the form, prices only from the
 * catalog. Composed on the server; the key never enters client state.
 */
export function presetAccountValue(
  data: FormData,
): { ok: true; kind: AccountKind; value: string } | { ok: false; error: string } {
  const preset = connectionPreset(data.get("preset"));
  if (preset?.models !== "choose") return { ok: false, error: "Choose a provider." };
  const field = (name: string) => {
    const raw = data.get(name);
    return typeof raw === "string" ? raw : "";
  };
  const ticked = data.getAll("model").filter((value): value is string => typeof value === "string");
  try {
    return {
      ok: true,
      kind: preset.kind,
      value: presetConnectionValue(preset, {
        baseUrl: field("baseUrl"),
        apiKey: field("value"),
        models: connectionModelList(ticked, field("customModels")),
        ...(preset.apiVersion ? { apiVersion: field("apiVersion") } : {}),
      }),
    };
  } catch (error) {
    if (error instanceof VaultError) return { ok: false, error: error.message };
    throw error;
  }
}

/** A sealed OpenCode connection's address and models are not returned: a plain key needs an explicit plan choice. */
export function replacementOpenCodeAccountValue(
  data: FormData,
): { ok: true; value: string } | { ok: false; error: string } {
  if (data.get("connectionMode") !== "opencode") return { ok: false, error: "Choose the replacement connection type." };
  const raw = data.get("value");
  if (typeof raw !== "string" || raw.trim().startsWith("{"))
    return { ok: false, error: "Paste only the OpenCode plan key." };
  try {
    return { ok: true, value: parseCredentialValue("opencode", raw) };
  } catch (error) {
    if (error instanceof VaultError) return { ok: false, error: error.message };
    throw error;
  }
}
