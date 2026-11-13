/**
 * The providers the dashboard offers when someone adds a model connection (#1483). Choosing one fixes which
 * credential kind is saved, so which agent can use it is shown, never asked. Known models and their public prices
 * come from the reviewed models.dev snapshot in `pricing/connection-catalog.json`; nothing is fetched at runtime.
 * Browser-safe: no Node builtins.
 */
import { parseCredentialValue } from "./credentials.ts";
import type { ModelPriceOverrides } from "./model-price-overrides.ts";
import { CONNECTION_MODEL_ID, MAX_CONNECTION_MODELS } from "./opencode-endpoint.ts";
import catalog from "./pricing/connection-catalog.json";
import { validRate } from "./pricing/rates.ts";
import { VaultError } from "./vault-error.ts";

export type ConnectionPresetId =
  | "openai"
  | "anthropic"
  | "opencode"
  | "deepseek"
  | "azure-foundry"
  | "openrouter"
  | "openai-compatible";

type CatalogProvider = keyof typeof catalog.providers;

export interface ConnectionPreset {
  id: ConnectionPresetId;
  label: string;
  /** The credential kind this preset saves; it decides which agent can use the connection. */
  kind: "openai" | "anthropic" | "opencode";
  /** One line under the label. */
  hint: string;
  /**
   * `harness`: a plain vendor key; the agent's own model list applies and no address is asked.
   * `choose`: a custom endpoint whose models the person ticks or types.
   */
  models: "harness" | "choose";
  /** Fixed provider address, pre-filled; null when the person must give their own (Azure, other). */
  baseUrl: string | null;
  addressPlaceholder?: string;
  addressHint?: string;
  /** Azure's optional api-version query parameter. */
  apiVersion?: boolean;
  /** The models.dev provider whose agent-capable models are offered. */
  catalog?: CatalogProvider;
  /** Where the key is created. */
  keyHint: string;
}

export const CONNECTION_PRESETS: readonly ConnectionPreset[] = [
  {
    id: "openai",
    label: "OpenAI API key",
    kind: "openai",
    hint: "OpenAI, billed per token",
    models: "harness",
    baseUrl: null,
    keyHint: "From platform.openai.com. Billed per token.",
  },
  {
    id: "anthropic",
    label: "Anthropic API key",
    kind: "anthropic",
    hint: "Anthropic, billed per token",
    models: "harness",
    baseUrl: null,
    keyHint: "From console.anthropic.com. Billed per token.",
  },
  {
    id: "opencode",
    label: "OpenCode plan key",
    kind: "opencode",
    hint: "Models of your OpenCode plan",
    models: "harness",
    baseUrl: null,
    keyHint: "From opencode.ai. Uses the models of your OpenCode plan.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "opencode",
    hint: "DeepSeek API, billed per token",
    models: "choose",
    baseUrl: "https://api.deepseek.com",
    catalog: "deepseek",
    keyHint: "From platform.deepseek.com.",
  },
  {
    id: "azure-foundry",
    label: "Azure AI Foundry",
    kind: "openai",
    hint: "Your Foundry resource, Responses API",
    models: "choose",
    baseUrl: null,
    addressPlaceholder: "https://<resource>.services.ai.azure.com/openai/v1",
    addressHint:
      "Your resource's OpenAI v1 address. A pasted URL ending in /responses is accepted. Model names are your deployment names.",
    apiVersion: true,
    catalog: "azure",
    keyHint: "From your Foundry resource's Keys and Endpoint page.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "opencode",
    hint: "Many vendors through one key",
    models: "choose",
    baseUrl: "https://openrouter.ai/api/v1",
    catalog: "openrouter",
    keyHint: "From openrouter.ai/keys.",
  },
  {
    id: "openai-compatible",
    label: "Other OpenAI-compatible",
    kind: "opencode",
    hint: "Any chat-completions endpoint",
    models: "choose",
    baseUrl: null,
    addressPlaceholder: "https://api.example.com/v1",
    addressHint: "The base URL before /chat/completions. HTTPS only.",
    keyHint: "From your provider.",
  },
];

