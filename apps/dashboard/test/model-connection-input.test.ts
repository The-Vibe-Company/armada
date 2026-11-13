import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { catalogPriceLabel, visibleCatalogModels } from "../src/lib/connection-presets";
import {
  customAccountValue,
  presetAccountValue,
  replacementClaudeAccountValue,
  replacementCodexAccountValue,
  replacementOpenCodeAccountValue,
} from "../src/lib/model-connection-input";

function data(baseUrl: string, key: string, apiVersion = "") {
  const form = new FormData();
  form.set("baseUrl", baseUrl);
  form.set("value", key);
  form.set("apiVersion", apiVersion);
  return form;
}

test.each(["", "/responses"])(
  "dashboard composes a Foundry connection without losing its project path (%s)",
  (suffix) => {
    const key = randomUUID();
    const base = "https://resource.services.ai.azure.com/api/projects/project/openai/v1";
    const result = customAccountValue("openai", data(base + suffix, key));
    expect(result).toEqual({
      ok: true,
      value: JSON.stringify({ endpoint: { version: 1, baseUrl: base }, apiKey: key }),
    });
  },
);

test("dashboard accepts an optional API version and refuses invalid input without reflecting secrets", () => {
  const key = randomUUID();
  const valid = customAccountValue("openai", data("https://example.com/v1", key, " 2025-04-01-preview "));
  expect(valid.ok && JSON.parse(valid.value).endpoint.apiVersion).toBe("2025-04-01-preview");
  for (const form of [
    data("https://user:password@example.com/v1", key),
    data("http://example.com", key),
    data("https://example.com?key=" + key, key),
    data("https://example.com", JSON.stringify({ apiKey: key })),
  ]) {
    const result = customAccountValue("openai", form);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain("password");
  }
  expect(customAccountValue("codex_auth", data("https://example.com", key)).ok).toBe(false);
});

test.each(["api-key", "bearer"])("dashboard composes a Claude gateway with explicit %s authentication", (auth) => {
  const key = randomUUID();
  const form = data("https://example.com/anthropic/", key);
  form.set("endpointAuth", auth);
  expect(customAccountValue("anthropic", form)).toEqual({
    ok: true,
    value: JSON.stringify({ endpoint: { version: 1, baseUrl: "https://example.com/anthropic", auth }, apiKey: key }),
  });
});

test("Claude gateway form rejects invalid auth and mixed Codex options without reflecting the key", () => {
  const key = randomUUID();
  const form = data("https://example.com", key);
  for (const auth of ["", "oauth", key]) {
    form.set("endpointAuth", auth);
    const result = customAccountValue("anthropic", form);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(key);
  }
  form.set("endpointAuth", "bearer");
  form.set("apiVersion", "2025-04-01-preview");
  expect(customAccountValue("anthropic", form).ok).toBe(false);
});

test("Codex replacement requires a destination and refuses JSON pretending to be a default key", () => {
  const key = randomUUID();
  const form = data("https://example.com/v1/responses", key);
  expect(replacementCodexAccountValue(form).ok).toBe(false);
  form.set("connectionMode", "openai");
  expect(replacementCodexAccountValue(form)).toEqual({ ok: true, value: key });
  form.set("value", JSON.stringify({ apiKey: key }));
  expect(replacementCodexAccountValue(form).ok).toBe(false);
  form.set("value", key);
  form.set("connectionMode", "custom");
  expect(replacementCodexAccountValue(form)).toEqual({
    ok: true,
    value: JSON.stringify({ endpoint: { version: 1, baseUrl: "https://example.com/v1" }, apiKey: key }),
  });
});

test.each(["api-key", "bearer"])("Claude replacement composes a complete gateway with %s authentication", (auth) => {
  const key = randomUUID();
  const form = data("https://example.com/anthropic/", key);
  form.set("connectionMode", "custom");
  form.set("endpointAuth", auth);
  expect(replacementClaudeAccountValue(form)).toEqual({
    ok: true,
    value: JSON.stringify({ endpoint: { version: 1, baseUrl: "https://example.com/anthropic", auth }, apiKey: key }),
  });
});

