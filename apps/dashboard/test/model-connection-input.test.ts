import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  customAccountValue,
  replacementClaudeAccountValue,
  replacementCodexAccountValue,
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
