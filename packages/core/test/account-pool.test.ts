import { expect, test } from "bun:test";
import { type AccountCandidate, type AccountPool, choose } from "../src/account-pool.ts";
import { MODEL_CATALOG } from "../src/models.ts";

const now = Date.parse("2026-12-31T23:00:00Z");
const pool: AccountPool = { harness: "codex", credentialIds: ["first", "second"], model: "pool-model" };
const active: AccountCandidate = { version: 3, status: "active", harnesses: ["codex"] };
const budget = { capUsd: 500, spentUsd: 499, modelPriceKnown: true, hasUnpricedUsage: false };

test.each([
  ["inactive", { status: "deleted" }, { code: "account_inactive" }],
  ["expired", { expiresAt: "2026-12-31T23:00:00Z" }, { code: "account_expired" }],
  ["wrong harness", { harnesses: ["claude"] }, { code: "incompatible_harness" }],
  ["wrong model", { models: ["another-model"] }, { code: "incompatible_model" }],
  [
    "at USD cap",
    { budget: { ...budget, spentUsd: 500 } },
    { code: "budget_exhausted", resetsAt: "2027-01-01T00:00:00.000Z" },
  ],
  ["unknown model price", { budget: { ...budget, modelPriceKnown: false } }, { code: "pricing_unknown" }],
  ["unpriced usage", { budget: { ...budget, hasUnpricedUsage: true } }, { code: "pricing_unknown" }],
  [
    "exhausted",
    { exhaustion: { version: 3, code: "plan_limit", resetsAt: "2027-01-01T00:00:00Z" } },
    { code: "account_exhausted", exhaustionCode: "plan_limit", resetsAt: "2027-01-01T00:00:00Z" },
  ],
] as const)("skips the first account for %s and keeps the pool model", (_label, overrides, reason) => {
  const candidates = new Map([
    ["first", { ...active, ...overrides }],
    ["second", { ...active, version: 5, models: ["pool-model"] }],
  ]);
  expect(choose(pool, undefined, { now, candidates })).toEqual({
    kind: "account",
    credentialId: "second",
    credentialVersion: 5,
    model: "pool-model",
    skips: [{ credentialId: "first", reason }],
  });
});

test.each([
  { version: 3, code: "plan_limit", resetsAt: "2026-12-31T23:00:00Z" },
  { version: 3, code: "plan_limit", resetsAt: null },
  { version: 2, code: "plan_limit", resetsAt: "2027-01-01T00:00:00Z" },
])("selects the first eligible account when exhaustion does not apply (%j)", (exhaustion) => {
  const candidates = new Map([
    ["first", { ...active, exhaustion, budget }],
    ["second", active],
  ]);
  expect(choose(pool, "requested-model", { now, candidates })).toEqual({
    kind: "account",
    credentialId: "first",
    credentialVersion: 3,
    model: "requested-model",
    skips: [],
  });
});

test("refuses a full pool in preference order and reports account and model capacity separately", () => {
  const candidates = new Map<string, AccountCandidate>([
    ["second", { ...active, capacity: "model_full" }],
    ["first", { ...active, capacity: "account_full" }],
  ]);
  expect(choose(pool, undefined, { now, candidates })).toEqual({
    kind: "refuse",
    model: "pool-model",
    skips: [
      { credentialId: "first", reason: { code: "account_full" } },
      { credentialId: "second", reason: { code: "model_full" } },
    ],
  });
});

test("an explicit account outside the pool uses the harness default model", () => {
  const candidates = new Map([
    ["first", active],
    ["pinned", active],
  ]);
  const result = choose(pool, undefined, { now, candidates, explicit: { credentialId: "pinned" } });
  expect(result).toMatchObject({ kind: "account", credentialId: "pinned", credentialVersion: 3, skips: [] });
  expect(result.model).toBe(MODEL_CATALOG.codex.defaultModel);
});

test.each([
  [3, { capacity: "account_full" }, "wait", "account_full"],
  [2, {}, "refuse", "account_version_changed"],
  [3, { budget: { ...budget, modelPriceKnown: false } }, "refuse", "pricing_unknown"],
] as const)("an explicit pin with version %d and facts %j returns %s", (credentialVersion, overrides, kind, code) => {
  const candidates = new Map([
    ["first", active],
    ["pinned", { ...active, ...overrides }],
  ]);
  const explicit = { credentialId: "pinned", credentialVersion };
  expect(choose(pool, "requested-model", { now, candidates, explicit, canWait: true })).toEqual({
    kind,
    model: "requested-model",
    skips: [{ credentialId: "pinned", reason: { code } }],
  });
});

test("refuses a missing explicit account without exposing its eligibility or trying the pool", () => {
  const candidates = new Map([["first", active]]);
  const explicit = { credentialId: "unavailable" };
  expect(choose(pool, "requested-model", { now, candidates, explicit })).toEqual({
    kind: "refuse",
    model: "requested-model",
    skips: [{ credentialId: "unavailable", reason: { code: "account_unavailable" } }],
  });
});
