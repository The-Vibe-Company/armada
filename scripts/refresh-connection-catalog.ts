/**
 * Explicit maintenance command; never used at server startup. Snapshots the models.dev entries the dashboard's
 * connection presets offer (agent-capable text models with tool calls), with their public prices. Review the diff.
 */
import { createHash } from "node:crypto";
import { validRate } from "../packages/core/src/pricing/rates.ts";

const source = "https://models.dev/api.json";
const PROVIDERS = ["deepseek", "openrouter", "azure"] as const;
interface CatalogEntry {
  id?: unknown;
  name?: unknown;
  tool_call?: unknown;
  status?: unknown;
  release_date?: unknown;
  modalities?: { output?: unknown };
  cost?: { input?: unknown; output?: unknown; cache_read?: unknown };
}
const response = await fetch(source);
if (!response.ok) throw new Error(`models.dev: HTTP ${response.status}`);
const raw = await response.text();
const data = JSON.parse(raw);
const rate = (value: unknown): string | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const text = String(value);
  return validRate(text) ? text : null;
};
const providers: Record<
  string,
  { id: string; name: string; input: string | null; output: string | null; cacheRead: string | null }[]
> = {};
for (const provider of PROVIDERS) {
  const entry = data[provider];
  if (entry?.id !== provider || typeof entry.models !== "object" || !entry.models)
    throw new Error(`Invalid provider: ${provider}`);
  providers[provider] = Object.values(entry.models as Record<string, CatalogEntry>)
    .filter(
      (model) =>
        typeof model.id === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,192}$/.test(model.id) &&
        model.tool_call === true &&
        model.status !== "deprecated" &&
        Array.isArray(model.modalities?.output) &&
        model.modalities.output.includes("text"),
    )
    .sort(
      (a, b) =>
        String(b.release_date ?? "").localeCompare(String(a.release_date ?? "")) ||
        String(a.id).localeCompare(String(b.id)),
    )
    .map((model) => ({
      id: model.id as string,
      name: (typeof model.name === "string" && model.name.trim().slice(0, 120)) || (model.id as string),
      input: rate(model.cost?.input),
      output: rate(model.cost?.output),
      cacheRead: rate(model.cost?.cache_read),
    }));
}
await Bun.write(
  new URL("../packages/core/src/pricing/connection-catalog.json", import.meta.url),
  `${JSON.stringify(
    {
      source,
      fetchedAt: new Date().toISOString(),
      sha256: createHash("sha256").update(raw).digest("hex"),
      license: "MIT",
      units: "USD per million tokens",
      providers,
    },
    null,
    2,
  )}\n`,
);
