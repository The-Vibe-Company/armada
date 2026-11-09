import { expect, test } from "bun:test";
import type { AgentEvent, Sql } from "@armada/core";
import { createModelUsageApi } from "../src/model-usage.ts";
import { fakeBoat } from "./support.ts";

function fixture() {
  let time = Date.parse("2026-11-09T12:00:00Z");
  let data: unknown = {};
  let type = "account/rateLimits/read";
  const sql = { query: async () => ({ rows: [{ version: 1, sandbox_id: "sandbox" }] }) } as unknown as Sql;
  const provider = fakeBoat().provider;
  provider.events = async () => ({
    events: [{ id: String(time), kind: "other", type, at: time, data } as AgentEvent],
    hasMore: false,
  });
  const api = createModelUsageApi(sql, () => new Date(time));
  return {
    observe(value: unknown, sparse = false) {
      data = value;
      type = sparse ? "account/rateLimits/updated" : "account/rateLimits/read";
      time += 16_000;
    },
    advance(ms: number) {
      time += ms;
    },
    read: () =>
      api.read({ userId: "owner", orgs: [], via: "supabase" }, "account", "sandbox", async () => ({
        provider,
        providerSandboxId: "native",
      })),
  };
}

test.each([
  ["zero", { hasCredits: false, unlimited: false, balance: "0" }],
  ["decimal", { hasCredits: true, unlimited: false, balance: "9007199254740993.0012300" }],
  ["unlimited", { hasCredits: false, unlimited: true, balance: null }],
] as const)(
  "native credit-only %s is valid and preserves exact source values without money inference",
  async (_name, credits) => {
    const f = fixture();
    f.observe({ rateLimits: { limitId: "codex", primary: null, secondary: null, credits } });
    const value = await f.read();
    expect(value).toMatchObject({ status: "fresh", windows: [], credits });
    expect(value.credits).toEqual(credits);
    expect(value.extraUsage).toBeUndefined();
    expect(value.credits).not.toHaveProperty("currency");
  },
);

test.each([
  undefined,
  null,
  {},
  { hasCredits: "false", unlimited: false, balance: "0" },
  { hasCredits: false, unlimited: 1, balance: "0" },
  { hasCredits: false, unlimited: false, balance: 0 },
  { hasCredits: false, unlimited: false, balance: "not-a-balance" },
])("absent or malformed native credit state is not fabricated as zero: %j", async (credits) => {
  const f = fixture();
  f.observe({ rateLimits: { primary: null, secondary: null, credits } });
  const value = await f.read();
  expect(value.status).toBe("unavailable");
  expect(value.credits).toBeUndefined();
  expect(value.windows).toEqual([]);
});

test("all actual native map IDs retain windows/credits and the primary/secondary compatibility view", async () => {
  const f = fixture();
  f.observe({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 25, resetsAt: null },
      secondary: { usedPercent: 50, resetsAt: null },
      credits: { hasCredits: false, unlimited: false, balance: "0" },
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 26, resetsAt: null },
        credits: { hasCredits: true, unlimited: false, balance: "1.200" },
      },
      review: {
        limitId: "review",
        limitName: "Review",
        primary: { usedPercent: 42, resetsAt: 1794268800 },
        secondary: { usedPercent: 7, resetsAt: null },
        credits: { hasCredits: true, unlimited: false, balance: "12.3400" },
      },
      extra: {
        limitId: "extra",
        primary: null,
        secondary: null,
        credits: { hasCredits: false, unlimited: true, balance: null },
      },
    },
    accountId: "upstream-private-account",
    auth: "must-not-return-native-envelope",
  });
  const value = await f.read();
  expect(value.buckets?.map((bucket) => bucket.sourceId)).toEqual(["codex", "review", "extra"]);
  expect(value.windows.map((window) => [window.id, window.sourceId, window.usedPercent])).toEqual([
    ["primary", "codex", 25],
    ["secondary", "codex", 50],
    ["review:primary", "review", 42],
    ["review:secondary", "review", 7],
  ]);
  expect(value.buckets?.[0]?.windows[0]?.usedPercent).toBe(26); // Exact map view, not discarded for compatibility.
  expect(value.credits?.balance).toBe("0");
  expect(value.buckets?.[1]?.credits?.balance).toBe("12.3400");
  expect(value.buckets?.[2]).toMatchObject({ windows: [], credits: { unlimited: true, balance: null } });
  expect(JSON.stringify(value)).not.toContain("upstream-private-account");
  expect(JSON.stringify(value)).not.toContain("must-not-return-native-envelope");
});

test("sparse native updates keep last-known credit/bucket timestamps instead of clearing or refreshing absent metadata", async () => {
  const f = fixture();
  f.observe({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 25, resetsAt: null },
      credits: { hasCredits: false, unlimited: false, balance: "0.000" },
    },
    rateLimitsByLimitId: {
      review: {
        primary: { usedPercent: 42, resetsAt: null },
        credits: { hasCredits: true, unlimited: false, balance: "12.3400" },
      },
    },
  });
  const first = await f.read();
  f.advance(61_000);
  f.observe({ rateLimits: { limitId: "codex", primary: { usedPercent: 31, resetsAt: null }, credits: null } }, true);
  const value = await f.read();
  expect(value.credits?.balance).toBe("0.000");
  expect(value.creditsObservedAt).toBe(first.creditsObservedAt);
  expect(value.buckets?.find((bucket) => bucket.sourceId === "review")?.credits?.balance).toBe("12.3400");
  expect(value.status).toBe("stale");
  expect(value.windows.find((window) => window.id === "primary")?.usedPercent).toBe(31);
});
