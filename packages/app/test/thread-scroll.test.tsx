import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ChatItem } from "@armada/protocol";
import { type Browser, chromium, type Page } from "playwright-core";

// The thread scrolls like T3 Code's (THE-2054), in a browser on a synthetic
// conversation: the "Scroll to end" pill on the page's fake clock, the place
// held while items arrive, a sent message anchored, the place kept.

const ORIGIN = "http://thread-scroll.test";
const AT = Date.parse("2026-03-10T09:00:00.000Z");
const at = (minute: number) => new Date(AT + minute * 60_000).toISOString();
const PARAGRAPH = "The north quay has four berths, each priced by the hour against the tide.";
const said = (k: number): ChatItem =>
  k % 2 === 0
    ? { kind: "owner", id: `o${k}`, at: at(k), body: `Question ${k}: how many berths?` }
    : { kind: "coordinator", id: `c${k}`, at: at(k), body: Array(3).fill(`Answer ${k}. ${PARAGRAPH}`).join("\n\n") };
const conversation = Array.from({ length: 30 }, (_, k) => said(k));

// No stylesheet in the page: just what makes the thread a scroller of fixed height, as the room lays it out.
const CSS = `
  body { margin: 0; }
  #root { height: 600px; display: flex; flex-direction: column; }
  #root > div { position: relative; display: flex; flex: 1; min-height: 0; flex-direction: column; }
  section { display: flex; flex: 1; min-height: 0; flex-direction: column; overflow-y: auto; overflow-anchor: none; padding: 14px 12px 12px; }
  ol { margin: auto 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 12px; }
  .absolute { position: absolute; } .inset-x-0 { left: 0; right: 0; } .bottom-2 { bottom: 8px; }
  .flex { display: flex; } .flex-none { flex: none; } .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; } .justify-center { justify-content: center; }
`;

describe("the thread's scroll in a browser", () => {
  let browser: Browser | undefined;
  let page: Page;
  let bundle = "";

  // The page's bundle and the headless shell (installed before the suite) are setup, not behaviour deadlines.
  beforeAll(async () => {
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "thread-scroll-page.tsx")],
      target: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    if (!built.success) throw new Error(built.logs.join("\n"));
    bundle = (await built.outputs[0]?.text()) ?? "";
    browser = await chromium.launch({ timeout: 15_000 });
  }, 30_000);
  beforeAll(async () => {
    if (!browser) throw new Error("browser setup did not complete");
    const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 900, height: 700 } });
    page = await context.newPage();
    // The pill's delay runs on the page's own clock, moved by the test.
    await page.clock.install({ time: AT });
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url === `${ORIGIN}/`)
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><style>${CSS}</style><div id="root"></div><script>window.ITEMS=${JSON.stringify(conversation).replace(/</g, "\\u003c")}</script><script type="module" src="/thread.js"></script>`,
        });
      if (url === `${ORIGIN}/thread.js`) return route.fulfill({ contentType: "text/javascript", body: bundle });
      return route.abort();
    });
    await page.goto(`${ORIGIN}/`);
    await page.locator("[data-thread]").waitFor({ timeout: 5_000 });
    // From here the page's time moves only when the test moves it.
    await page.clock.pauseAt(AT + 60_000);
  }, 10_000);
  afterAll(async () => {
    await browser?.close();
  }, 10_000);

  const thread = () => page.locator("section");
  const pill = () => page.getByRole("button", { name: /Scroll to end/ });
  const fromEnd = () => thread().evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  /**
   * The first row in view and its top from the thread's top, where it stands
   * (a row just added keeps its entry's slide here: no motion features on this page).
   */
  const firstRow = () =>
    thread().evaluate((el: HTMLElement) => {
      for (const row of el.querySelectorAll<HTMLElement>("[data-row]")) {
        const top = row.offsetTop - el.offsetTop - el.scrollTop;
        if (top + row.offsetHeight > 0) return { key: row.dataset.row, top };
      }
      return null;
    });
  const set = (items: ChatItem[]) =>
    page.evaluate(
      (json) => (window as unknown as { thread: { set(i: unknown): void } }).thread.set(JSON.parse(json)),
      JSON.stringify(items),
    );
  const call = (name: "anchor" | "unmount" | "mount") =>
    page.evaluate((n) => (window as unknown as { thread: Record<string, () => void> }).thread[n]?.(), name);
  /** Waits until the thread is `dy` from its end and still (a wheel's scroll lands over the next frames). */
  const awayBy = (dy: number) =>
    page.waitForFunction(
      (d) => {
        const el = document.querySelector("section");
        const w = window as unknown as { lastTop?: number };
        if (!el) return false;
        const still = w.lastTop === el.scrollTop;
        w.lastTop = el.scrollTop;
        return still && el.scrollHeight - el.scrollTop - el.clientHeight >= d;
      },
      dy,
      { polling: 50, timeout: 2_000 },
    );
  const scrollUp = async (dy: number) => {
    await thread().hover();
    await page.mouse.wheel(0, -dy);
    await awayBy(dy - 2);
  };

  test("it opens at the end; scrolled up, the pill shows after 150 ms, and a click brings it back to the end", async () => {
    expect(await fromEnd()).toBeLessThanOrEqual(1);
    await scrollUp(800);
    await page.clock.runFor(100);
    expect(await pill().count()).toBe(0);
    await page.clock.runFor(60);
    await pill().waitFor({ timeout: 2_000 });
    await pill().click();
    expect(await pill().count()).toBe(0);
    expect(await fromEnd()).toBeLessThanOrEqual(1);
    // Following again: a new item is scrolled to.
    await set([...conversation, said(30)]);
    expect(await fromEnd()).toBeLessThanOrEqual(1);
  });

  test("scrolled up, a new item below and the oldest leaving above do not move what the owner reads", async () => {
    await scrollUp(900);
    const before = await firstRow();
    expect(before).not.toBeNull();
    // Below: an answer arrives.
    await set([...conversation, said(30), said(31)]);
    expect(await firstRow()).toEqual(before);
    // Above: the conversation's window moves on (CHAT_LIMIT), its oldest items leave.
    await set([...conversation.slice(3), said(30), said(31), said(32)]);
    expect(await firstRow()).toEqual(before);
    await page.clock.runFor(200);
    await pill().waitFor({ timeout: 2_000 });
  });

  test("a sent message is pinned about 24 px from the top, with room under it for the answer", async () => {
    const sent: ChatItem = { kind: "owner", id: "sent:1", at: at(40), body: "Merge #41 once it is green." };
    const items = [...conversation, sent];
    await set(items);
    await call("anchor");
    const owner = page.locator('[data-row="sent:1"]');
    const top = () =>
      owner.evaluate((el: HTMLElement) => {
        const box = el.closest("section");
        return box ? el.offsetTop - box.offsetTop - box.scrollTop : null;
      });
    expect(await top()).toBe(24);
    // The pill is not for an anchored turn.
    await page.clock.runFor(200);
    expect(await pill().count()).toBe(0);
    // The answer grows into the room reserved: the message does not move.
    await set([...items, { kind: "coordinator", id: "c40", at: at(41), body: `Merging. ${PARAGRAPH}` }]);
    expect(await top()).toBe(24);
  });

  test("the place is kept when the room closes and restored when it opens again", async () => {
    await set(conversation);
    await scrollUp(700);
    const before = await firstRow();
    await call("unmount");
    await call("mount");
    expect(await firstRow()).toEqual(before);
    await page.clock.runFor(200);
    await pill().waitFor({ timeout: 2_000 });
  });
});
