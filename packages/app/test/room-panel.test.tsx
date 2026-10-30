import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fold } from "@armada/daemon/fold";
import { type Browser, chromium, type Page } from "playwright-core";
import { compile } from "tailwindcss";
import { SAMPLE_PROJECTS, sampleEvents } from "../scripts/dev-daemon";
import { clampWidth, PANEL_KEY, panelKey, readPanel } from "../src/room/panel-rules";

// The room's panel (THE-2085), after T3 Code's right panel: its rules on
// synthetic input, then the room in Chromium on a fake daemon client
// (test/room-panel-page.tsx) over the daemon's own fold of a synthetic log,
// styled by the app's own Tailwind build: the tabs and their keys, the width
// dragged and kept, the agents' links, a pill going to its group, the
// question answered from its card or from the line above the field, the
// rules, the log, and the sheet of a narrow window.

test("the panel's width stays between its bounds, and a broken reading falls back to its defaults", () => {
  expect(clampWidth(100)).toBe(240);
  expect(clampWidth(612)).toBe(480);
  expect(clampWidth(Number.NaN)).toBe(240);
  const held = (value: string | null) => readPanel({ getItem: () => value, setItem() {} });
  expect(held(null)).toEqual({ width: 320, open: null });
  expect(held("{nope")).toEqual({ width: 320, open: null });
  expect(held('{"width":900,"open":false}')).toEqual({ width: 480, open: false });
});

test("⌘. toggles the panel, ⌘1 to ⌘4 pick its tab; nothing else is the panel's", () => {
  const key = (k: string, more: Partial<KeyboardEvent> = {}) =>
    panelKey({ key: k, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...more });
  expect(key(".")).toEqual({ kind: "toggle" });
  expect(key(".", { metaKey: false, ctrlKey: true })).toEqual({ kind: "toggle" });
  expect(["1", "2", "3", "4"].map((k) => key(k))).toEqual([
    { kind: "tab", tab: "agents" },
    { kind: "tab", tab: "prs" },
    { kind: "tab", tab: "rules" },
    { kind: "tab", tab: "log" },
  ]);
  expect(key("5")).toBeNull();
  expect(key(".", { metaKey: false })).toBeNull();
  expect(key("1", { shiftKey: true })).toBeNull();
});

const ORIGIN = "http://room-panel.test";
const ROOT = resolve(import.meta.dir, "..");

