// The dashboard's performance budgets (THE-892), checked on every pull request
// against a production build of the demo world (docs/performance.md):
//   bun run perf bundles [--update]   first-load JS per route, gzipped, from `next build`'s
//                                     .next/diagnostics/route-bundle-stats.json; --update
//                                     makes today's sizes the baseline of perf/budgets.json
//   bun run perf lighthouse <url>     Lighthouse on the pages of perf/budgets.json, mobile and desktop
//   bun run perf inp <url>            the main interactions under a 4× slower CPU (Playwright)
//   bun run perf report               the three as Markdown, for the job summary and the PR comment
// The pages sit behind the password gate: the commands sign in with the
// session cookie ARMADA_DASHBOARD_PASSWORD gives (lib/auth.ts). Results go to
// .perf/ (gitignored); a command exits 1 when a budget breaks.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { issueSession, SESSION_COOKIE } from "../lib/auth";

const ROOT = resolve(import.meta.dir, "..");
const BUDGETS_FILE = join(ROOT, "perf/budgets.json");
const OUT = join(ROOT, ".perf");

// ---------------------------------------------------------------------- budgets

export type FormFactor = "mobile" | "desktop";
export type PageMetric = "performance" | "accessibility" | "best-practices" | "lcp" | "cls" | "tbt";
export type Metric = PageMetric | "inp";

export interface Budget {
  metric: PageMetric;
  min?: number;
  max?: number;
  /** Only for this form factor; both when absent. */
  formFactor?: FormFactor;
  /** A warning is reported and does not fail the check. */
  level?: "error" | "warn";
}

export interface Budgets {
  lighthouse: {
    pages: string[];
    runs: Record<FormFactor, number>;
    /** Mobile's CPU slowdown: Lighthouse's and PageSpeed Insights' standard 4×, on any machine. */
    cpuSlowdown: number;
    budgets: Budget[];
  };
  inp: { maxMs: number; cpuSlowdown: number };
  bundles: { tolerance: number; routes: Record<string, number> };
}

export const readBudgets = async (): Promise<Budgets> => JSON.parse(await readFile(BUDGETS_FILE, "utf8"));

// ---------------------------------------------------------------------- bundles

export interface RouteStats {
  route: string;
  firstLoadChunkPaths: string[];
}

export interface BundleRow {
  route: string;
  bytes: number;
  baseline: number | null;
  limit: number | null;
  ok: boolean;
}

/** Each route's first-load JS, gzipped: the sum of its chunks, each counted once. */
export function routeBytes(stats: RouteStats[], gzipped: (path: string) => number): Record<string, number> {
  const sizes = new Map<string, number>();
  const size = (path: string) => {
    if (!sizes.has(path)) sizes.set(path, gzipped(path));
    return sizes.get(path) as number;
  };
  return Object.fromEntries(
    stats.map((r) => [r.route, [...new Set(r.firstLoadChunkPaths)].reduce((sum, p) => sum + size(p), 0)]),
  );
}

/** A route over its baseline plus the tolerance breaks the budget; a route without a baseline too. */
export function checkBundles(measured: Record<string, number>, budget: Budgets["bundles"]): BundleRow[] {
  return Object.entries(measured)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([route, bytes]) => {
      const baseline = budget.routes[route] ?? null;
      const limit = baseline === null ? null : Math.round(baseline * (1 + budget.tolerance));
      return { route, bytes, baseline, limit, ok: limit !== null && bytes <= limit };
    });
}

// ---------------------------------------------------------------------- Lighthouse

export interface PageResult {
  page: string;
  formFactor: FormFactor;
  performance: number;
  accessibility: number;
  "best-practices": number;
  lcp: number;
  cls: number;
  tbt: number;
}

export interface Breach {
  where: string;
  metric: Metric;
  value: number;
  limit: number;
  level: "error" | "warn";
}

interface Lhr {
  categories: Record<string, { score: number | null }>;
  audits: Record<string, { numericValue?: number }>;
  environment: { benchmarkIndex: number };
}

/** The numbers a run gives: scores out of 100, LCP and TBT in ms, CLS as Lighthouse shows it (3 decimals). */
export function resultOf(lhr: Lhr, page: string, formFactor: FormFactor): PageResult {
  const score = (c: string) => Math.round((lhr.categories[c]?.score ?? 0) * 100);
  const value = (a: string) => lhr.audits[a]?.numericValue ?? Number.NaN;
  return {
    page,
    formFactor,
    performance: score("performance"),
    accessibility: score("accessibility"),
    "best-practices": score("best-practices"),
    lcp: Math.round(value("largest-contentful-paint")),
    cls: Math.round(value("cumulative-layout-shift") * 1000) / 1000,
    tbt: Math.round(value("total-blocking-time")),
  };
}

