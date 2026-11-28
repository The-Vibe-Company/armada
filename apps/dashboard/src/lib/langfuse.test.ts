import { expect, test } from "bun:test";
import {
  LANGFUSE_HOST_CHANGE_ERROR,
  LANGFUSE_MISSING_FIELDS_ERROR,
  parseLangfuseModelsSummary,
  parseLangfuseModelsSyncResult,
  parseLangfuseSettings,
  readLangfuseForm,
  readLangfuseModelOverrideForm,
} from "./langfuse";

test("member status strips admin details even if the upstream response contains them", () => {
  expect(
    parseLangfuseSettings(
      {
        enabled: true,
        contentMode: "full",
        host: "https://example.com",
        counters: { exported: 90, failed: 0, dropped: 0 },
      },
      false,
    ),
  ).toEqual({ scope: "member", enabled: true, contentMode: "full" });
});

test("a mode-only edit omits stored credentials and an equivalent host", () => {
  const form = new FormData();
  form.set("host", " https://cloud.langfuse.com/ ");
  form.set("publicKey", " fixture_public ");
  form.set("contentMode", "full");
  expect(
    readLangfuseForm(form, {
      host: "https://cloud.langfuse.com",
      publicKey: "fixture_public",
      contentMode: "metadata",
    }),
  ).toEqual({ ok: true, input: { contentMode: "full" } });
});

test("moving to a new host sends both keys required by the API", () => {
  const form = new FormData();
  form.set("host", "https://us.cloud.langfuse.com");
  form.set("publicKey", "fixture_public");
  form.set("secretKey", "fixture_replacement");
  form.set("contentMode", "metadata");
  expect(
    readLangfuseForm(form, {
      host: "https://cloud.langfuse.com",
      publicKey: "fixture_public",
      contentMode: "metadata",
    }),
  ).toEqual({
    ok: true,
    input: {
      host: "https://us.cloud.langfuse.com",
      publicKey: "fixture_public",
      secretKey: "fixture_replacement",
    },
  });
});

test("moving to a new host explains that replacing the Secret key is required", () => {
  const form = new FormData();
  form.set("host", "https://us.cloud.langfuse.com");
  form.set("publicKey", "fixture_public");
  form.set("contentMode", "metadata");
  const result = readLangfuseForm(form, {
    host: "https://cloud.langfuse.com",
    publicKey: "fixture_public",
    contentMode: "metadata",
  });
  expect(result).toEqual({ ok: false, error: LANGFUSE_HOST_CHANGE_ERROR });
  expect(result.ok === false && result.error).not.toBe(LANGFUSE_MISSING_FIELDS_ERROR);
  expect(result.ok === false && result.error.toLowerCase()).toContain("secret key");
});

const pr = (input = 1.25, output = 10, cacheRead: number | null = 0.31) => {
  const [cacheWrite, reasoning] = [null, null];
  return { input, output, cacheRead, cacheWrite, reasoning };
};
const fd = (pairs: string) => {
  const f = new FormData();
  for (const kv of pairs.split("|")) f.set(kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1));
  return f;
};
const arm = (
  id: string,
  providerGroup: "antigravity" | "morph",
  status: "matched_builtin" | "matched_custom" | "unmatched",
  matchedModel: ReturnType<typeof parseLangfuseModelsSummary>["customModels"][number] | null,
  sug: ReturnType<typeof parseLangfuseModelsSummary>["armadaModels"][number]["suggestedPricesPerMillion"],
) => {
  const [label, sampleModelNames, defaultModelName, defaultMatchPattern] = [id, [id], id, `(?i)^${id}$`];
  const base = { id, label, providerGroup, sampleModelNames, defaultModelName, defaultMatchPattern };
  return { ...base, status, matchedModel, suggestedPricesPerMillion: sug };
};

test("parseLangfuseModelsSummary and parseLangfuseModelsSyncResult validate payloads", () => {
  const [id, modelName, matchPattern, unit, isLangfuseManaged] = ["lf-1", "ag/pro", "(?i)^ag/pro$", "TOKENS", false];
  const rec = { id, modelName, matchPattern, unit, isLangfuseManaged, pricesPerMillion: pr() };
  const sug = { ...pr(), source: "catalog" as const, sourceModel: "pro" };
  const a1 = arm("ag/pro", "antigravity", "matched_custom", rec, sug);
  const summary = { armadaModels: [a1, arm("m3", "morph", "unmatched", null, null)], customModels: [rec] };
  expect(parseLangfuseModelsSummary(summary)).toEqual(summary);
  const sync = { ...summary, created: ["m3"], skipped: ["ag/pro"], failed: [] };
  expect(parseLangfuseModelsSyncResult(sync)).toEqual(sync);
  const bads: unknown[] = [
    { armadaModels: "x", customModels: [] },
    { armadaModels: [{ ...a1, providerGroup: "x" }], customModels: [] },
    { armadaModels: [], customModels: [{ ...rec, pricesPerMillion: pr(-1) }] },
  ];
  for (const b of bads) expect(() => parseLangfuseModelsSummary(b)).toThrow();
  expect(() => parseLangfuseModelsSyncResult({ ...sync, failed: [1] })).toThrow();
});

test("readLangfuseModelOverrideForm validates decimals, (?i) regex, blank optionals, and bad inputs", () => {
  const raw =
    "modelName= ag/pro |matchPattern= (?i)^ag/pro$ |input=1.25|output=10.5|cacheRead=0.075|cacheWrite= |reasoning=|replaceModelId= lf-1 ";
  const [modelName, matchPattern, replaceModelId] = ["ag/pro", "(?i)^ag/pro$", "lf-1"];
  const pricesPerMillion = pr(1.25, 10.5, 0.075);
  expect(readLangfuseModelOverrideForm(fd(raw))).toEqual({
    ok: true,
    input: { modelName, matchPattern, pricesPerMillion, replaceModelId },
  });
  const bad = "matchPattern=(?i)[x|matchPattern=(?i)|input=-0.1|output=abc|output=Infinity|cacheRead=-2|reasoning=NaN";
  for (const s of bad.split("|")) {
    expect(readLangfuseModelOverrideForm(fd(`modelName=m|matchPattern=^m$|input=1|output=2|${s}`)).ok).toBe(false);
  }
});
