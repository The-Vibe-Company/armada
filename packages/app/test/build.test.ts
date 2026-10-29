import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { type Browser, chromium, type Page } from "playwright-core";
import { type DevDaemon, SAMPLE_PROJECTS, sampleEvents, startDevDaemon } from "../scripts/dev-daemon";

// The built app, as a browser loads it: its first-load JS under the package's
// budget (perf-budget.json), then opened in Chromium from armadad's own server
// (on a synthetic log, on localhost) to show the fleet by state, live.

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

describe("in a browser, served by a running daemon", () => {
  let daemon: DevDaemon;
  let browser: Browser | undefined;
  let page: Page;

  beforeAll(async () => {
    // armadad's own server on a synthetic log, serving this build: the app finds it at its own origin.
    daemon = await startDevDaemon({ staticDir: out, events: sampleEvents(new Date().toISOString()) });
    // Use the headless shell pinned to Playwright, installed before the suite.
    browser = await chromium.launch({ timeout: 15_000 });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  }, 20_000);
  afterAll(async () => {
    await browser?.close();
    await daemon?.stop();
  }, 10_000);

  test("saves the coordinator provider once and remembers it after reload without storing a browser credential", async () => {
    await page.goto(`${daemon.url}#/settings`);
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

  test("shows every project a squadron in the hangar, each the link to its fleet by state, in Geist", async () => {
    await page.goto(daemon.url);
    const sidebar = page.getByRole("complementary", { name: "Sidebar" });
    const projects = sidebar.getByRole("navigation", { name: "Projects" });
    // A project's count shows once its folded state arrived.
    for (const name of [/Harbor 4 sessions/, /Lantern 2 sessions/, /Tidewater 0 sessions/])
      await projects.getByRole("link", { name }).waitFor({ timeout: 5_000 });
    const rows = await projects.getByRole("link").allInnerTexts();
    expect(rows.map((r) => r.replace(/\s+/g, " ").trim())).toEqual([
      "Harbor 4 sessions in flight",
      "Lantern 2 sessions in flight",
      "Tidewater 0 sessions in flight",
    ]);
    expect(rows).toHaveLength(SAMPLE_PROJECTS.length);
    await expect(sidebar.getByRole("status").innerText()).resolves.toBe("Live");
    await expect(sidebar.getByRole("link", { name: "Hangar" }).getAttribute("aria-current")).resolves.toBe("page");
    await expect(sidebar.getByRole("link", { name: "Settings" }).getAttribute("href")).resolves.toBe("#/settings");

    // The hangar: the fleet's facts on one line, then a squadron per project, each one link into its room.
    const main = page.getByRole("main");
    await main.locator("[data-squadron]").first().waitFor({ timeout: 5_000 });
    await expect(main.locator("header").innerText()).resolves.toMatch(/^Hangar\s+6\s+agents in flight/);
    const squadrons = await main
      .locator("[data-squadron]")
      .evaluateAll((links) =>
        links.map((a) => [a.getAttribute("href"), a.querySelector("[data-counts]")?.textContent?.trim()]),
      );
    expect(squadrons).toEqual([
      [
        "#/projects/harbor",
        "4 in flight · 1 on their own · 1 blocked · 1 waiting for you · 1 ready to merge · 1 merged today",
      ],
      ["#/projects/lantern", "2 in flight · 1 blocked · 1 waiting for you"],
      ["#/projects/tidewater", "0 in flight"],
    ]);
    const anatomy = await page.evaluate(() => ({
      h1: [...document.querySelectorAll("h1")].map((h) => ({
        text: h.textContent,
        inHeader: h.parentElement?.tagName,
      })),
      fonts: [...new Set([...document.querySelectorAll("body *")].map((e) => getComputedStyle(e).fontFamily))],
    }));
    expect(anatomy.h1).toEqual([{ text: "Hangar", inHeader: "HEADER" }]);
    for (const family of anatomy.fonts) expect(family).toMatch(/^"?Geist( Mono)?"?,/);

    // Entering Harbor's room: its fleet by state, under the v7 title.
    await main.getByRole("link", { name: /^Harbor/ }).click();
    await page.waitForURL(/#\/projects\/harbor$/);
    const groups = main.locator('h2[id^="fleet-"]');
    await groups.first().waitFor({ timeout: 5_000 });
    expect((await groups.allInnerTexts()).map((h) => h.split("\n")[0])).toEqual([
      "Blocked",
      "Waiting for your decision",
      "In progress",
      "Ready to merge",
      "Merged today",
    ]);
    await expect(projects.getByRole("link", { name: /Harbor/ }).getAttribute("aria-current")).resolves.toBe("page");
    const title = await page.evaluate(() =>
      [...document.querySelectorAll("h1")].map((h) => ({ text: h.textContent, size: getComputedStyle(h).fontSize })),
    );
    expect(title).toEqual([{ text: "Harbor", size: "22px" }]);
    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, ""));
    });
    expect(loaded).toContain("Geist");
    expect(loaded.filter((f) => f !== "Geist" && f !== "Geist Mono")).toEqual([]);
  });

  test("a state change over the subscription glides the same row to its new group, without a reload", async () => {
    const row = page.locator('[data-row="harbor/HAR-12"]');
    await row.and(page.locator('[data-group="running"]')).waitFor({ timeout: 5_000 });
    const before = await row.evaluate((el) => {
      (window as { unreloaded?: boolean }).unreloaded = true;
      (el as { kept?: boolean }).kept = true;
      // Watch the row's transform on each frame from its next change of state: a glide moves it there.
      const moves: string[] = [];
      new MutationObserver(() => {
        let frames = 0;
        const sample = () => {
          moves.push(getComputedStyle(el).transform);
          if (++frames < 30) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }).observe(el, { attributeFilter: ["data-group"] });
      (window as { moves?: string[] }).moves = moves;
      return el.getBoundingClientRect().top;
    });
    daemon.append({
      project: "harbor",
      kind: "session.reported",
      at: new Date().toISOString(),
      actor: "worker",
      payload: { ticket: "HAR-12", session: "s-har-12-1", phase: "blocked", reason: "Waiting for the tide tables" },
    });
    await row.and(page.locator('[data-group="blocked"]')).waitFor({ timeout: 5_000 });
    await expect(row.locator("[data-reason]").innerText()).resolves.toBe("Blocked: Waiting for the tide tables");
    await expect(row.locator("[data-reason]").getAttribute("class")).resolves.toContain("text-red");
    await page.waitForFunction(() => ((window as { moves?: string[] }).moves?.length ?? 0) >= 30);
    const after = await row.evaluate((el) => ({
      kept: (el as { kept?: boolean }).kept === true,
      unreloaded: (window as { unreloaded?: boolean }).unreloaded === true,
      top: el.getBoundingClientRect().top,
      moves: (window as { moves?: string[] }).moves ?? [],
    }));
    // The same element, on the same page: no remount, no reload.
    expect(after.kept).toBe(true);
    expect(after.unreloaded).toBe(true);
    // Up into Blocked, and on its way it was carried by a transform that then let go.
    expect(after.top).toBeLessThan(before);
    expect(after.moves.some((t) => t !== "none" && !/^matrix\(1, 0, 0, 1, 0, 0\)$/.test(t))).toBe(true);
    expect(after.moves.at(-1)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    // And a claim reaches the sidebar's count, and the list of its project.
    daemon.append({
      project: "tidewater",
      kind: "session.claimed",
      at: new Date().toISOString(),
      actor: "worker",
      payload: { ticket: "TID-1", session: "s-tid-1", generation: 1, owner: "default", runtime: "local", handle: "h" },
    });
    const tidewater = page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: /Tidewater\s+1/ });
    await tidewater.waitFor({ timeout: 5_000 });
    await tidewater.click();
    await page.locator('[data-row="tidewater/TID-1"][data-group="running"]').waitFor({ timeout: 5_000 });
  });
});