/** A layout shift of a run's trace (scripts/perf-lighthouse.mjs): when, how much, and the nodes it moved. */
export interface TraceShift {
  ms: number;
  score: number;
  input: boolean;
  nodes: { node: string; before: number[]; after: number[] }[];
}

/**
 * What moved, in the log: a layout shift is easier to fix once named. Each
 * shift with its nodes' boxes (x, y, width, height) before and after; a box
 * that grows in place is content that arrived late (THE-982).
 */
export function shiftLines(shifts: TraceShift[], formFactor: FormFactor, page: string): string[] {
  return shifts
    .filter((s) => s.score > 0)
    .map(
      (s) =>
        `  shift ${formFactor} ${page} ${s.score.toFixed(5)} at ${s.ms} ms${s.input ? " (after input)" : ""}: ${s.nodes
          .map((n) => `${n.node} [${n.before.join(",")}] -> [${n.after.join(",")}]`)
          .join(" | ")}`,
    );
}

/** The run of median performance (the lower one of an even count). */
export function medianRun(runs: PageResult[]): PageResult {
  const sorted = [...runs].sort((a, b) => a.performance - b.performance || b.lcp - a.lcp);
  return sorted[Math.floor((sorted.length - 1) / 2)] as PageResult;
}

export function checkPages(results: PageResult[], budgets: Budget[]): Breach[] {
  return results.flatMap((r) =>
    budgets
      .filter((b) => !b.formFactor || b.formFactor === r.formFactor)
      .flatMap((b): Breach[] => {
        const value = r[b.metric];
        const under = b.min !== undefined && value < b.min;
        const over = b.max !== undefined && value > b.max;
        if (!under && !over) return [];
        const limit = (under ? b.min : b.max) as number;
        return [{ where: `${r.page} (${r.formFactor})`, metric: b.metric, value, limit, level: b.level ?? "error" }];
      }),
  );
}

// ---------------------------------------------------------------------- INP

export interface Interaction {
  name: string;
  /** The interaction's longest event, ms (Event Timing: input to next paint), median of its runs; 0 under 16 ms. */
  ms: number;
}

export const checkInteractions = (measured: Interaction[], maxMs: number): Breach[] =>
  measured
    .filter((i) => i.ms > maxMs)
    .map((i): Breach => ({ where: i.name, metric: "inp", value: i.ms, limit: maxMs, level: "error" }));

// ---------------------------------------------------------------------- report

export const REPORT_MARKER = "<!-- armada-perf -->";

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const METRIC_NAME: Record<Metric, string> = {
  performance: "performance",
  accessibility: "accessibility",
  "best-practices": "best practices",
  lcp: "LCP",
  cls: "CLS",
  tbt: "TBT",
  inp: "INP",
};
const shown = (metric: Metric, v: number) =>
  metric === "lcp" || metric === "tbt" || metric === "inp" ? `${v} ms` : metric === "cls" ? v.toFixed(3) : String(v);

export interface Report {
  lighthouse?: { slowdown: number; benchmarkIndex: number; results: PageResult[]; breaches: Breach[] };
  bundles?: BundleRow[];
  inp?: { slowdown: number; interactions: Interaction[]; maxMs: number; breaches: Breach[] };
}

