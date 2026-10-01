import { describe, expect, test } from "bun:test";
import {
  type Budget,
  checkBundles,
  checkInteractions,
  checkPages,
  cpuSlowdown,
  markdown,
  medianRun,
  type PageResult,
  REPORT_MARKER,
  resultOf,
  routeBytes,
} from "../scripts/perf.ts";

const page = (over: Partial<PageResult>): PageResult => ({
  page: "/agents",
  formFactor: "mobile",
  performance: 98,
  accessibility: 100,
  "best-practices": 96,
  lcp: 1600,
  cls: 0,
  tbt: 120,
  ...over,
});

const BUDGETS: Budget[] = [
  { metric: "performance", min: 95 },
  { metric: "accessibility", min: 100, level: "warn" },
  { metric: "cls", max: 0 },
  { metric: "lcp", max: 2500, formFactor: "mobile" },
];

describe("the JS budgets per route", () => {
  test("sum each route's first-load chunks once, and compress each chunk once", () => {
    const gzipped: string[] = [];
    const bytes = routeBytes(
      [
        { route: "/", firstLoadChunkPaths: ["a.js", "b.js", "a.js"] },
        { route: "/agents", firstLoadChunkPaths: ["a.js", "c.js"] },
      ],
      (path) => {
        gzipped.push(path);
        return { "a.js": 100, "b.js": 20, "c.js": 7 }[path] ?? 0;
      },
    );
    expect(bytes).toEqual({ "/": 120, "/agents": 107 });
    expect(gzipped).toEqual(["a.js", "b.js", "c.js"]);
  });

  test("hold up to the baseline plus the tolerance; a route without a baseline breaks them", () => {
    const rows = checkBundles(
      { "/": 1050, "/agents": 1051, "/insights": 10 },
      { tolerance: 0.05, routes: { "/": 1000, "/agents": 1000 } },
    );
    expect(rows.map((r) => [r.route, r.limit, r.ok])).toEqual([
      ["/", 1050, true],
      ["/agents", 1050, false],
      ["/insights", null, false],
    ]);
  });
});

describe("the Lighthouse budgets", () => {
  test("read a run as Lighthouse shows it: scores out of 100, CLS to three decimals", () => {
    const r = resultOf(
      {
        categories: { performance: { score: 0.951 }, accessibility: { score: 0.96 }, "best-practices": { score: 1 } },
        audits: {
          "largest-contentful-paint": { numericValue: 1612.4 },
          "cumulative-layout-shift": { numericValue: 0.00044 },
          "total-blocking-time": { numericValue: 87.6 },
        },
        environment: { benchmarkIndex: 2000 },
      },
      "/",
      "mobile",
    );
    expect(r).toEqual(
      page({ page: "/", performance: 95, accessibility: 96, "best-practices": 100, lcp: 1612, tbt: 88 }),
    );
  });

  test("keep the median run of performance", () => {
    expect(
      medianRun([page({ performance: 99 }), page({ performance: 91 }), page({ performance: 96 })]).performance,
    ).toBe(96);
  });

  test("break on a score under its minimum or a metric over its maximum, LCP on mobile only, accessibility as a warning", () => {
    const breaches = checkPages(
      [
        page({ performance: 94, accessibility: 96, cls: 0.001 }),
        page({ formFactor: "desktop", lcp: 3000 }),
        page({ page: "/projects", lcp: 2600 }),
      ],
      BUDGETS,
    );
    expect(breaches.map((b) => [b.where, b.metric, b.value, b.limit, b.level])).toEqual([
      ["/agents (mobile)", "performance", 94, 95, "error"],
      ["/agents (mobile)", "accessibility", 96, 100, "warn"],
      ["/agents (mobile)", "cls", 0.001, 0, "error"],
      ["/projects (mobile)", "lcp", 2600, 2500, "error"],
    ]);
  });

  test("slow mobile's CPU down as much on any machine: scaled by its benchmark index, never under 1", () => {
    const cpu = { slowdown: 4, referenceBenchmarkIndex: 2000 };
    expect([cpuSlowdown(2000, cpu), cpuSlowdown(1500, cpu), cpuSlowdown(2415, cpu), cpuSlowdown(300, cpu)]).toEqual([
      4, 3, 4.8, 1,
    ]);
  });
});

describe("the report", () => {
  test("shows every number, then what broke and what only warns", () => {
    const text = markdown({
      lighthouse: {
        slowdown: 3,
        benchmarkIndex: 1500,
        results: [page({ accessibility: 96 }), page({ formFactor: "desktop", performance: 100 })],
        breaches: checkPages([page({ accessibility: 96 })], BUDGETS),
      },
      bundles: checkBundles({ "/agents": 2048 }, { tolerance: 0.05, routes: { "/agents": 1024 } }),
      inp: {
        slowdown: 4,
        maxMs: 200,
        interactions: [
          { name: "Open the ⌘K palette", ms: 96 },
          { name: "Answer a decision", ms: 0 },
        ],
        breaches: checkInteractions([{ name: "Open the ⌘K palette", ms: 96 }], 200),
      },
    });
    expect(text.startsWith(REPORT_MARKER)).toBe(true);
    expect(text).toContain("| `/agents` | 98 · 96 · 96 · 1.60 s · 0.000 | 100 · 100 · 96 · 0.000 |");
    expect(text).toContain("| `/agents` | 2.0 KB | 1.0 KB ❌ |");
    expect(text).toContain("| Answer a decision | < 16 ms |");
    expect(text).toContain("- ❌ /agents: 2.0 KB of first-load JS, budget 1.0 KB");
    expect(text).toContain("- ⚠️ /agents (mobile): accessibility 96, budget ≥ 100");
    expect(text).not.toContain("Every budget holds.");
  });

  test("says when every budget holds", () => {
    expect(markdown({ inp: { slowdown: 4, maxMs: 200, interactions: [], breaches: [] } })).toContain(
      "Every budget holds.",
    );
  });

  test("an interaction over its budget breaks it", () => {
    expect(checkInteractions([{ name: "Filter", ms: 216 }], 200)).toEqual([
      { where: "Filter", metric: "inp", value: 216, limit: 200, level: "error" },
    ]);
  });
});
