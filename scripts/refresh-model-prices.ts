/** Explicit maintenance command. Review the emitted diff before shipping. */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { CatalogModel } from "../packages/core/src/connection-presets.ts";
import type { HarnessModels } from "../packages/core/src/models.ts";
import { CONNECTION_MODEL_ID } from "../packages/core/src/opencode-endpoint.ts";
import { type TokenRates, validRate } from "../packages/core/src/pricing/rates.ts";

const source = "https://models.dev/api.json";
const connectionProviders = ["deepseek", "openrouter", "azure"] as const;

interface UpstreamModel {
  id: string;
  name?: string;
  tool_call?: boolean;
  status?: string;
  release_date?: string;
  type?: string;
  modalities?: { output?: string[] };
  experimental?: { modes?: object };
  cost?: Record<string, unknown>;
}

interface Snapshot {
  source: string;
  fetchedAt: string;
  sha256: string;
  license: string;
  units: string;
  models: Record<string, { rates: TokenRates; unsupported: boolean }>;
  providers: Record<(typeof connectionProviders)[number], CatalogModel[]>;
}

interface Overlay {
  harnesses: Record<string, HarnessModels>;
  compatibleProviders: Record<string, { models: string[]; claude: { aliases: Record<string, string> } }>;
  vendorLimitHints: Record<string, { context?: number; output?: number }>;
}

function providerModels(data: Record<string, { id: string; models: Record<string, UpstreamModel> }>, provider: string) {
  const entry = data[provider];
  if (entry?.id !== provider || typeof entry.models !== "object" || !entry.models || Array.isArray(entry.models))
    throw new Error(`Invalid provider: ${provider}`);
  for (const [id, model] of Object.entries(entry.models)) {
    if (model?.id !== id) throw new Error(`Mismatched model ID: ${provider}/${id}`);
  }
  return entry.models;
}

function rate(value: unknown): string | null {
  return typeof value === "number" && validRate(String(value)) ? String(value) : null;
}

function pricingRate(value: unknown): string | null {
  if (value == null) return null;
  const normalized = rate(value);
  if (normalized === null) throw new Error("Invalid models.dev rate");
  return normalized;
}

function pricingModels(data: Parameters<typeof providerModels>[0]): Snapshot["models"] {
  const models: Snapshot["models"] = {};
  for (const provider of ["anthropic", "openai"]) {
    const entries = providerModels(data, provider);
    for (const id of Object.keys(entries).sort()) {
      const model = entries[id]!;
      if (!model.cost) continue;
      const cost = model.cost;
      if (typeof cost !== "object" || Array.isArray(cost)) throw new Error("Invalid models.dev cost");
      const output = model.modalities?.output;
      models[`${provider}/${id}`] = {
        rates: {
          input: pricingRate(cost.input),
          output: pricingRate(cost.output),
          cacheRead: pricingRate(cost.cache_read),
          cacheWrite: pricingRate(cost.cache_write),
          reasoning: pricingRate(cost.reasoning),
        },
        // Preserve catalogue complexity as provenance without vetoing rate-backed token classes.
        unsupported:
          Object.keys(model.experimental?.modes ?? {}).length > 0 ||
          (model.type !== undefined && model.type !== "text") ||
          !Array.isArray(output) ||
          output.length !== 1 ||
          output[0] !== "text" ||
          Object.keys(cost).some((key) => !["input", "output", "cache_read", "cache_write", "reasoning"].includes(key)),
      };
    }
  }
  return models;
}

