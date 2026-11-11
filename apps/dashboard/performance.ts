/** Read-only browser/bundle probe. Env-based auth input, no token/body/URL output. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { type BrowserContext, chromium } from "@playwright/test";

const samples = Number(process.env.DASHBOARD_PERF_SAMPLES ?? 5);
const path = process.env.DASHBOARD_PERF_PATH ?? "/login";
const mock = process.env.DASHBOARD_PERF_MOCK === "1";
function parseOrigin(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error("Invalid measurement origin");
  }
}
const origin = parseOrigin(process.env.DASHBOARD_PERF_URL ?? "http://127.0.0.1:3118");
const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname);
if (!Number.isInteger(samples) || samples < 1 || samples > 100) throw new Error("Invalid sample count");
if (
  !["http:", "https:"].includes(origin.protocol) ||
  origin.username ||
  origin.password ||
  origin.search ||
  origin.hash ||
  origin.pathname !== "/" ||
  (!loopback && origin.protocol !== "https:") ||
  (mock && !loopback)
)
  throw new Error("Invalid staging origin");
if (
  [
    "armada.thevibecompany.co",
    "armada.thevibecompany.com",
    "armada-dashboard.vercel.app",
    "armada-mcp-production.up.railway.app",
  ].includes(origin.hostname.toLowerCase().replace(/\.+$/, ""))
)
  throw new Error("Production origin refused");
if (
  !/^\/(login|sandboxes|environments|harness|tools|settings|skills|templates|variables|orgs)(\/[a-z0-9-]+)?$/i.test(
    path,
  )
)
  throw new Error("Unsupported measurement path");
const state = process.env.DASHBOARD_STORAGE_STATE;
const mockOrigin = parseOrigin(process.env.DASHBOARD_PERF_MOCK_URL ?? "http://127.0.0.1:54418");
if (mock && !["127.0.0.1", "localhost", "[::1]"].includes(mockOrigin.hostname))
  throw new Error("Mock must be loopback");
const routes = ["login", "(app)/sandboxes", "(app)/sandboxes/[id]"];

function summary(values: number[]) {
  values = values.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  return values.length
    ? {
        samples: values.length,
        p50: values[Math.ceil(values.length * 0.5) - 1],
        p95: values[Math.ceil(values.length * 0.95) - 1],
      }
    : { samples: 0 };
}
async function bundles() {
  const result: Record<string, object> = {};
  for (const route of routes) {
    try {
      const text = await readFile(
        join(import.meta.dir, ".next/server/app", route, "page_client-reference-manifest.js"),
        "utf8",
      );
      const match = /globalThis\.__RSC_MANIFEST\["[^"\n]+"\] = (\{[\s\S]*\});?\s*$/.exec(text);
      if (!match?.[1]) throw new Error("Unsupported build manifest");
      const manifest = JSON.parse(match[1]) as {
        entryJSFiles: Record<string, string[]>;
        entryCSSFiles: Record<string, { path: string }[]>;
      };
      const js = new Set(Object.values(manifest.entryJSFiles).flat());
      const css = new Set(
        Object.values(manifest.entryCSSFiles)
          .flat()
          .map((item) => item.path),
      );
      const sizes = async (files: Set<string>) => {
        let raw = 0,
          gzip = 0;
        for (const file of files) {
          if (!/^static\/chunks\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(file)) throw new Error("Unexpected asset path");
          const bytes = await readFile(join(import.meta.dir, ".next", file));
          raw += bytes.length;
          gzip += gzipSync(bytes, { level: 9 }).length;
        }
        return { assets: files.size, raw, gzip };
      };
      result[route] = { available: true, js: await sizes(js), css: await sizes(css) };
    } catch {
      result[route] = { available: false };
    }
  }
  return result;
}
async function main() {
  const report: Record<string, unknown> = {
    schema: 1,
    runtime: Bun.version,
    platform: process.platform,
    samples,
    warmups: 2,
    mock,
    viewport: { width: 390, height: 844 },
    bundle: await bundles(),
  };
  if (process.env.DASHBOARD_PERF_BUNDLE_ONLY === "1") {
    console.log(JSON.stringify(report));
    return;
  }
  // Do not inherit CLI/provider credentials into the browser process.
  const browser = await chromium.launch({
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: "C.UTF-8" },
  });
  report.browserVersion = browser.version();
  const deadline = setTimeout(() => {
    void browser.close().catch(() => {});
  }, 170_000);
  deadline.unref();
  try {
    let saved: Awaited<ReturnType<BrowserContext["storageState"]>> | undefined;
    if (state) {
      const supplied = JSON.parse(await readFile(state, "utf8")) as Awaited<ReturnType<BrowserContext["storageState"]>>;
      saved = {
        cookies: supplied.cookies.filter((cookie) => {
          const domain = cookie.domain.replace(/^\./, "");
          return origin.hostname === domain || origin.hostname.endsWith(`.${domain}`);
        }),
        origins: supplied.origins.filter((entry) => entry.origin === origin.origin),
      };
    }
    if (mock && !saved) {
      const context = await browser.newContext({ baseURL: origin.origin });
      const page = await context.newPage();
      await page.goto("/login");
      await page.getByLabel("Email").fill("alice@example.com");
      await page.getByRole("button", { name: "Email me a sign-in link" }).click();
      await page.getByLabel("Code").fill("123456");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL("**/sandboxes");
      saved = await context.storageState();
      await context.close();
    }
    const values: Record<string, number[]> = {};
    const record = (name: string, value: number | undefined) => {
      if (value !== undefined && Number.isFinite(value)) (values[name] ??= []).push(value);
    };
    const waterfall: Record<string, { startMs: number[]; durationMs: number[] }> = {};
    let matched = true,
      delayMs = 0,
      directoryDelayMs = 0;
    for (let i = 0; i < samples + 2; i++) {
      const context = await browser.newContext({
        baseURL: origin.origin,
        viewport: { width: 390, height: 844 },
        ...(saved ? { storageState: saved } : {}),
      });
      try {
        const page = await context.newPage();
        await page.route("**/*", (route) => {
          const url = new URL(route.request().url());
          if (
            url.pathname.startsWith("/orchestrators") ||
            url.pathname.startsWith("/api/v1/orchestrators") ||
            (route.request().isNavigationRequest() && url.origin !== origin.origin)
          )
            return route.abort();
          return route.continue();
        });
        if (mock) await fetch(new URL("/__test/perf", mockOrigin), { method: "POST", body: '{"reset":true}' });
        const start = performance.now();
        const response = await page.goto(path, { waitUntil: "commit", timeout: 20_000 });
        await page.getByRole("heading", { level: 1 }).first().waitFor({ state: "visible", timeout: 20_000 });
        const ready = performance.now() - start;
        await page.waitForLoadState("load");
        await page
          .waitForFunction(() => performance.getEntriesByName("first-contentful-paint").length > 0, undefined, {
            timeout: 5000,
          })
          .catch(() => {});
        if (response?.status() !== 200 || new URL(page.url()).pathname !== path) {
          matched = false;
          break;
        }
        let conversationReady: number | undefined;
        const transcript = page.getByRole("log", { name: "Messages", exact: true });
        if (path.startsWith("/sandboxes/") && (await transcript.count())) {
          await page
            .getByTestId("history-loading")
            .waitFor({ state: "hidden", timeout: 10_000 })
            .catch(() => {});
          if (
            (await transcript.locator("[data-chat-item]").count()) ||
            (await transcript.getByText("No messages yet.", { exact: true }).count())
          )
            conversationReady = performance.now() - start;
        }
        const metrics = await page.evaluate(() => {
          const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
          const fcp = performance.getEntriesByName("first-contentful-paint")[0];
          const scripts = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter(
            (r) => r.initiatorType === "script",
          );
          return {
            responseStartMs: nav?.responseStart,
            responseEndMs: nav?.responseEnd,
            domReadyMs: nav?.domContentLoadedEventEnd,
            loadMs: nav?.loadEventEnd,
            firstContentfulPaintMs: fcp?.startTime,
            scriptEncodedBytes: scripts.reduce((sum, r) => sum + r.encodedBodySize, 0),
            scriptDecodedBytes: scripts.reduce((sum, r) => sum + r.decodedBodySize, 0),
          };
        });
        if (i >= 2) {
          record("headingReadyMs", ready);
          record("conversationReadyMs", conversationReady);
          for (const [name, value] of Object.entries(metrics)) record(name, value);
          if (mock) {
            const trace = (await (await fetch(new URL("/__test/perf", mockOrigin))).json()) as {
              delayMs: number;
              directoryDelayMs: number;
              events: { table: string; startMs: number; durationMs: number }[];
            };
            delayMs = trace.delayMs;
            directoryDelayMs = trace.directoryDelayMs;
            const first = new Map<string, { startMs: number; durationMs: number }>();
            for (const event of trace.events.sort((a, b) => a.startMs - b.startMs))
              if (
                ["orgs", "members", "sandboxes", "goldens", "credentials", "directory", "connections"].includes(
                  event.table,
                ) &&
                !first.has(event.table)
              )
                first.set(event.table, event);
            const t0 = Math.min(...[...first.values()].map((event) => event.startMs));
            for (const [table, event] of first) {
              const row = (waterfall[table] ??= { startMs: [], durationMs: [] });
              row.startMs.push(event.startMs - t0);
              row.durationMs.push(event.durationMs);
            }
          }
        }
        if (mock && i === samples + 1 && process.env.DASHBOARD_PERF_SCREENSHOT)
          await page.screenshot({ path: process.env.DASHBOARD_PERF_SCREENSHOT, fullPage: true });
      } finally {
        await context.close();
      }
    }
    report.matchedRoute = matched;
    report.metrics = Object.fromEntries(Object.entries(values).map(([key, nums]) => [key, summary(nums)]));
    if (mock)
      report.mockBackend = {
        delayMs,
        directoryDelayMs,
        waterfall: Object.fromEntries(
          Object.entries(waterfall).map(([key, row]) => [
            key,
            { startMs: summary(row.startMs), durationMs: summary(row.durationMs) },
          ]),
        ),
      };
    console.log(JSON.stringify(report));
    if (!matched) process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    await browser.close();
  }
}
await main().catch(() => {
  console.error("Dashboard probe failed; details suppressed to protect session data.");
  process.exitCode = 1;
});
