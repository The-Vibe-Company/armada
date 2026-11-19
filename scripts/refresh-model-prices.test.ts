import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MODEL_CATALOG } from "../packages/core/src/models.ts";
import catalog from "../packages/core/src/pricing/model-catalog.json";
import {
  CONNECTION_MODELS,
  MORPH_ENDPOINTS,
  MORPH_MODEL_IDS,
} from "../packages/core/src/pricing/model-options.generated.ts";
import overlay from "../packages/core/src/pricing/model-overlay.json";
import { buildModelCatalog, snapshotModels } from "./refresh-model-prices.ts";

test("one upstream snapshot and the reviewed overlay supply the model catalog", () => {
  const text = { tool_call: true, modalities: { output: ["text"] } };
  const raw = JSON.stringify({
    anthropic: {
      id: "anthropic",
      models: { demo: { id: "demo", ...text, cost: { input: 0, output: 2.5, cache_write: 1 } } },
    },
    openai: { id: "openai", models: {} },
    deepseek: { id: "deepseek", models: {} },
    openrouter: {
      id: "openrouter",
      models: {
        old: { id: "old", ...text, release_date: "2025-01-01", cost: { input: 0 } },
        new: { id: "new", ...text, release_date: "2025-02-01", name: " New model " },
        retired: { id: "retired", ...text, status: "deprecated" },
      },
    },
    azure: { id: "azure", models: { other: { id: "other", ...text } } },
  });
  const review = {
    harnesses: {
      demo: {
        defaultModel: "demo",
        defaultReasoningEffort: "medium",
        reasoningEfforts: ["medium"],
        models: [{ id: "demo", label: "Demo", reasoningEfforts: ["medium"] }],
      },
    },
    compatibleProviders: {},
    vendorLimitHints: { "anthropic/demo": { context: 128_000 } },
  };
  const snapshot = snapshotModels(raw, "2025-02-02T00:00:00Z");
  const result = buildModelCatalog(snapshot, review);

  expect(result.snapshot).toMatchObject({
    fetchedAt: "2025-02-02T00:00:00Z",
    sha256: createHash("sha256").update(raw).digest("hex"),
    models: {
      "anthropic/demo": {
        rates: { input: "0", output: "2.5", cacheRead: null, cacheWrite: "1", reasoning: null },
        unsupported: false,
      },
    },
  });
  expect(result.snapshot.providers.openrouter).toEqual([
    { id: "new", name: "New model", input: null, output: null, cacheRead: null },
    { id: "old", name: "old", input: "0", output: null, cacheRead: null },
  ]);
  expect(result.snapshot.providers.azure).toEqual([]);
  expect(result.harnesses.demo?.defaultModel).toBe("demo");
  expect(result.vendorLimitHints["anthropic/demo"]).toEqual({ context: 128_000 });
});

test("the vendored model catalog preserves the pre-consolidation values", () => {
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  expect(buildModelCatalog(catalog.snapshot, overlay)).toEqual(catalog);
  expect(MODEL_CATALOG).toEqual(catalog.harnesses);
  const generatedMorph = { models: MORPH_MODEL_IDS, ...MORPH_ENDPOINTS };
  expect<unknown>(generatedMorph).toEqual(catalog.compatibleProviders.morph);
  expect<unknown>(CONNECTION_MODELS).toEqual(catalog.snapshot.providers);
  // Captured from the original catalogs at 22f9482b, before switching them to generated data.
  expect({
    harnesses: digest(MODEL_CATALOG),
    compatibleProviders: digest({ morph: generatedMorph }),
    models: digest(catalog.snapshot.models),
    providers: digest(CONNECTION_MODELS),
  }).toEqual({
    harnesses: "eaa18ffb23a7bd6ef560724f16c20afa4b177a9de43ad945d1723bbbc9046b5c",
    compatibleProviders: "8d65b0d96776542cad4e82aa89b5d80fa99c974e0fcfa985fdde7b081e717f7f",
    models: "39dde57c0ba60226ac9aca9d4ca86fc456f6f5a72673aec16e8ea471052b8662",
    providers: "1a81c192b7e369a156d479093063b5eace42cfca67b7c4545f71ff0534e9e8bc",
  });
});