function connectionModels(data: Parameters<typeof providerModels>[0], provider: (typeof connectionProviders)[number]) {
  return Object.values(providerModels(data, provider))
    .filter(
      (model) =>
        CONNECTION_MODEL_ID.test(model.id) &&
        model.tool_call === true &&
        // Foundry's v1 Responses connection uses OpenAI models.
        (provider !== "azure" || /^(gpt-|o\d)|codex/.test(model.id)) &&
        model.status !== "deprecated" &&
        Array.isArray(model.modalities?.output) &&
        model.modalities.output.includes("text"),
    )
    .sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? "", "en") || a.id.localeCompare(b.id, "en"))
    .map((model) => ({
      id: model.id,
      name: (typeof model.name === "string" && model.name.trim().slice(0, 120)) || model.id,
      input: rate(model.cost?.input),
      output: rate(model.cost?.output),
      cacheRead: rate(model.cost?.cache_read),
    }));
}

export function snapshotModels(raw: string, fetchedAt: string): Snapshot {
  const data = JSON.parse(raw);
  return {
    source,
    fetchedAt,
    sha256: createHash("sha256").update(raw).digest("hex"),
    license: "MIT",
    units: "USD per million tokens",
    models: pricingModels(data),
    providers: {
      deepseek: connectionModels(data, "deepseek"),
      openrouter: connectionModels(data, "openrouter"),
      azure: connectionModels(data, "azure"),
    },
  };
}

export function buildModelCatalog(snapshot: Snapshot, overlay: Overlay) {
  for (const [id, harness] of Object.entries(overlay.harnesses)) {
    const model = harness.models.find((model) => model.id === harness.defaultModel);
    if (!model?.reasoningEfforts.includes(harness.defaultReasoningEffort))
      throw new Error(`Invalid default model or effort for ${id}`);
  }
  for (const [id, provider] of Object.entries(overlay.compatibleProviders)) {
    if (Object.values(provider.claude.aliases).some((model) => !provider.models.includes(model)))
      throw new Error(`Unknown model in ${id} aliases`);
  }
  return { snapshot, ...overlay };
}

function projections(catalog: ReturnType<typeof buildModelCatalog>) {
  const { models, providers, ...provenance } = catalog.snapshot;
  return {
    pricing: { ...provenance, models },
    connections: { ...provenance, providers },
    options: [
      "// Generated by scripts/refresh-model-prices.ts. Edit model-overlay.json instead.",
      `export const GENERATED_HARNESS_MODELS = ${JSON.stringify(catalog.harnesses, null, 2)} as const;`,
      `export const GENERATED_COMPATIBLE_MODEL_PROVIDERS = ${JSON.stringify(catalog.compatibleProviders, null, 2)} as const;`,
    ].join("\n"),
  };
}

if (import.meta.main) {
  const directory = new URL("../packages/core/src/pricing/", import.meta.url);
  const file = (name: string) => new URL(name, directory);
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--offline"))
    throw new Error("Usage: bun scripts/refresh-model-prices.ts [--offline]");
  const catalogFile = Bun.file(file("model-catalog.json"));
  const overlay = await Bun.file(file("model-overlay.json")).json();
  let snapshot: Snapshot;
  if (args[0] === "--offline") {
    ({ snapshot } = await catalogFile.json());
  } else {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`models.dev: HTTP ${response.status}`);
    snapshot = snapshotModels(await response.text(), new Date().toISOString());
  }
  const catalog = buildModelCatalog(snapshot, overlay);
  const { pricing, connections, options } = projections(catalog);
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const biome = fileURLToPath(new URL("../node_modules/.bin/biome", import.meta.url));
  const outputs = [
    ["model-catalog.json", json(catalog)],
    ["models-dev.json", json(pricing)],
    ["connection-catalog.json", json(connections)],
    ["model-options.generated.ts", options],
  ] as const;
  const formatted = outputs.map(([name, content]) => {
    const result = Bun.spawnSync([biome, "format", `--stdin-file-path=${name}`], {
      stdin: Buffer.from(content),
      stderr: "inherit",
    });
    if (!result.success) throw new Error(`Could not format ${name}`);
    return [name, result.stdout] as const;
  });
  for (const [name, content] of formatted) await Bun.write(file(name), content);
}
