import { expect, test } from "bun:test";
import type { AgentEvent, Sql } from "@armada/core";
import { createModelUsageApi } from "../src/model-usage.ts";
import { fakeBoat } from "./support.ts";

test("passive native account usage preserves currency, unknown allowance and freshness without inference", async () => {
  let time = Date.parse("2026-11-09T12:00:00Z"),
    calls = 0;
  let permitted = true;
  // This test owns DTO/native-unit/freshness behavior, not SQL authorization.
  // Real migration authorization coverage is a separate integration gate.
  const sql = {
    query: async () => ({ rows: permitted ? [{ version: 3, sandbox_id: "sandbox" }] : [] }),
  } as unknown as Sql;
  const provider = fakeBoat().provider;
  let events: AgentEvent[] = [
    {
      id: "usage",
      kind: "other",
      type: "usage_report",
      at: time,
      data: {
        rate_limits: {
          limits: [{ kind: "session", percent: 25, resets_at: null }],
          extra_usage: { is_enabled: true, currency: "EUR", used_credits: 125, monthly_limit: 2000 },
        },
        tokens: "must-not-leak",
      },
    },
  ];
  provider.events = async () => {
    calls++;
    return { events, cursor: String(calls), hasMore: false };
  };
  provider.prompt = async () => {
    throw Error("Quota read must never start inference");
  };
  const api = createModelUsageApi(sql, () => new Date(time));
  const caller = { userId: "owner", orgs: [], via: "supabase" as const };
  const read = () => api.read(caller, "account", "sandbox", async () => ({ provider, providerSandboxId: "native" }));
  expect(await read()).toEqual({
    accountId: "account",
    version: 3,
    status: "fresh",
    observedAt: new Date(time).toISOString(),
    windows: [{ id: "session-0", label: "session", kind: "session", usedPercent: 25, resetsAt: null }],
    extraUsage: { enabled: true, currency: "EUR", usedMinor: 125, limitMinor: 2000, used: 1.25, limit: 20 },
  });
  expect(await read()).toHaveProperty("status", "fresh");
  expect(calls).toBe(1);
  time += 61_000;
  events = [];
  expect(await read()).toHaveProperty("status", "stale");
  events = [{ id: "unknown", kind: "other", type: "usage_report", at: time + 16_000, data: { rate_limits: null } }];
  time += 16_000;
  expect(await read()).toMatchObject({ status: "unavailable", windows: [] });
  time += 16_000;
  events = [
    {
      id: "spend-only",
      kind: "other",
      type: "usage_report",
      at: time,
      data: {
        rate_limits: {
          limits: null,
          extra_usage: { is_enabled: true, currency: "JPY", used_credits: 125, monthly_limit: null },
        },
      },
    },
  ];
  expect(await read()).toMatchObject({
    status: "unavailable",
    windows: [],
    extraUsage: { currency: "JPY", usedMinor: 125, limitMinor: null },
  });
  time += 16_000;
  provider.events = async () => {
    calls++;
    time += 100; // A notification arrives while the provider read is in flight.
    return {
      events: [
        {
          id: "concurrent",
          kind: "other",
          type: "account/rateLimits/updated",
          at: time,
          data: { rateLimits: { primary: { usedPercent: 31, resetsAt: 1794268800 } } },
        },
      ],
      cursor: "latest",
      hasMore: false,
    };
  };
  expect(await read()).toMatchObject({
    status: "fresh",
    observedAt: new Date(time).toISOString(),
    windows: [{ kind: "primary", usedPercent: 31, resetsAt: "2026-11-10T00:00:00.000Z" }],
  });
  time += 16_000;
  provider.events = async () => {
    calls++;
    permitted = false;
    throw Error("provider read failed");
  };
  await expect(read()).rejects.toMatchObject({ code: "not_found" });
  expect(calls).toBe(6); // Revocation is checked before even cached metadata is returned.
});

test("quota cancellation wins a late native response without publishing its cache data", async () => {
  let time = 1000,
    controller = new AbortController();
  const sql = { query: async () => ({ rows: [{ version: 1, sandbox_id: "sandbox" }] }) } as unknown as Sql;
  const provider = fakeBoat().provider;
  const page = (percent: number) => ({
    hasMore: false,
    cursor: String(percent),
    events: [
      {
        id: String(percent),
        kind: "other" as const,
        type: "account/rateLimits/updated",
        at: time,
        data: { rateLimits: { primary: { usedPercent: percent, resetsAt: null } } },
      },
    ],
  });
  provider.events = async () => page(25);
  const api = createModelUsageApi(
    sql,
    () => new Date(time),
    () => controller.signal,
  );
  const caller = { userId: "owner", orgs: [], via: "supabase" as const };
  const read = () => api.read(caller, "account", "sandbox", async () => ({ provider, providerSandboxId: "native" }));
  expect(await read()).toMatchObject({ status: "fresh", windows: [{ usedPercent: 25 }] });
  time += 16_000;
  provider.events = async () => {
    controller.abort();
    return page(99);
  };
  expect(await read()).toMatchObject({ status: "error", windows: [{ usedPercent: 25 }] });
  controller = new AbortController();
  time += 16_000;
  provider.events = async () => ({ events: [], hasMore: false });
  expect(await read()).toMatchObject({ status: "fresh", windows: [{ usedPercent: 25 }] });
});
