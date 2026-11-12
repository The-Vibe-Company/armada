import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { customCodexAccountValue, replacementCodexAccountValue } from "../src/lib/model-connection-input";

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
    const result = customCodexAccountValue("openai", data(base + suffix, key));
    expect(result).toEqual({
      ok: true,
      value: JSON.stringify({ endpoint: { version: 1, baseUrl: base }, apiKey: key }),
    });
  },
);

test("dashboard accepts an optional API version and refuses invalid input without reflecting secrets", () => {
  const key = randomUUID();
  const valid = customCodexAccountValue("openai", data("https://example.com/v1", key, " 2025-04-01-preview "));
  expect(valid.ok && JSON.parse(valid.value).endpoint.apiVersion).toBe("2025-04-01-preview");
  for (const form of [
    data("https://user:password@example.com/v1", key),
    data("http://example.com", key),
    data("https://example.com?key=" + key, key),
    data("https://example.com", JSON.stringify({ apiKey: key })),
  ]) {
    const result = customCodexAccountValue("openai", form);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain("password");
  }
  expect(customCodexAccountValue("anthropic", data("https://example.com", key)).ok).toBe(false);
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
