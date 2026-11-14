import { expect, spyOn, test } from "bun:test";
import { measureProviderPhase, measureSqlQuery, RequestTiming, withRequestTiming } from "../src/request-timing.ts";

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
  const results = await withRequestTiming(timing, () =>
    Promise.allSettled([sql.query("private query"), sql.query("another private query")]),
  );
  expect(results).toEqual([
    { status: "rejected", reason: failure },
    { status: "rejected", reason: failure },
  ]);
  expect(timing.header()).toMatch(/^sql;dur=\d+\.\d{2};desc="2", sql_1;dur=\d+\.\d{2}, sql_2;dur=\d+\.\d{2}$/);
  const recorded = timing.header();
  await expect(sql.query("another private query")).rejects.toBe(failure);
  expect(timing.header()).toBe(recorded);
  expect(timing.header()).not.toContain("private");
});

test("statement labels follow start order across overlapping queries and stay request local", async () => {
  let time = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => time);
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const timing = new RequestTiming();
  try {
    const a = withRequestTiming(timing, () => measureSqlQuery(() => first.promise));
    time = 10;
    const b = withRequestTiming(timing, () => measureSqlQuery(() => second.promise));
    time = 20;
    second.resolve();
    await b;
    expect(timing.header()).toBe('sql;dur=10.00;desc="2", sql_2;dur=10.00');
    time = 50;
    first.resolve();
    await a;
    expect(timing.header()).toBe('sql;dur=60.00;desc="2", sql_1;dur=50.00, sql_2;dur=10.00');
    const another = new RequestTiming();
    await withRequestTiming(another, () => measureSqlQuery(async () => {}));
    expect(another.header()).toBe('sql;dur=0.00;desc="1", sql_1;dur=0.00');
  } finally {
    first.resolve();
    second.resolve();
    clock.mockRestore();
  }
});

test("statement header detail is bounded while aggregate count covers every query", async () => {
  const timing = new RequestTiming();
  await withRequestTiming(timing, async () => {
    for (let i = 0; i < 40; i++) await measureSqlQuery(async () => {});
  });
  const header = timing.header();
  expect(header).toContain('desc="40"');
  expect(header.match(/sql_\d+;/g)).toHaveLength(32);
  expect(header).toContain("sql_32;");
  expect(header).not.toContain("sql_33;");
});