/** The PR comment and job summary: every number, then what broke. */
export function markdown(report: Report): string {
  const lines = [REPORT_MARKER, "## Dashboard performance", ""];
  const failed: string[] = [];
  const warned: string[] = [];
  const lh = report.lighthouse;
  if (lh) {
    const cell = (r: PageResult | undefined, lcp: boolean) =>
      r
        ? `${r.performance} · ${r.accessibility} · ${r["best-practices"]}${lcp ? ` · ${(r.lcp / 1000).toFixed(2)} s` : ""} · ${r.cls.toFixed(3)}`
        : "—";
    lines.push(
      `**Lighthouse** (median of the runs; mobile CPU ${lh.slowdown}× on a machine of benchmark index ${Math.round(lh.benchmarkIndex)})`,
      "",
      "| Page | Mobile: perf · a11y · BP · LCP · CLS | Desktop: perf · a11y · BP · CLS |",
      "|---|---|---|",
    );
    for (const page of [...new Set(lh.results.map((r) => r.page))]) {
      const of = (f: FormFactor) => lh.results.find((r) => r.page === page && r.formFactor === f);
      lines.push(`| \`${page}\` | ${cell(of("mobile"), true)} | ${cell(of("desktop"), false)} |`);
    }
    lines.push("");
    for (const b of lh.breaches)
      (b.level === "warn" ? warned : failed).push(
        `${b.where}: ${METRIC_NAME[b.metric]} ${shown(b.metric, b.value)}, budget ${b.metric === "lcp" || b.metric === "cls" || b.metric === "tbt" ? "≤" : "≥"} ${shown(b.metric, b.limit)}`,
      );
  }
  if (report.bundles) {
    lines.push(
      "**First-load JS per route** (gzip; budget: baseline + 5%)",
      "",
      "| Route | Size | Budget |",
      "|---|---|---|",
    );
    for (const r of report.bundles) {
      lines.push(
        `| \`${r.route}\` | ${kb(r.bytes)} | ${r.limit === null ? "none" : kb(r.limit)}${r.ok ? "" : " ❌"} |`,
      );
      if (!r.ok)
        failed.push(
          r.limit === null
            ? `${r.route}: no JS budget yet (bun run perf bundles --update)`
            : `${r.route}: ${kb(r.bytes)} of first-load JS, budget ${kb(r.limit)}`,
        );
    }
    lines.push("");
  }
  const inp = report.inp;
  if (inp) {
    lines.push(
      `**Interactions** (input to next paint, CPU ${inp.slowdown}× slower; budget ${inp.maxMs} ms)`,
      "",
      "| Interaction | Median of 5 |",
      "|---|---|",
    );
    for (const i of inp.interactions) lines.push(`| ${i.name} | ${i.ms ? `${i.ms} ms` : "< 16 ms"} |`);
    lines.push("");
    for (const b of inp.breaches) failed.push(`${b.where}: ${b.value} ms, budget ${b.limit} ms`);
  }
  if (failed.length) lines.push("**Broken budgets**", "", ...failed.map((f) => `- ❌ ${f}`), "");
  if (warned.length) lines.push("**Warnings** (not failing yet)", "", ...warned.map((w) => `- ⚠️ ${w}`), "");
  if (!failed.length) lines.push("Every budget holds.", "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------- commands

const sessionCookie = () => {
  const password = process.env.ARMADA_DASHBOARD_PASSWORD;
  if (!password) throw new Error("ARMADA_DASHBOARD_PASSWORD is required: the pages sit behind the password gate");
  return `${SESSION_COOKIE}=${issueSession(password, Date.now())}`;
};

async function save(name: string, value: unknown) {
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function load<T>(name: string): Promise<T | undefined> {
  return readFile(join(OUT, name), "utf8").then(
    (text) => JSON.parse(text) as T,
    () => undefined,
  );
}

async function bundles(update: boolean): Promise<boolean> {
  const budgets = await readBudgets();
  const stats: RouteStats[] = JSON.parse(
    await readFile(join(ROOT, ".next/diagnostics/route-bundle-stats.json"), "utf8"),
  );
  const { readFileSync } = await import("node:fs");
  const measured = routeBytes(stats, (p) => gzipSync(readFileSync(join(ROOT, p)), { level: 9 }).length);
  if (update) {
    budgets.bundles.routes = Object.fromEntries(Object.entries(measured).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(BUDGETS_FILE, `${JSON.stringify(budgets, null, 2)}\n`);
    // In the repository's format, so `bun run verify` stays green.
    spawnSync("bunx", ["biome", "format", "--write", BUDGETS_FILE], { cwd: ROOT, stdio: "ignore" });
  }
  const rows = checkBundles(measured, budgets.bundles);
  await save("bundles.json", rows);
  for (const r of rows)
    console.log(
      `${r.ok ? "ok  " : "OVER"} ${r.route.padEnd(28)} ${kb(r.bytes).padStart(9)}  budget ${r.limit ? kb(r.limit) : "none"}`,
    );
  return rows.every((r) => r.ok);
}

/**
 * Each page read twice before it is measured: a fresh demo database has no
 * reading of Linear and GitHub yet, and the first read makes it after it answers.
 */
async function warm(base: string, pages: string[], cookie: string) {
  for (const round of [1, 2]) {
    for (const page of pages)
      await fetch(`${base}${page}`, { headers: { cookie } })
        .then((r) => r.arrayBuffer())
        .catch(() => undefined);
    if (round === 1) await new Promise((done) => setTimeout(done, 2000));
  }
}

const require = createRequire(import.meta.url);
const lighthouseDir = () => dirname(require.resolve("lighthouse/package.json"));

/** One Lighthouse run in Node (scripts/perf-lighthouse.mjs), with the throttling of perf/budgets.json. */
async function lighthouseRun(url: string, formFactor: FormFactor, slowdown: number, cookie: string): Promise<Lhr> {
  await mkdir(OUT, { recursive: true });
  const config = join(OUT, `lighthouse-${formFactor}.config.mjs`);
  const out = join(OUT, "run.json");
  const preset = formFactor === "mobile" ? "mobileSlow4G" : "desktopDense4G";
  // Measured, not simulated: the pages render on the server, and Lantern's
  // estimate counts every script requested before the first paint into LCP.
  // The page polls every 5 s, never quiet for the 5.25 s Lighthouse waits for
  // under real throttling: it stops waiting after 15 s instead of 45.
  await writeFile(
    config,
    `import { screenEmulationMetrics, throttling, userAgents } from ${JSON.stringify(join(lighthouseDir(), "core/config/constants.js"))};
export default {
  extends: "lighthouse:default",
  settings: {
    formFactor: "${formFactor}",
    screenEmulation: screenEmulationMetrics.${formFactor},
    emulatedUserAgent: userAgents.${formFactor},
    throttlingMethod: "devtools",
    throttling: { ...throttling.${preset}, cpuSlowdownMultiplier: ${slowdown} },
    maxWaitForLoad: 15000,
    onlyCategories: ["performance", "accessibility", "best-practices"],
  },
};
`,
  );
  const run = spawnSync("node", [join(ROOT, "scripts/perf-lighthouse.mjs"), url, config, cookie, out], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (run.status !== 0) throw new Error(`Lighthouse failed on ${url} (${formFactor})`);
  return JSON.parse(await readFile(out, "utf8"));
}

async function lighthouse(base: string): Promise<boolean> {
  const { lighthouse: config } = await readBudgets();
  // ARMADA_PERF_PAGES="/ /landing" measures only these, to iterate on one page.
  const only = process.env.ARMADA_PERF_PAGES?.split(/\s+/).filter(Boolean);
  if (only?.length) config.pages = config.pages.filter((p) => only.includes(p));
  const cookie = sessionCookie();
  await warm(base, config.pages, cookie);
  // ARMADA_PERF_CPU=5 slows the CPU down more, to see the margin (docs/performance.md).
  const slowdown = Number(process.env.ARMADA_PERF_CPU) || config.cpuSlowdown;
  // A first run warms Chrome, and says how fast this machine is.
  const first = await lighthouseRun(`${base}/landing`, "mobile", slowdown, cookie);
  const benchmarkIndex = first.environment.benchmarkIndex;
  console.log(`benchmark index ${Math.round(benchmarkIndex)}: mobile CPU ${slowdown}× slower`);
  const results: PageResult[] = [];
  for (const formFactor of ["mobile", "desktop"] as const)
    for (const page of config.pages) {
      const runs: PageResult[] = [];
      for (let k = 0; k < config.runs[formFactor]; k++) {
        const lhr = await lighthouseRun(`${base}${page}`, formFactor, formFactor === "mobile" ? slowdown : 1, cookie);
        runs.push(resultOf(lhr, page, formFactor));
        const shifts: TraceShift[] = JSON.parse(await readFile(join(OUT, "run.shifts.json"), "utf8"));
        for (const line of shiftLines(shifts, formFactor, page)) console.log(line);
      }
      const r = medianRun(runs);
      results.push(r);
      console.log(
        `${formFactor.padEnd(7)} ${page.padEnd(20)} perf ${r.performance} a11y ${r.accessibility} bp ${r["best-practices"]} LCP ${r.lcp} ms CLS ${r.cls} TBT ${r.tbt} ms`,
      );
    }
  const breaches = checkPages(results, config.budgets);
  await save("lighthouse.json", { slowdown, benchmarkIndex, results, breaches });
  for (const b of breaches) console.log(`${b.level === "warn" ? "warn" : "FAIL"} ${b.where} ${b.metric} ${b.value}`);
  return breaches.every((b) => b.level === "warn");
}

async function inp(base: string): Promise<boolean> {
  const { inp: config } = await readBudgets();
  const { INP_PAGES, measureInteractions } = await import("./perf-inp");
  const cookie = sessionCookie();
  await warm(base, INP_PAGES, cookie);
  const interactions = await measureInteractions(base, cookie, config.cpuSlowdown);
  const breaches = checkInteractions(interactions, config.maxMs);
  await save("inp.json", { slowdown: config.cpuSlowdown, interactions, maxMs: config.maxMs, breaches });
  for (const i of interactions) console.log(`${i.ms > config.maxMs ? "SLOW" : "ok  "} ${i.name}: ${i.ms} ms`);
  return breaches.length === 0;
}

async function report(): Promise<boolean> {
  const r: Report = {
    lighthouse: await load("lighthouse.json"),
    bundles: await load("bundles.json"),
    inp: await load("inp.json"),
  };
  const text = markdown(r);
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.md"), text);
  console.log(text);
  return true;
}

if (import.meta.main) {
  const [command, arg] = process.argv.slice(2);
  const base = (arg ?? "http://localhost:4822").replace(/\/$/, "");
  const run =
    command === "bundles"
      ? () => bundles(arg === "--update")
      : command === "lighthouse"
        ? () => lighthouse(base)
        : command === "inp"
          ? () => inp(base)
          : command === "report"
            ? report
            : null;
  if (!run) {
    console.error("usage: bun run perf bundles [--update] | lighthouse <url> | inp <url> | report");
    process.exit(2);
  }
  process.exit((await run()) ? 0 : 1);
}