export function connectionPreset(id: unknown): ConnectionPreset | null {
  return CONNECTION_PRESETS.find((preset) => preset.id === id) ?? null;
}

export interface CatalogModel {
  id: string;
  name: string;
  /** USD per million tokens; null is unknown, not free. */
  input: string | null;
  output: string | null;
  cacheRead: string | null;
}

/** The known agent-capable models of a preset, newest first; empty when it has no catalog. */
export function presetModels(preset: ConnectionPreset): readonly CatalogModel[] {
  return preset.catalog ? (catalog.providers[preset.catalog] as CatalogModel[]) : [];
}

export const CONNECTION_CATALOG_FETCHED_AT: string = catalog.fetchedAt;

/** The catalog's public prices for the chosen models; a model without both input and output prices is left out. */
export function presetPrices(preset: ConnectionPreset, models: readonly string[]): ModelPriceOverrides | undefined {
  const known = new Map(presetModels(preset).map((model) => [model.id, model]));
  const entries = models.flatMap((id) => {
    const model = known.get(id);
    if (!model || !validRate(model.input) || !validRate(model.output)) return [];
    const cacheRead = validRate(model.cacheRead) ? model.cacheRead : null;
    return [[id, { input: model.input, output: model.output, cacheRead, cacheWrite: null, reasoning: null }] as const];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Ticked and typed model IDs, trimmed and deduplicated in order; typed ones may be separated by commas or lines. */
export function connectionModelList(ticked: readonly string[], typed: string): string[] {
  const all = [...ticked, ...typed.split(/[\s,]+/)].map((id) => id.trim()).filter(Boolean);
  return [...new Set(all)];
}

export interface PresetConnectionInput {
  baseUrl: string;
  apiKey: string;
  models: readonly string[];
  apiVersion?: string;
}

/**
 * The sealed value a `choose` preset saves, checked by the server's own credential parser. The address and models
 * come from the person; prices only from the reviewed catalog, never from the browser. Errors never repeat the key.
 */
export function presetConnectionValue(preset: ConnectionPreset, input: PresetConnectionInput): string {
  if (preset.models !== "choose") throw new VaultError("invalid", `${preset.label} does not take an address.`);
  const apiKey = input.apiKey.trim();
  if (!apiKey || apiKey.startsWith("{")) throw new VaultError("invalid", "Paste the API key.");
  const models = [...new Set(input.models.map((id) => id.trim()).filter(Boolean))];
  if (models.length === 0) throw new VaultError("invalid", "Choose at least one model.");
  if (models.length > MAX_CONNECTION_MODELS)
    throw new VaultError("invalid", `Choose at most ${MAX_CONNECTION_MODELS} models.`);
  const bad = models.find((id) => !CONNECTION_MODEL_ID.test(id));
  if (bad !== undefined)
    throw new VaultError("invalid", "A model ID uses letters, digits and . _ : / - only, up to 193 characters.");
  const baseUrl = (preset.baseUrl ?? input.baseUrl).trim();
  const apiVersion = input.apiVersion?.trim() ?? "";
  if (apiVersion && !preset.apiVersion) throw new VaultError("invalid", `${preset.label} takes no API version.`);
  const prices = presetPrices(preset, models);
  const endpoint =
    preset.kind === "openai"
      ? { version: 1, baseUrl, ...(apiVersion ? { apiVersion } : {}) }
      : { version: 1, baseUrl, models };
  const value = {
    endpoint,
    apiKey,
    ...(preset.kind === "openai" ? { models } : {}),
    ...(prices ? { prices } : {}),
  };
  try {
    return parseCredentialValue(preset.kind, JSON.stringify(value));
  } catch {
    throw new VaultError(
      "invalid",
      "Enter an HTTPS address without credentials, query string or fragment, and paste the key without spaces.",
    );
  }
}
