import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { type Browser, chromium, type Page } from "playwright-core";
import { type FakeDaemon, SAMPLE_PROJECTS, startFakeDaemon } from "../scripts/fake-daemon";

// The built app, as a browser loads it: its first-load JS under the package's
// budget (perf-budget.json), then opened in Chromium against a daemon (the
// fake one, on localhost) to show the sidebar with the projects.

const ROOT = resolve(import.meta.dir, "..");
const budget = JSON.parse(readFileSync(join(ROOT, "perf-budget.json"), "utf8")) as { firstLoadJsGzipKb: number };
const out = mkdtempSync(join(tmpdir(), "armada-app-"));
let html = "";

// The package's own build, in production as `bun run build` runs it (bun test sets NODE_ENV=test).
beforeAll(async () => {
  const run = Bun.spawn(
    [process.execPath, "x", "vite", "build", "--outDir", out, "--emptyOutDir", "--logLevel", "error"],
    {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: "production" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if ((await run.exited) !== 0) throw new Error(`vite build failed: ${await new Response(run.stderr).text()}`);
  html = readFileSync(join(out, "index.html"), "utf8");
}, 60_000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

/** The scripts index.html loads or preloads: what runs before the first paint. */
function firstLoad(page: string): string[] {
  const scripts = [...page.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1] ?? "");
  const preloads = [...page.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)].map((m) => m[1] ?? "");
  return [...scripts, ...preloads];
}

test("first-load JS stays under the package's budget", () => {
  const files = firstLoad(html);
  expect(files.length).toBeGreaterThan(0);
  const bytes = files.reduce((n, f) => n + gzipSync(readFileSync(join(out, f))).length, 0);
  const kb = Math.round((bytes / 1024) * 10) / 10;
  console.log(`first-load JS: ${kb} KB gzipped (budget ${budget.firstLoadJsGzipKb} KB)`);
  expect(kb).toBeLessThan(budget.firstLoadJsGzipKb);
  // Motion's animation features are their own chunk, not part of it.
  expect(files.some((f) => f.includes("motion-features"))).toBe(false);
});

describe("in a browser, against a running daemon", () => {
  let daemon: FakeDaemon;
  let app: ReturnType<typeof Bun.serve>;
  let browser: Browser | undefined;
  let page: Page;

  beforeAll(async () => {
    daemon = startFakeDaemon();
    app = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        const file = Bun.file(join(out, path === "/" ? "index.html" : path));
        return file.size ? new Response(file) : new Response("Not found", { status: 404 });
      },
    });
    // Use the headless shell pinned to Playwright, installed before the suite.
    browser = await chromium.launch({ timeout: 15_000 });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  }, 20_000);
  afterAll(async () => {
    await browser?.close();
    app?.stop(true);
    daemon?.stop();
  }, 10_000);

  test("saves the coordinator provider once and remembers it after reload without storing a browser credential", async () => {
    await page.goto(`http://127.0.0.1:${app.port}/?daemon=${encodeURIComponent(daemon.url)}`);
    const provider = page.getByRole("combobox", { name: "Provider", exact: true });
    await provider.waitFor({ timeout: 5000 });
    const key = randomBytes(24).toString("hex");
    await provider.selectOption("openai");
    await page.getByLabel("API key", { exact: true }).fill(key);
    await page.getByRole("button", { name: "Save key", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "OpenAI connected" }).waitFor({ timeout: 5000 });
    expect(await page.getByLabel("API key", { exact: true }).count()).toBe(0);
    const browserState = await page.evaluate(() =>
      JSON.stringify([localStorage, sessionStorage, document.body.innerHTML]),
    );
    expect(browserState).not.toContain(key);
    await page.reload();
    await page.getByRole("status").filter({ hasText: "OpenAI connected" }).waitFor({ timeout: 5000 });
    expect(await page.getByRole("button", { name: "Save key", exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "Change key", exact: true }).click();
    expect(await page.getByLabel("API key", { exact: true }).inputValue()).toBe("");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("shows the sidebar with the projects and their sessions in flight, in Geist", async () => {
    await page.goto(`http://127.0.0.1:${app.port}/?daemon=${encodeURIComponent(daemon.url)}`);
    const sidebar = page.getByRole("complementary", { name: "Sidebar" });
    const projects = sidebar.getByRole("navigation", { name: "Projects" });
    // A project's count shows once its first frame arrived.
    for (const name of [/Harbor 2 sessions/, /Lantern 1 session/, /Tidewater 0 sessions/])
      await projects.getByRole("link", { name }).waitFor({ timeout: 5_000 });
    const rows = await projects.getByRole("link").allInnerTexts();
    expect(rows.map((r) => r.replace(/\s+/g, " ").trim())).toEqual([
      "Harbor 2 sessions in flight",
      "Lantern 1 session in flight",
      "Tidewater 0 sessions in flight",
    ]);
    expect(rows).toHaveLength(SAMPLE_PROJECTS.length);
    await expect(sidebar.getByRole("status").innerText()).resolves.toBe("Live");

    // A claim on the daemon reaches the sidebar without a reload.
    daemon.append({
      project: "tidewater",
      kind: "session.claimed",
      at: "2026-01-05T10:00:00.000Z",
      actor: "worker",
      payload: { ticket: "TID-1", session: "s-tid-1" },
    });
    await projects.getByRole("link", { name: /Tidewater\s+1/ }).waitFor({ timeout: 5_000 });

    const anatomy = await page.evaluate(() => ({
      h1: [...document.querySelectorAll("h1")].map((h) => ({
        text: h.textContent,
        size: getComputedStyle(h).fontSize,
        inHeader: h.parentElement?.tagName,
      })),
      fonts: [...new Set([...document.querySelectorAll("body *")].map((e) => getComputedStyle(e).fontFamily))],
    }));
    expect(anatomy.h1).toEqual([{ text: "Fleet", size: "22px", inHeader: "HEADER" }]);
    for (const family of anatomy.fonts) expect(family).toMatch(/^"?Geist( Mono)?"?,/);
    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, ""));
    });
    expect(loaded).toContain("Geist");
    expect(loaded.filter((f) => f !== "Geist" && f !== "Geist Mono")).toEqual([]);
  });
});
