import { expect, test } from "bun:test";
import { deliveryQueries, weeklyFixShare } from "./delivery-counters";

test("weekly fix share includes GitHub squash and merge commits inside the selected week", () => {
  const end = new Date("2026-11-18T00:00:00Z");
  const log = [
    ["2026-11-18", "a", "fix(server): recover events (#234)"],
    ["2026-11-17", "a b", "feat(server): add events"],
    ["2026-11-16", "a", "fix(server): direct commit"],
    ["2026-11-11", "a", "fix(server): prior week (#233)"],
    ["2026-11-19", "a", "fix(server): next week (#235)"],
  ]
    .map(([date, parents, subject]) => [Date.parse(date!) / 1000, parents, subject].join("\0"))
    .join("\n");

  expect(weeklyFixShare(log, end)).toMatchObject({ merges: 2, fixes: 1, share: 0.5 });
});

test("visible-text latency SQL exposes sample counts and percentiles in milliseconds", () => {
  const sql = deliveryQueries.runtimeCommandToFirstVisibleText;
  expect(sql).toMatch(/as samples\b/i);
  expect(sql).toMatch(/percentile_cont\(0\.50\).*"p50Ms"/);
  expect(sql).toMatch(/percentile_cont\(0\.95\).*"p95Ms"/);
});

test("launch stage SQL returns aggregate elapsed time by provider and stage for initial activations", () => {
  const sql = deliveryQueries.launchStageTotals;
  expect(sql).toMatch(/sum\(extract\(epoch from \(stage\.at - accepted\.at\)\)/i);
  expect(sql).toMatch(/accepted\.activation = stage\.activation and accepted\.stage = 'accepted'/);
  expect(sql).toMatch(/where stage\.activation = 1/);
  expect(sql).toMatch(/group by sandbox\.provider, stage\.stage/i);
});
