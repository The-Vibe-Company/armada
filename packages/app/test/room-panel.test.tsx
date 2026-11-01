import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fold } from "@armada/daemon/fold";
import type { Page } from "playwright-core";
import { SAMPLE_PROJECTS, sampleEvents } from "../scripts/dev-daemon";
import { clampWidth, PANEL_KEY, panelKey, readPanel } from "../src/room/panel-rules";
import { type RoomBrowser, roomBrowser, settled } from "./room-browser";

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

describe("the room's panel in a browser", () => {
  let room: RoomBrowser | undefined;

  // The page's bundle, its styles and the headless shell (installed before the suite) are setup, not behaviour deadlines.
  beforeAll(async () => {
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
    room = await roomBrowser(JSON.stringify({ state, events: [...log, ...more] }));
  }, 60_000);
  afterAll(async () => {
    await room?.close();
  }, 10_000);

  const open = (width?: number, hash?: string, height?: number): Promise<Page> => {
    if (!room) throw new Error("browser setup did not complete");
    return room.open(width, hash, height);
  };

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
    await settled(() => side.evaluate((el) => el.getBoundingClientRect().width), 320);
    // Pull requests: the open ones of the tickets in flight, with their checks.
    await side.getByRole("tab", { name: "Pull requests" }).click();
    await settled(() => hash(page), "#/projects/harbor?panel=prs");
    await side.locator("[data-pr-row]").first().waitFor();
    const prs = await side.locator("[data-pr-row]").allInnerTexts();
    expect(prs.map((t) => t.replace(/\s+/g, " ").trim())).toContain(
      "#41 Price berths by the hour HAR-15 head-41 Red CI",
    );
    // ⌘3: the rules form; ⌘4: the log, newest first, 50 rows.
    await page.keyboard.press("Meta+3");
    await settled(() => hash(page), "#/projects/harbor?panel=rules");
    await side.getByRole("heading", { level: 2, name: "Rules" }).waitFor();
    await page.keyboard.press("Meta+4");
    await settled(() => hash(page), "#/projects/harbor?panel=log");
    const rows = side.locator("[data-event]");
    await settled(() => rows.count(), 50);
    expect((await rows.first().innerText()).replace(/\s+/g, " ")).toBe("10:59 · session.heartbeat · HAR-12");
    await settled(() => rows.first().getByRole("link", { name: "HAR-12" }).getAttribute("href"), "#/sessions/HAR-12");
    await page.keyboard.press("Meta+1");
    await side.getByRole("tab", { name: "Agents", selected: true }).waitFor();
    // ⌘. hides it, its toggle says so, and the conversation takes the room's width.
    const beside = await columnWidth(page);
    const toggle = page.getByRole("button", { name: "Panel", exact: true });
    await settled(() => toggle.getAttribute("aria-pressed"), "true");
    await page.keyboard.press("Meta+.");
    await side.waitFor({ state: "detached" });
    await settled(() => toggle.getAttribute("aria-pressed"), "false");
    await settled(() => columnWidth(page), beside + 320);
    // ⌘1 picks nothing while it is closed; ⌘. brings it back.
    await page.keyboard.press("Meta+2");
    await settled(() => hash(page), "#/projects/harbor?panel=agents");
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
    await settled(() => side.evaluate((el) => el.getBoundingClientRect().width), 420);
    await settled(() => page.evaluate((key) => localStorage.getItem(key), PANEL_KEY), '{"width":420,"open":null}');
    await drag(-300);
    await settled(() => side.evaluate((el) => el.getBoundingClientRect().width), 480);
    await page.reload();
    await settled(() => panel(page).evaluate((el) => el.getBoundingClientRect().width), 480);
    // The arrow keys move it too.
    await panel(page).locator("[data-panel-edge]").focus();
    await page.keyboard.press("ArrowRight");
    await settled(() => panel(page).evaluate((el) => el.getBoundingClientRect().width), 464);
    await page.close();
  }, 15_000);

  test("an agent's row opens it in the lane, its report's #41 its pull request; a pill goes to its group", async () => {
    // A short window: the agents scroll under the tabs.
    const page = await open(1280, "#/projects/harbor?panel=log", 520);
    const side = panel(page);
    // A pill of the header opens Agents at its group, its heading focused.
    await page.getByRole("button", { name: "1 blocked" }).click();
    await settled(() => hash(page), "#/projects/harbor?panel=agents");
    await settled(() => focused(page), "h2#agents-blocked");
    await page.getByRole("button", { name: "1 merged today" }).click();
    await settled(() => focused(page), "h2#agents-merged");
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
    expect(await place("agents-merged")).toMatchObject({ shown: true, end: true });
    await page.getByRole("button", { name: "1 blocked" }).click();
    await settled(() => focused(page), "h2#agents-blocked");
    await settled(() => place("agents-blocked"), { top: 0, shown: true, end: false });
    const row = side.locator('[data-row="harbor/HAR-15"]');
    await settled(
      () => row.locator("a[data-open]").getAttribute("href"),
      "#/projects/harbor?panel=agents&agent=HAR-15",
    );
    const pr = row.getByRole("link", { name: "#41" });
    await settled(() => pr.getAttribute("href"), "https://github.com/example/harbor/pull/41");
    // The report's link sits above the row's: a click on #41 reaches it, not the session.
    const box = await pr.boundingBox();
    if (!box) throw new Error("no link");
    expect(
      await page.evaluate(
        ([x, y]) =>
          document
            .elementFromPoint(x ?? 0, y ?? 0)
            ?.closest("a")
            ?.getAttribute("href"),
        [box.x + box.width / 2, box.y + box.height / 2],
      ),
    ).toBe("https://github.com/example/harbor/pull/41");
    await row.locator("a[data-open]").click();
    await settled(() => hash(page), "#/projects/harbor?panel=agents&agent=HAR-15");
    await page.close();
  }, 15_000);

  test("the question waits first in Agents and answers through owner.answer; the panel closed, the field says it", async () => {
    const page = await open();
    const card = panel(page).getByRole("region", { name: "A question waiting for you" });
    await card.getByText("Two berth tests time out under the full suite.").waitFor();
    // With its card on screen the field says nothing; with the panel closed it does.
    await settled(() => page.locator("[data-asking]").count(), 0);
    await page.keyboard.press("Meta+.");
    const line = page.getByRole("region", { name: "Waiting for your answer" });
    expect(await line.innerText()).toMatch(/^HAR-15\s+Two berth tests time out/);
    // Answer opens the card, its first choice focused.
    await line.getByRole("button", { name: "Answer" }).click();
    await card.waitFor();
    await settled(() => page.evaluate(() => document.activeElement?.textContent), "Fix the wait· recommended");
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
    await settled(() => page.locator("[data-sheet]").count(), 0);
    // The header keeps each pill's dot and number; its words are for screen readers.
    const words = page.locator('[data-pill="blocked"] span').last();
    await settled(() => words.evaluate((el) => getComputedStyle(el).position), "absolute");
    await settled(() => page.getByRole("button", { name: "1 blocked" }).count(), 1);
    const field = page.getByLabel("Message", { exact: true });
    await field.click();
    await field.fill("Merge HAR-20");
    await page.getByRole("button", { name: "1 blocked" }).click();
    const sheet = page.locator("[data-sheet]");
    await sheet.waitFor();
    await settled(() => sheet.locator('[data-group-heading="blocked"]').isVisible(), true);
    await settled(() => focused(page), `textarea#${await field.getAttribute("id")}`);
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await settled(() => field.inputValue(), "Merge HAR-20");
    // Closed by a press beside it with the focus in it, the sheet hands the focus back to its toggle.
    const toggle = page.getByRole("button", { name: "Panel", exact: true });
    await toggle.click();
    await sheet.getByRole("tab", { name: "Agents" }).focus();
    await page.mouse.click(40, 400);
    await sheet.waitFor({ state: "detached" });
    await settled(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Panel");
    await page.close();
  }, 15_000);
});
