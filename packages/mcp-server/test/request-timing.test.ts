import { expect, test } from "bun:test";
import { measureProviderPhase, RequestTiming, withRequestTiming } from "../src/request-timing.ts";

test("provider timings stay inside their concurrent request and preserve callback results", async () => {
  const first = new RequestTiming();
  const second = new RequestTiming();
  const results = await Promise.all([
    withRequestTiming(first, async () => {
      await Promise.resolve();
      return measureProviderPhase("modal_prepare", async () => "prepared");
    }),
    withRequestTiming(second, async () => {
      await Promise.resolve();
      return measureProviderPhase("modal_rpc", async () => "submitted");
    }),
  ]);
  expect(results).toEqual(["prepared", "submitted"]);
  expect(first.header()).toMatch(/^modal_prepare;dur=\d+\.\d{2}$/);
  expect(second.header()).toMatch(/^modal_rpc;dur=\d+\.\d{2}$/);
  expect(await measureProviderPhase("modal_health", async () => "no HTTP context")).toBe("no HTTP context");
  expect(first.header()).not.toContain("modal_health");
});

test("SQL timing includes rejected queries and is absent outside request context", async () => {
  const { sqlOver } = await import("../src/sql.ts");
  const timing = new RequestTiming();
  const failure = new Error("private database detail");
  const sql = sqlOver({
    unsafe: async () => {
      throw failure;
    },
  });
  await expect(withRequestTiming(timing, () => sql.query("private query"))).rejects.toBe(failure);
  expect(timing.header()).toMatch(/^sql;dur=\d+\.\d{2}$/);
  const recorded = timing.header();
  await expect(sql.query("another private query")).rejects.toBe(failure);
  expect(timing.header()).toBe(recorded);
  expect(timing.header()).not.toContain("private");
});
