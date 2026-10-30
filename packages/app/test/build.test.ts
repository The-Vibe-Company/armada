import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { bootDaemon } from "@armada/daemon";
import { Keychain } from "@armada/daemon/keychain";
import type { PluginCatalogEntry } from "@armada/daemon/plugins/catalog";
import { type DaemonServer, startServer } from "@armada/daemon/server";
import { EventStore } from "@armada/daemon/store";
import { type Browser, chromium, type Page } from "playwright-core";
import { FakeKeychain } from "../../daemon/test/support/keychain";
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
    expect(await provider.locator("option").allTextContents()).toEqual(["Development model"]);
    await provider.selectOption("development-model");
    expect(await page.getByLabel("Model", { exact: true }).getAttribute("required")).not.toBeNull();
    expect(
      await page.getByLabel("Endpoint (if required by your provider)", { exact: true }).getAttribute("required"),
    ).not.toBeNull();
    await page.getByLabel("Model", { exact: true }).fill("local-deployment");
    await page.getByLabel("Endpoint (if required by your provider)", { exact: true }).fill("http://localhost/v1");
    await page.getByLabel("API key", { exact: true }).fill(key);
    await page.getByRole("button", { name: "Save key", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Development model connected" }).waitFor({ timeout: 5000 });
    expect(await page.getByLabel("API key", { exact: true }).count()).toBe(0);
    const browserState = await page.evaluate(() =>
      JSON.stringify([localStorage, sessionStorage, document.body.innerHTML]),
    );
    expect(browserState).not.toContain(key);
    await page.reload();
    await page.getByRole("status").filter({ hasText: "Development model connected" }).waitFor({ timeout: 5000 });
    expect(await page.getByRole("button", { name: "Save key", exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "Change key", exact: true }).click();
    expect(await page.getByLabel("API key", { exact: true }).inputValue()).toBe("");
    expect(await page.getByLabel("Model", { exact: true }).inputValue()).toBe("local-deployment");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("repairs and rotates a key when a same-major daemon does not advertise a model catalog", async () => {
    const store = new EventStore(":memory:");
    const chain = new Keychain(new FakeKeychain());
    await chain.write("coordinator", "coordinator", "{");
    const legacy = await startServer({ store, projects: [], staticDir: out, keychain: chain });
    const tab = await browser?.newPage();
    if (!tab) throw new Error("Browser not started");
    try {
      await tab.goto(`${legacy.url}#/settings`);
      const provider = tab.getByRole("textbox", { name: "Provider", exact: true });
      await provider.waitFor({ timeout: 5000 });
      await tab.getByText("The saved model setting could not be read.", { exact: false }).waitFor();
      await provider.fill("anthropic");
      const first = randomBytes(24).toString("hex");
      await tab.getByLabel("API key", { exact: true }).fill(first);
      await tab.getByRole("button", { name: "Save key", exact: true }).click();
      await tab.getByRole("status").filter({ hasText: "anthropic connected" }).waitFor({ timeout: 5000 });
      expect((await chain.coordinator())?.key === first).toBe(true);
      await tab.reload();
      await tab.getByRole("button", { name: "Change key", exact: true }).click();
      expect(await provider.inputValue()).toBe("anthropic");
      const replacement = randomBytes(24).toString("hex");
      await tab.getByLabel("API key", { exact: true }).fill(replacement);
      await tab.getByRole("button", { name: "Save key", exact: true }).click();
      await tab.getByRole("status").filter({ hasText: "anthropic connected" }).waitFor({ timeout: 5000 });
      expect((await chain.coordinator())?.key === replacement).toBe(true);
      expect(
        await tab.evaluate(() => JSON.stringify([localStorage, sessionStorage, document.body.innerHTML])),
      ).not.toContain(replacement);
    } finally {
      await tab.close();
      await legacy.close();
      store.close();
    }
  }, 10000);

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

    // Entering Harbor's room (THE-1996): its agents by state in the rail, under the v7 title.
    await main.getByRole("link", { name: /^Harbor/ }).click();
    await page.waitForURL(/#\/projects\/harbor$/);
    const groups = main.locator("[data-rail-group]");
    await groups.first().waitFor({ timeout: 5_000 });
    expect(await groups.evaluateAll((all) => all.map((g) => g.getAttribute("data-rail-group")))).toEqual([
      "blocked",
      "you",
      "running",
      "ready",
      "merged",
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
  }, 20_000);

  test("a state change over the subscription glides the same row to its new group, without a reload", async () => {
    // The fleet by state of one project, on its rules page beside the room.
    await page.goto(`${daemon.url}/#/projects/harbor/rules`);
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
    // Its room's rail holds the new agent in progress.
    await page.locator('[data-rail-group="running"] [data-rail-row="TID-1"]').waitFor({ timeout: 5_000 });
  });

  test("a project's room: the band, the pinned question, a message the coordinator answers, kept across a reload", async () => {
    await page.goto(`${daemon.url}/#/projects/harbor`);
    await page.getByRole("heading", { level: 1, name: "Harbor" }).waitFor({ timeout: 5_000 });
    const band = page.locator('[data-sky="band"]');
    await expect(band.evaluate((el) => el.getBoundingClientRect().height)).resolves.toBe(200);
    const card = page.getByRole("region", { name: "A question waiting for you" });
    await card.getByText("Two berth tests time out under the full suite.").waitFor({ timeout: 5_000 });
    const rail = page.getByRole("complementary", { name: "Agents" });
    await rail.getByRole("link", { name: /HAR-15/ }).waitFor({ timeout: 5_000 });
    // The coordinator's own line from the log is there before anything is said.
    await page
      .locator('[data-item="line"]')
      .filter({ hasText: "HAR-9's quays have names" })
      .waitFor({ timeout: 5_000 });

    // A message sent through the protocol: the coordinator's checkpoint brings it back with the answer.
    const field = page.getByLabel("Message", { exact: true });
    await field.fill("Merge HAR-20 first.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const answer = page.locator('[data-item="coordinator"]').filter({ hasText: "Noted: “Merge HAR-20 first.”" });
    await answer.waitFor({ timeout: 10_000 });
    await expect(field.inputValue()).resolves.toBe("");
    await page.locator('[data-item="owner"]').filter({ hasText: "Merge HAR-20 first." }).waitFor();
    // Its tool call is one quiet line, closed until a click opens it.
    const call = page.locator('details[data-tool="fleet.status"]').first();
    await expect(call.evaluate((el) => (el as HTMLDetailsElement).open)).resolves.toBe(false);
    await call.locator("summary").click();
    await expect(call.evaluate((el) => (el as HTMLDetailsElement).open)).resolves.toBe(true);
    await call.getByText("Result").waitFor();

    // Closed and opened again: the same conversation, read from the log.
    await page.reload();
    await answer.waitFor({ timeout: 10_000 });
    await page.locator('[data-item="owner"]').filter({ hasText: "Merge HAR-20 first." }).waitFor();

    // The owner answers the pinned question: the card leaves, the answer joins the conversation.
    await card.getByRole("button", { name: /Fix the wait/ }).click();
    await card.waitFor({ state: "detached", timeout: 5_000 });
    await page
      .locator('[data-item="owner"]')
      .filter({ hasText: "On HAR-15: Fix the wait" })
      .waitFor({ timeout: 10_000 });

    // The rail closes and opens from the facts line.
    await page.getByRole("button", { name: "Close the agents" }).click();
    await rail.waitFor({ state: "detached", timeout: 5_000 });
    await page.getByRole("button", { name: /^Agents/ }).click();
    await rail.waitFor({ timeout: 5_000 });

    const anatomy = await page.evaluate(() => ({
      h1: [...document.querySelectorAll("h1")].map((h) => [h.textContent, getComputedStyle(h).fontSize]),
      fonts: [...new Set([...document.querySelectorAll("body *")].map((e) => getComputedStyle(e).fontFamily))],
      // Type never under 13 px; 12.5 px only in Geist Mono (ids and times).
      small: [...document.querySelectorAll("main *")]
        .filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()))
        .map((e) => getComputedStyle(e))
        .filter(
          (s) => Number.parseFloat(s.fontSize) < 13 && !(s.fontSize === "12.5px" && /Geist Mono/.test(s.fontFamily)),
        )
        .map((s) => `${s.fontSize} ${s.fontFamily}`),
    }));
    expect(anatomy.h1).toEqual([["Harbor", "22px"]]);
    for (const family of anatomy.fonts) expect(family).toMatch(/^"?Geist( Mono)?"?,/);
    expect(anatomy.small).toEqual([]);

    // A rail row opens its session's page (THE-2028).
    await rail.locator('[data-rail-row="HAR-15"]').click();
    await page.getByRole("heading", { level: 1, name: "Price berths by the hour" }).waitFor({ timeout: 5_000 });
    expect(new URL(page.url()).hash).toBe("#/sessions/HAR-15");
  }, 30_000);

  test("every row opens its session's page, by a click or the keyboard, and holds from 900 px up", async () => {
    await page.setViewportSize({ width: 900, height: 800 });
    // A project's fleet list is on its rules page, beside its room (the hangar is the home since THE-2025).
    await page.goto(`${daemon.url}#/projects/harbor/rules`);
    const rows = page.locator("[data-row]");
    await rows.first().waitFor({ timeout: 5_000 });
    // Each row's time is whole at the window's narrowest supported width; the title gives way.
    const clipped = await rows.evaluateAll((els) =>
      els.flatMap((el) => {
        const time = el.lastElementChild as HTMLElement;
        const row = el.getBoundingClientRect();
        const box = time.getBoundingClientRect();
        return time.scrollWidth > time.clientWidth || box.right > row.right ? [el.getAttribute("data-row")] : [];
      }),
    );
    expect(clipped).toEqual([]);
    // The forge reads HAR-15's pull request, with its branch and files.
    daemon.append({
      project: "harbor",
      kind: "pull-request.opened",
      at: new Date().toISOString(),
      actor: "github",
      payload: {
        number: 41,
        ticket: "HAR-15",
        state: "open",
        ci: "failure",
        conflicting: false,
        head: "head-41",
        repository: "example/harbor",
        title: "Price berths by the hour",
        url: "https://example.test/harbor/pull/41",
        headRef: "feature/har-15-price-berths",
        draft: false,
        review: "none",
        checks: [],
        checksComplete: true,
        files: [{ path: "src/berths/price.ts", additions: 42, deletions: 3 }],
      } as never,
    });
    // Opened from a scrolled list, the page starts at its top with the focus on its title.
    await expect(
      page.getByRole("main").evaluate((main) => {
        main.scrollTo(0, 400);
        return main.scrollTop;
      }),
    ).resolves.toBeGreaterThan(0);
    await page.locator('[data-row="harbor/HAR-15"]').click();
    await page.getByRole("heading", { level: 1, name: "Price berths by the hour" }).waitFor({ timeout: 5_000 });
    expect(new URL(page.url()).hash).toBe("#/sessions/HAR-15");
    await expect(page.getByRole("main").evaluate((main) => main.scrollTop)).resolves.toBe(0);
    await expect(page.evaluate(() => document.activeElement?.tagName)).resolves.toBe("H1");
    // The sidebar's Hangar is not the current page on a session's page.
    await expect(
      page
        .getByRole("navigation", { name: "Sections" })
        .getByRole("link", { name: "Hangar" })
        .getAttribute("aria-current"),
    ).resolves.toBeNull();
    await expect(page.getByRole("region", { name: "State" }).getAttribute("data-state")).resolves.toBe("blocked");
    await page.getByText("feature/har-15-price-berths").waitFor({ timeout: 5_000 });
    // A report opens on a click to its whole text.
    const report = page.locator("[data-entry] details").first();
    await report.locator("summary").click();
    await expect(report.getAttribute("open")).resolves.toBe("");
    await page.getByRole("navigation", { name: "Session" }).getByRole("link", { name: /Files/ }).click();
    await page.locator('[data-file="src/berths/price.ts"]').waitFor({ timeout: 5_000 });
    expect(new URL(page.url()).hash).toBe("#/sessions/HAR-15?tab=files");
    // Back to the project's room, then another project's fleet row by the keyboard.
    await page.getByRole("link", { name: "← Harbor" }).click();
    await page.getByRole("heading", { level: 1, name: "Harbor" }).waitFor({ timeout: 5_000 });
    expect(new URL(page.url()).hash).toBe("#/projects/harbor");
    await page.evaluate(() => {
      window.location.hash = "#/projects/lantern/rules";
    });
    await page.getByRole("heading", { level: 1, name: "Lantern" }).waitFor({ timeout: 5_000 });
    await page.locator('[data-row="lantern/LAN-7"]').focus();
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { level: 1, name: "Pick the lanterns' colour" }).waitFor({ timeout: 5_000 });
    await expect(page.getByRole("region", { name: "State" }).getAttribute("data-state")).resolves.toBe("you");
  }, 15_000);
});