test("Claude replacement requires a destination and refuses malformed or ambiguous configuration", () => {
  const key = randomUUID();
  const form = data("https://example.com", key);
  expect(replacementClaudeAccountValue(form).ok).toBe(false);
  form.set("connectionMode", "anthropic");
  expect(replacementClaudeAccountValue(form)).toEqual({ ok: true, value: key });
  form.set("value", JSON.stringify({ apiKey: key }));
  expect(replacementClaudeAccountValue(form).ok).toBe(false);
  form.set("value", key);
  form.set("connectionMode", "custom");
  form.set("endpointAuth", "oauth");
  expect(replacementClaudeAccountValue(form).ok).toBe(false);
  form.set("endpointAuth", "bearer");
  form.set("apiVersion", "v1");
  expect(replacementClaudeAccountValue(form).ok).toBe(false);
  form.set("apiVersion", "");
  form.set("baseUrl", "https://user:password@example.com");
  const failure = replacementClaudeAccountValue(form);
  expect(failure.ok).toBe(false);
  expect(JSON.stringify(failure)).not.toContain(key);
  expect(JSON.stringify(failure)).not.toContain("password");
});

test.each(["openai", "anthropic"] as const)("dashboard composes exact optional prices on %s connections", (kind) => {
  const form = data("https://gateway.example/v1", randomUUID());
  form.set("endpointAuth", "bearer");
  form.set("priceModel", " deployment ");
  form.set("priceInput", "0");
  form.set("priceOutput", "12.345678901234");
  for (const cached of ["", "0.25"]) {
    form.set("priceCachedInput", cached);
    const result = customAccountValue(kind, form);
    expect(result.ok && JSON.parse(result.value).prices).toEqual({
      deployment: {
        input: "0",
        output: "12.345678901234",
        cacheRead: cached || null,
        cacheWrite: null,
        reasoning: null,
      },
    });
  }
});

test("invalid dashboard price fields refuse the connection without reflecting supplied values", () => {
  const key = randomUUID();
  for (const fields of [
    { priceModel: "deployment" },
    { priceModel: "deployment", priceInput: key, priceOutput: "1" },
    { priceModel: "deployment", priceInput: "1", priceOutput: "2", priceCachedInput: "-1" },
  ]) {
    const form = data("https://gateway.example/v1", key);
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    const result = customAccountValue("openai", form);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(!result.ok && result.error).toContain("USD per million");
  }
});

test("a provider preset decides the kind and merges ticked and typed models; the browser cannot send prices", () => {
  const key = randomUUID();
  const form = new FormData();
  form.set("preset", "openrouter");
  form.set("kind", "anthropic");
  form.set("value", key);
  form.append("model", "x-ai/first");
  form.set("customModels", "x-ai/second, x-ai/first");
  form.set("priceInput", "0");
  const result = presetAccountValue(form);
  if (!result.ok) throw Error(result.error);
  expect(result.kind).toBe("opencode");
  const value = JSON.parse(result.value);
  expect(value.endpoint).toEqual({
    version: 1,
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["x-ai/first", "x-ai/second"],
  });
  expect(value.prices).toBeUndefined();

  const plain = new FormData();
  plain.set("preset", "openai");
  plain.set("value", key);
  expect(presetAccountValue(plain)).toEqual({ ok: false, error: "Choose a provider." });
  const empty = new FormData();
  empty.set("preset", "openai-compatible");
  empty.set("baseUrl", "https://api.example.com/v1");
  empty.set("value", key);
  const refused = presetAccountValue(empty);
  expect(refused).toEqual({ ok: false, error: "Choose at least one model." });
});

test("the model list keeps ticked models visible through any search and caps the rest", () => {
  const models = ["alpha-one", "beta-two", "alpha-three"].map((id) => ({
    id,
    name: id.toUpperCase(),
    input: "1",
    output: null,
    cacheRead: null,
  }));
  expect(visibleCatalogModels(models, "ALPHA", new Set()).map((model) => model.id)).toEqual([
    "alpha-one",
    "alpha-three",
  ]);
  expect(visibleCatalogModels(models, "alpha", new Set(["beta-two"]), 2).map((model) => model.id)).toEqual([
    "beta-two",
    "alpha-one",
  ]);
  expect(catalogPriceLabel(models[0] ?? { input: null, output: null })).toBeNull();
  expect(catalogPriceLabel({ input: "0.15", output: "0.6" })).toBe("$0.15 in · $0.6 out per M tokens");
});

test("OpenCode replacement names its destination: a plan key never silently replaces a provider connection", () => {
  const key = randomUUID();
  const form = new FormData();
  form.set("value", key);
  expect(replacementOpenCodeAccountValue(form)).toEqual({
    ok: false,
    error: "Choose the replacement connection type.",
  });
  form.set("connectionMode", "opencode");
  expect(replacementOpenCodeAccountValue(form)).toEqual({ ok: true, value: key });
  form.set("value", JSON.stringify({ apiKey: key }));
  const refused = replacementOpenCodeAccountValue(form);
  expect(refused.ok).toBe(false);
  expect(JSON.stringify(refused)).not.toContain(key);
});
