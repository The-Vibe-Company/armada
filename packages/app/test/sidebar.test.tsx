import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { CHAT_MODEL_FAILED, type ChatItem, type ChatTurn } from "@armada/protocol";
import { type Browser, chromium, type Page } from "playwright-core";
import { failedTurn, markSeen, seenOf, statusPill, unreadCount } from "../src/room/unread";

// The sidebar's word on each project's coordinator (THE-2054), in a browser on
// a fake daemon: what it said past the owner's last visit, and its turn.

const ORIGIN = "http://sidebar.test";
const AT = Date.parse("2026-03-10T09:00:00.000Z");
const at = (minute: number) => new Date(AT + minute * 60_000).toISOString();
const READINGS: Record<string, ChatItem[]> = {
  // The owner last read Lantern's room at minute 2: two of the coordinator's items came after (a call does not count).
  lantern: [
    { kind: "owner", id: "o1", at: at(1), body: "Check the berths." },
    { kind: "coordinator", id: "c1", at: at(2), body: "Four berths." },
    { kind: "tool", id: "t1", at: at(3), name: "fleet.read", input: {}, output: "{}", failed: false },
    { kind: "line", id: "l1", at: at(4), body: "HAR-12 is blocked." },
    { kind: "coordinator", id: "c2", at: at(5), body: "HAR-12 waits on #41." },
  ],
  // Never visited: its first reading is the watermark, nothing unread.
  harbor: [{ kind: "coordinator", id: "c1", at: at(1), body: "Ready." }],
};

const turn = (state: ChatTurn["state"]): ChatTurn => ({
  version: { major: 1, minor: 7 },
  type: "chat.turn",
  project: "harbor",
  state,
  since: at(0),
  queued: 0,
});

test("the pill says a waiting question first, then a running turn, then a failed one; nothing when idle", () => {
  const failed = [{ kind: "line", id: "l1", at: at(1), body: CHAT_MODEL_FAILED }] satisfies ChatItem[];
  expect(failedTurn(failed)).toBe(true);
  expect(failedTurn([...failed, { kind: "coordinator", id: "c1", at: at(2), body: "Done." }])).toBe(false);
  expect(statusPill({ turn: turn("idle"), waiting: 0, failed: false })).toBeNull();
  expect(statusPill({ turn: turn("tool"), waiting: 0, failed: true })?.label).toBe("Working");
  expect(statusPill({ turn: turn("idle"), waiting: 0, failed: true })?.label).toBe("Failed");
  expect(statusPill({ turn: turn("writing"), waiting: 1, failed: true })?.label).toBe("Awaiting input");
});

test("the watermark only moves forward, and counts nothing before the first visit", () => {
  const map = new Map<string, string>();
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v) };
  expect(unreadCount([at(1), at(2)], seenOf(storage, "harbor"))).toBe(0);
  expect(markSeen(storage, "harbor", at(2))).toBe(true);
  expect(markSeen(storage, "harbor", at(1))).toBe(false);
  expect(seenOf(storage, "harbor")).toBe(at(2));
  expect(unreadCount([at(1), at(2), at(3)], seenOf(storage, "harbor"))).toBe(1);
});

describe("the sidebar's projects in a browser", () => {
  let browser: Browser | undefined;
  let page: Page;
  let bundle = "";

  beforeAll(async () => {
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "sidebar-page.tsx")],
      target: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    if (!built.success) throw new Error(built.logs.join("\n"));
    bundle = (await built.outputs[0]?.text()) ?? "";
    browser = await chromium.launch({ timeout: 15_000 });
  }, 30_000);
  beforeAll(async () => {
    if (!browser) throw new Error("browser setup did not complete");
    const context = await browser.newContext();
    page = await context.newPage();
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url === `${ORIGIN}/`)
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><div id="root"></div><script>localStorage.setItem("armada.room.seen.lantern", ${JSON.stringify(at(2))});window.READINGS=${JSON.stringify(READINGS).replace(/</g, "\\u003c")}</script><script type="module" src="/sidebar.js"></script>`,
        });
      if (url === `${ORIGIN}/sidebar.js`) return route.fulfill({ contentType: "text/javascript", body: bundle });
      return route.abort();
    });
    await page.goto(`${ORIGIN}/`);
    await page.getByRole("link", { name: /Harbor/ }).waitFor({ timeout: 5_000 });
  }, 10_000);
  afterAll(async () => {
    await browser?.close();
  }, 10_000);

  const line = (name: RegExp) => page.getByRole("navigation", { name: "Projects" }).getByRole("link", { name });

  test("a project's line counts what its coordinator said past the owner's last visit", async () => {
    await line(/^Lantern\s*2 unread$/).waitFor({ timeout: 2_000 });
    // Read for the first time, Harbor starts from its last item: nothing unread, and the watermark is kept.
    await page.waitForFunction(() => localStorage.getItem("armada.room.seen.harbor") !== null, null, {
      timeout: 2_000,
    });
    expect(await line(/^Harbor$/).count()).toBe(1);
    expect(await page.locator("[data-unread]").count()).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem("armada.room.seen.harbor"))).toBe(at(1));
  });

  test("Working shows, pulsing, while a project's coordinator works, and goes when it is idle", async () => {
    const emit = (state: string) =>
      page.evaluate(
        (s) =>
          (window as unknown as { daemon: { emit(f: unknown): void } }).daemon.emit({
            type: "chat.turn",
            project: "harbor",
            state: s,
            since: "2026-03-10T09:10:00.000Z",
            queued: 0,
          }),
        state,
      );
    expect(await page.locator("[data-pill]").count()).toBe(0);
    await emit("thinking");
    const pill = line(/^Harbor\s*Working$/).locator('[data-pill="Working"]');
    await pill.waitFor({ timeout: 2_000 });
    expect(await pill.locator(".motion-safe\\:animate-pulse").count()).toBe(1);
    // Lantern's coordinator is not working.
    expect(
      await line(/^Lantern\s*2 unread$/)
        .locator("[data-pill]")
        .count(),
    ).toBe(0);
    await emit("idle");
    expect(await page.locator("[data-pill]").count()).toBe(0);
  });
});