describe("the Plugins screen in a browser, on a daemon that restarts", () => {
  // A synthetic catalog booted as armadad boots it; Restart closes the daemon and
  // boots it again on the same port, as the desktop shell does.
  const manifest = (id: string, enabledByDefault: boolean) => ({
    id,
    version: "1.0.0",
    pluginApi: "^0.2.0",
    enabledByDefault,
    description: `The ${id} provider`,
    contributions: {
      tracker: {
        [id]: {
          config: { type: "object", properties: { team: { type: "string" } } },
          secrets: [`${id.toUpperCase()}_TOKEN`],
        },
      },
    },
  });
  const catalog: PluginCatalogEntry[] = [manifest("lamps", true), manifest("buoys", false)].map((m) => ({
    id: m.id,
    manifest: m,
    load: async () => ({
      activate(ctx) {
        ctx.register.tracker(m.id, { read: async () => {}, write: async () => {} });
      },
    }),
  }));
  const dir = mkdtempSync(join(tmpdir(), "armada-app-plugins-"));
  const configPath = join(dir, "config.json");
  const secrets = new Map<string, string>();
  const keychain = new Keychain({
    storage: "os-keychain",
    read: async (service, account) => secrets.get(`${service}/${account}`) ?? null,
    write: async (service, account, value) => {
      secrets.set(`${service}/${account}`, value);
    },
  });
  let running: { daemon: Awaited<ReturnType<typeof bootDaemon>>; server: DaemonServer } | undefined;
  let restarts = 0;
  let browser: Browser | undefined;
  let page: Page;

  async function open(port = 0) {
    const daemon = await bootDaemon({
      databasePath: ":memory:",
      configPath,
      catalog,
      secrets: { get: async () => null },
      log: { info() {}, error() {} },
    });
    const server = await startServer({
      store: daemon.store,
      projects: SAMPLE_PROJECTS,
      port,
      staticDir: out,
      plugins: { configPath, catalog: daemon.catalog, boot: daemon, keychain },
      restart: () => {
        restarts += 1;
        const bound = Number(new URL(server.url).port);
        void close().then(() => open(bound));
      },
    });
    running = { daemon, server };
    return server;
  }
  async function close() {
    await running?.server.close();
    running?.daemon.close();
    running = undefined;
  }

  beforeAll(async () => {
    await open();
    browser = await chromium.launch({ timeout: 15_000 });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  }, 20_000);
  afterAll(async () => {
    await browser?.close();
    await close();
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);

  test("a switch is saved, says to restart, and reads loaded once Restart brought the daemon back", async () => {
    await page.goto(running?.server.url ?? "");
    await page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: "Plugins" }).click();
    const buoys = page.locator('[data-plugin="buoys"]');
    await buoys.locator("[data-state]").filter({ hasText: "Off" }).waitFor({ timeout: 5_000 });
    expect(page.url()).toEndWith("#/plugins");
    await expect(page.locator('[data-plugin="lamps"] [data-state]').innerText()).resolves.toBe("Loaded");

    await page.getByRole("switch", { name: "buoys" }).click();
    await buoys.locator("[data-state]").filter({ hasText: "Restart to apply" }).waitFor({ timeout: 5_000 });
    await expect(page.getByRole("switch", { name: "buoys" }).getAttribute("aria-checked")).resolves.toBe("true");
    expect(JSON.parse(readFileSync(configPath, "utf8")).plugins).toEqual([{ id: "buoys", enabled: true, config: {} }]);
    const notice = page.locator("[data-restart-notice]");
    await expect(notice.innerText()).resolves.toContain("One plugin changed since the daemon started.");

    // A setting from the contribution's form, and a secret that never comes back.
    await page.locator('[data-plugin="lamps"] summary').click();
    await page.getByLabel("team").first().fill("harbour");
    await page.locator('[data-plugin="lamps"]').getByRole("button", { name: "Save", exact: true }).click();
    await notice.filter({ hasText: "2 plugins changed" }).waitFor({ timeout: 5_000 });
    await page.locator('[data-plugin="lamps"]').getByRole("button", { name: "Set", exact: true }).click();
    const token = randomBytes(12).toString("hex");
    await page.getByRole("textbox", { name: "LAMPS_TOKEN" }).fill(token);
    await page.locator('[data-secret="LAMPS_TOKEN"]').getByRole("button", { name: "Save", exact: true }).click();
    await page.locator('[data-secret="LAMPS_TOKEN"]').getByText("Set", { exact: true }).waitFor({ timeout: 5_000 });
    expect(secrets.get("armada.plugins/LAMPS_TOKEN")).toBe(token);
    expect(await page.evaluate(() => document.body.innerHTML)).not.toContain(token);

    // The page's anatomy: one h1, the 22 px title, in Geist.
    const anatomy = await page.evaluate(() => ({
      h1: [...document.querySelectorAll("h1")].map((h) => [h.textContent, getComputedStyle(h).fontSize]),
      fonts: [...new Set([...document.querySelectorAll("body *")].map((e) => getComputedStyle(e).fontFamily))],
    }));
    expect(anatomy.h1).toEqual([["Plugins", "22px"]]);
    for (const family of anatomy.fonts) expect(family).toMatch(/^"?Geist( Mono)?"?,/);

    await notice.getByRole("button", { name: "Restart" }).click();
    await buoys.locator("[data-state]").filter({ hasText: "Loaded" }).waitFor({ timeout: 10_000 });
    expect(restarts).toBe(1);
    await notice.waitFor({ state: "detached", timeout: 5_000 });
    await expect(page.locator('[data-plugin="lamps"] [data-state]').innerText()).resolves.toBe("Loaded");
    await page.getByRole("status").filter({ hasText: "Live" }).waitFor({ timeout: 5_000 });
  }, 20_000);
});