/** The app's own stylesheet, built for the classes the page's bundle names. */
async function stylesFor(bundle: string): Promise<string> {
  const tailwind = dirname(Bun.resolveSync("tailwindcss/package.json", ROOT));
  const compiler = await compile(readFileSync(join(ROOT, "src/styles.css"), "utf8"), {
    base: join(ROOT, "src"),
    loadStylesheet: async (id: string, base: string) => {
      const path = id === "tailwindcss" ? join(tailwind, "index.css") : join(base, id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  return compiler.build([...new Set(bundle.match(/[^\s"'`\\<>{};,]+/g) ?? [])]);
}

describe("the room's panel in a browser", () => {
  let browser: Browser | undefined;
  let bundle = "";
  let css = "";
  let seed = "";

  // The page's bundle, its styles and the headless shell (installed before the suite) are setup, not behaviour deadlines.
  beforeAll(async () => {
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "room-panel-page.tsx")],
      target: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    if (!built.success) throw new Error(built.logs.join("\n"));
    bundle = (await built.outputs[0]?.text()) ?? "";
    css = await stylesFor(bundle);
    // Harbor's fold, and its log with more events than the Log shows.
    const AT = "2026-03-10T09:00:00.000Z";
    const events = sampleEvents(AT).map((e, i) => ({ ...e, seq: i + 1 }));
    const project = SAMPLE_PROJECTS[0]?.id ?? "harbor";
    const state = fold(events).projects[project];
    const log = events.filter((e) => e.project === project);
    const more = Array.from({ length: 60 }, (_, k) => ({
      seq: events.length + k + 1,
      project,
      kind: "session.heartbeat",
      at: new Date(Date.parse("2026-03-10T10:00:00.000Z") + k * 60_000).toISOString(),
      actor: "worker",
      payload: { ticket: k % 2 ? "HAR-12" : "HAR-20" },
    }));
    seed = JSON.stringify({ state, events: [...log, ...more] });
    browser = await chromium.launch({ timeout: 15_000 });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  }, 10_000);

  async function open(width = 1280, hash = "#/projects/harbor", height = 800): Promise<Page> {
    if (!browser) throw new Error("browser setup did not complete");
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    // A step that does not happen fails on its own line, before the test's deadline.
    page.setDefaultTimeout(2_000);
    await context.addInitScript((json) => {
      (window as unknown as { seed: unknown }).seed = JSON.parse(json);
    }, seed);
    // No network: the page, its styles and its script are served here, anything else is refused.
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === ORIGIN && url.pathname === "/")
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html class="dark"><style>${css}</style><body style="margin:0"><div id="root"></div><script type="module" src="/room.js"></script></body></html>`,
        });
      if (url.href === `${ORIGIN}/room.js`) return route.fulfill({ contentType: "text/javascript", body: bundle });
      return route.abort();
    });
    await page.goto(`${ORIGIN}/${hash}`);
    await page.locator("[data-room]").waitFor({ timeout: 5_000 });
    return page;
  }

  const panel = (page: Page) => page.getByRole("complementary", { name: "Panel" });
  const hash = (page: Page) => page.evaluate(() => window.location.hash);
  const focused = (page: Page) =>
    page.evaluate(() => {
      const el = document.activeElement;
      return el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}` : null;
    });
  const columnWidth = (page: Page) =>
    page.locator("[data-dock]").evaluate((el) => el.parentElement?.getBoundingClientRect().width ?? 0);

  test("the tabs, by a click or ⌘1 to ⌘4, in the address; ⌘. hides the panel and the thread widens", async () => {
    const page = await open();
    const side = panel(page);
    // Open on the agents, 320 px wide.
    await side.getByRole("tab", { name: "Agents", selected: true }).waitFor();
    await expect(side.evaluate((el) => el.getBoundingClientRect().width)).resolves.toBe(320);
    // Pull requests: the open ones of the tickets in flight, with their checks.
    await side.getByRole("tab", { name: "Pull requests" }).click();
    await expect(hash(page)).resolves.toBe("#/projects/harbor?panel=prs");
    const prs = await side.locator("[data-pr-row]").allInnerTexts();
    expect(prs.map((t) => t.replace(/\s+/g, " ").trim())).toContain(
      "#41 HAR-15 Price berths by the hour Checks failing",
    );
    // ⌘3: the rules form; ⌘4: the log, newest first, 50 rows.
    await page.keyboard.press("Meta+3");
    await expect(hash(page)).resolves.toBe("#/projects/harbor?panel=rules");
    await side.getByRole("heading", { level: 2, name: "Rules" }).waitFor();
    await page.keyboard.press("Meta+4");
    await expect(hash(page)).resolves.toBe("#/projects/harbor?panel=log");
    const rows = side.locator("[data-event]");
    await expect(rows.count()).resolves.toBe(50);
    expect((await rows.first().innerText()).replace(/\s+/g, " ")).toBe("10:59 · session.heartbeat · HAR-12");
    await expect(rows.first().getByRole("link", { name: "HAR-12" }).getAttribute("href")).resolves.toBe(
      "#/sessions/HAR-12",
    );
    await page.keyboard.press("Meta+1");
    await side.getByRole("tab", { name: "Agents", selected: true }).waitFor();
    // ⌘. hides it, its toggle says so, and the conversation takes the room's width.
    const beside = await columnWidth(page);
    const toggle = page.getByRole("button", { name: "Panel", exact: true });
    await expect(toggle.getAttribute("aria-pressed")).resolves.toBe("true");
    await page.keyboard.press("Meta+.");
    await side.waitFor({ state: "detached" });
    await expect(toggle.getAttribute("aria-pressed")).resolves.toBe("false");
    await expect(columnWidth(page)).resolves.toBe(beside + 320);
    // ⌘1 picks nothing while it is closed; ⌘. brings it back.
    await page.keyboard.press("Meta+2");
    await expect(hash(page)).resolves.toBe("#/projects/harbor?panel=agents");
    await page.keyboard.press("Meta+.");
    await side.waitFor();
    // An address naming a tab opens the panel the owner closed (Back, a link, the old rules page).
    await page.keyboard.press("Meta+.");
    await side.waitFor({ state: "detached" });
    await page.evaluate(() => {
      window.location.hash = "#/projects/harbor?panel=rules";
    });
    await side.getByRole("tab", { name: "Rules", selected: true }).waitFor();
    await page.close();
  }, 15_000);

  test("its left edge drags its width between 240 and 480, kept on this machine", async () => {
    const page = await open();
    const side = panel(page);
    const edge = side.locator("[data-panel-edge]");
    const drag = async (by: number) => {
      const box = await edge.boundingBox();
      if (!box) throw new Error("no edge");
      await page.mouse.move(box.x + box.width / 2, box.y + 200);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + by / 2, box.y + 200);
      await page.mouse.move(box.x + box.width / 2 + by, box.y + 200);
      await page.mouse.up();
    };
    await drag(-100);
    await expect(side.evaluate((el) => el.getBoundingClientRect().width)).resolves.toBe(420);
    await expect(page.evaluate((key) => localStorage.getItem(key), PANEL_KEY)).resolves.toBe(
      '{"width":420,"open":null}',
    );
    await drag(-300);
    await expect(side.evaluate((el) => el.getBoundingClientRect().width)).resolves.toBe(480);
    await page.reload();
    await expect(panel(page).evaluate((el) => el.getBoundingClientRect().width)).resolves.toBe(480);
    // The arrow keys move it too.
    await panel(page).locator("[data-panel-edge]").focus();
    await page.keyboard.press("ArrowRight");
    await expect(panel(page).evaluate((el) => el.getBoundingClientRect().width)).resolves.toBe(464);
    await page.close();
  }, 15_000);

  test("an agent's row opens its session, its report's #41 its pull request; a pill goes to its group", async () => {
    // A short window: the agents scroll under the tabs.
    const page = await open(1280, "#/projects/harbor?panel=log", 520);
    const side = panel(page);
    // A pill of the header opens Agents at its group, its heading focused.
    await page.getByRole("button", { name: "1 blocked" }).click();
    await expect(hash(page)).resolves.toBe("#/projects/harbor?panel=agents");
    await expect(focused(page)).resolves.toBe("h2#agents-blocked");
    await page.getByRole("button", { name: "1 merged today" }).click();
    await expect(focused(page)).resolves.toBe("h2#agents-merged");
    // The heading is at the top of the scrolled tab (or the tab is scrolled to its end), never scrolled past.
    const place = (id: string) =>
      side.locator(`#${id}`).evaluate((el) => {
        const tab = el.closest('[role="tabpanel"]') as HTMLElement;
        const top = el.getBoundingClientRect().top - tab.getBoundingClientRect().top;
        const end = tab.scrollTop >= tab.scrollHeight - tab.clientHeight - 1;
        return {
          top: Math.round(top),
          shown: top >= 0 && el.getBoundingClientRect().bottom <= tab.getBoundingClientRect().bottom,
          end,
        };
      });
    await expect(place("agents-merged")).resolves.toMatchObject({ shown: true, end: true });
    await page.getByRole("button", { name: "1 blocked" }).click();
    await expect(focused(page)).resolves.toBe("h2#agents-blocked");
    await expect(place("agents-blocked")).resolves.toEqual({ top: 0, shown: true, end: false });
    const row = side.locator('[data-row="harbor/HAR-15"]');
    await expect(row.locator("a[data-open]").getAttribute("href")).resolves.toBe("#/sessions/HAR-15");
    const pr = row.getByRole("link", { name: "#41" });
    await expect(pr.getAttribute("href")).resolves.toBe("https://github.com/example/harbor/pull/41");
    // The report's link sits above the row's: a click on #41 reaches it, not the session.
    const box = await pr.boundingBox();
    if (!box) throw new Error("no link");
    await expect(
      page.evaluate(
        ([x, y]) =>
          document
            .elementFromPoint(x ?? 0, y ?? 0)
            ?.closest("a")
            ?.getAttribute("href"),
        [box.x + box.width / 2, box.y + box.height / 2],
      ),
    ).resolves.toBe("https://github.com/example/harbor/pull/41");
    await row.locator("a[data-open]").click();
    await expect(hash(page)).resolves.toBe("#/sessions/HAR-15");
    await page.close();
  }, 15_000);

  test("the question waits first in Agents and answers through owner.answer; the panel closed, the field says it", async () => {
    const page = await open();
    const card = panel(page).getByRole("region", { name: "A question waiting for you" });
    await card.getByText("Two berth tests time out under the full suite.").waitFor();
    // With its card on screen the field says nothing; with the panel closed it does.
    await expect(page.locator("[data-asking]").count()).resolves.toBe(0);
    await page.keyboard.press("Meta+.");
    const line = page.getByRole("region", { name: "Waiting for your answer" });
    await expect(line.innerText()).resolves.toMatch(/^HAR-15\s+Two berth tests time out/);
    // Answer opens the card, its first choice focused.
    await line.getByRole("button", { name: "Answer" }).click();
    await card.waitFor();
    await expect(page.evaluate(() => document.activeElement?.textContent)).resolves.toBe("Fix the wait· recommended");
    await card.getByRole("button", { name: /Raise the timeout/ }).click();
    await page.waitForFunction(() =>
      (window as unknown as { daemon: { requests: { type: string }[] } }).daemon.requests.some(
        (r) => r.type === "owner.answer",
      ),
    );
    const answers = await page.evaluate(() =>
      (window as unknown as { daemon: { requests: Record<string, unknown>[] } }).daemon.requests.filter(
        (r) => r.type === "owner.answer",
      ),
    );
    expect(answers.map(({ project, item, choice }) => ({ project, item, choice }))).toEqual([
      { project: "harbor", item: expect.any(String), choice: "Raise the timeout" },
    ]);
    await page.close();
  }, 15_000);

  test("below 900 px the panel is a sheet: closed at first, opened by a pill without taking the field's focus, closed by Escape", async () => {
    const page = await open(820);
    await expect(page.locator("[data-sheet]").count()).resolves.toBe(0);
    // The header keeps each pill's dot and number; its words are for screen readers.
    const words = page.locator('[data-pill="blocked"] span').last();
    await expect(words.evaluate((el) => getComputedStyle(el).position)).resolves.toBe("absolute");
    await expect(page.getByRole("button", { name: "1 blocked" }).count()).resolves.toBe(1);
    const field = page.getByLabel("Message", { exact: true });
    await field.click();
    await field.fill("Merge HAR-20");
    await page.getByRole("button", { name: "1 blocked" }).click();
    const sheet = page.locator("[data-sheet]");
    await sheet.waitFor();
    await expect(sheet.locator('[data-group-heading="blocked"]').isVisible()).resolves.toBe(true);
    await expect(focused(page)).resolves.toBe(`textarea#${await field.getAttribute("id")}`);
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await expect(field.inputValue()).resolves.toBe("Merge HAR-20");
    // Closed by a press beside it with the focus in it, the sheet hands the focus back to its toggle.
    const toggle = page.getByRole("button", { name: "Panel", exact: true });
    await toggle.click();
    await sheet.getByRole("tab", { name: "Agents" }).focus();
    await page.mouse.click(40, 400);
    await sheet.waitFor({ state: "detached" });
    await expect(page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).resolves.toBe("Panel");
    await page.close();
  }, 15_000);
});
