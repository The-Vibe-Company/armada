import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ChatItem, ChatTurn } from "@armada/protocol";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterReading, applyFrame, type Live, NO_LIVE, threadItems } from "../src/room/chat";
import { liveThoughtLine, workingTimer } from "../src/room/Live";
import { workRows } from "../src/room/view";

// The coordinator's turn live in the room (THE-2052): the rules that keep it
// beside the reading on synthetic frames, then the room itself in Chromium on
// a fake daemon client that streams a turn (thinking, writing, a tool, idle),
// the owner's Stop, Steer and Queue, and an older daemon that streams nothing.

const version = { major: 1, minor: 7 };
const T0 = "2026-03-10T15:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();
const turn = (state: ChatTurn["state"], since: string, extra: Partial<ChatTurn> = {}): ChatTurn => ({
  type: "chat.turn",
  version,
  project: "harbor",
  state,
  since,
  queued: 0,
  ...extra,
});
const delta = (id: string, kind: "text" | "reasoning", text: string) =>
  ({ type: "chat.delta", version, project: "harbor", id, kind, text }) as const;
const tool = { id: "t9:call-1", at: at(5), name: "fleet.status", input: {}, output: null, failed: false };

test("a turn seen to begin counts from its start; one joined mid-way has none; idle ends it", () => {
  const joined = applyFrame(NO_LIVE, turn("thinking", at(3)));
  expect(joined.started).toBeNull();
  const idle = applyFrame(NO_LIVE, turn("idle", at(0)));
  const thinking = applyFrame(idle, turn("thinking", at(1)));
  expect(thinking.started).toBe(at(1));
  // The state changes, the start stays.
  expect(applyFrame(thinking, turn("writing", at(4))).started).toBe(at(1));
  expect(applyFrame(thinking, turn("idle", at(9))).started).toBeNull();
});

test("deltas carry the whole text so far, by id; a reading that holds the id takes its place", () => {
  let live: Live = applyFrame(NO_LIVE, turn("idle", at(0)));
  live = applyFrame(live, turn("writing", at(1)));
  live = applyFrame(live, delta("g4:1", "reasoning", "Count the berths."));
  live = applyFrame(live, delta("g4:1", "text", "First"));
  live = applyFrame(live, delta("g4:1", "text", "First block."));
  live = applyFrame(live, { ...tool, type: "chat.tool", version, project: "harbor" });
  expect(live.entries).toEqual([
    { kind: "streaming", id: "g4:1", at: at(1), text: "First block.", reasoning: "Count the berths." },
    { kind: "tool", ...tool, live: true },
  ]);
  const owner: ChatItem = { kind: "owner", id: "e1", at: at(0), body: "Check the berths." };
  // The thread: the reading, then what streamed past it.
  expect(threadItems([owner], live).map((i) => i.id)).toEqual(["e1", "g4:1", "t9:call-1"]);
  // A reading that holds the call still running keeps the live call in its place.
  const running = afterReading(live, [owner, { kind: "tool", ...tool }], undefined);
  expect(threadItems([owner, { kind: "tool", ...tool }], running).map((i) => [i.id, "live" in i])).toEqual([
    ["e1", false],
    ["t9:call-1", true],
    ["g4:1", false],
  ]);
  // The checkpoint's reading holds the answer and the call's result: nothing streamed is left.
  const final: ChatItem[] = [
    owner,
    { kind: "coordinator", id: "g4:1", at: at(6), body: "First block.", reasoning: "Count the berths." },
    { kind: "tool", ...tool, output: "{}" },
  ];
  expect(afterReading(live, final, turn("idle", at(7))).entries).toEqual([]);
  // A reading's turn seeds a room that heard none.
  expect(afterReading(NO_LIVE, [], turn("tool", at(2))).turn?.state).toBe("tool");
});

test("the work above an answer being written stays open; its reading folds it in the same row", () => {
  const call = { kind: "tool" as const, ...tool, id: "t8:call-0", at: at(2), output: "{}" };
  const writing = workRows([
    call,
    { kind: "streaming", id: "g4:2", at: at(3), text: "Merging #41.", reasoning: "" },
  ]).map((r) => [r.kind, r.id]);
  expect(writing).toEqual([
    ["work", "work:t8:call-0"],
    ["said", "g4:2"],
  ]);
  const read = workRows([call, { kind: "coordinator", id: "g4:2", at: at(9), body: "Merging #41." }]);
  expect(read.map((r) => [r.kind, r.id])).toEqual([
    ["fold", "work:t8:call-0"],
    ["said", "g4:2"],
  ]);
});

test("a thought's closed line is its first bold heading, else its first sentence", () => {
  expect(liveThoughtLine("**Counting the berths**\nThe north quay has four.")).toBe("Counting the berths");
  expect(liveThoughtLine("The `north` quay has [four](https://example.com). Then the south.")).toBe(
    "The north quay has four.",
  );
  expect(liveThoughtLine("Still thinking")).toBe("Still thinking");
});

test("the working timer reads like T3 Code's", () => {
  const start = Date.parse(T0);
  expect(workingTimer(T0, start + 12_400)).toBe("12s");
  expect(workingTimer(T0, start + 65_000)).toBe("1m 5s");
  expect(workingTimer(T0, start + 3_720_000)).toBe("1h 2m");
  expect(workingTimer("not a time", start)).toBe("0s");
});

const ORIGIN = "http://room-live.test";

describe("the room streams the coordinator's turn in a browser", () => {
  let browser: Browser | undefined;
  let bundle = "";

  // The page's bundle and the headless shell (installed before the suite) are setup, not behaviour deadlines.
  beforeAll(async () => {
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "room-live-page.tsx")],
      target: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    if (!built.success) throw new Error(built.logs.join("\n"));
    bundle = (await built.outputs[0]?.text()) ?? "";
    browser = await chromium.launch({ timeout: 15_000 });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
  }, 10_000);

  async function open(minor: number): Promise<Page> {
    if (!browser) throw new Error("browser setup did not complete");
    const context = await browser.newContext();
    const page = await context.newPage();
    // No network: the page and its script are served here, anything else is refused.
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === ORIGIN && url.pathname === "/")
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><div id="root"></div><script type="module" src="/room.js"></script>',
        });
      if (url.href === `${ORIGIN}/room.js`) return route.fulfill({ contentType: "text/javascript", body: bundle });
      return route.abort();
    });
    await page.goto(`${ORIGIN}/?minor=${minor}`);
    await page.locator("[data-thread]").waitFor({ timeout: 5_000 });
    return page;
  }

  const emit = (page: Page, frame: Record<string, unknown>) =>
    page.evaluate((f) => (window as unknown as { daemon: { emit(f: unknown): void } }).daemon.emit(f), frame);
  // Handed over as JSON: Playwright's argument types do not unwind a tool's JSON input.
  const checkpoint = (page: Page, items: ChatItem[], idle?: ChatTurn) =>
    page.evaluate((json) => {
      const { items, idle } = JSON.parse(json);
      (window as unknown as { daemon: { checkpoint(i: unknown, t: unknown): void } }).daemon.checkpoint(items, idle);
    }, JSON.stringify({ items, idle }));
  /** The page's time, `seconds` after T0 (it flows on from there). */
  const setNow = (page: Page, seconds: number) =>
    page.evaluate(
      (time) => (window as unknown as { daemon: { setNow(t: number): void } }).daemon.setNow(time),
      Date.parse(at(seconds)),
    );
  /** The field gave its message to the daemon, which admitted it. */
  const emptied = (page: Page) =>
    page.waitForFunction(() => document.querySelector("textarea")?.value === "", undefined, { timeout: 2_000 });
  /** The next reading, without a checkpoint: what the room reads when it asks (after a Stop). */
  const reading = (page: Page, items: ChatItem[], idle?: ChatTurn) =>
    page.evaluate((json) => {
      const { items, idle } = JSON.parse(json);
      (window as unknown as { daemon: { reading(i: unknown, t: unknown): void } }).daemon.reading(items, idle);
    }, JSON.stringify({ items, idle }));
  const requests = (page: Page) =>
    page.evaluate(() => (window as unknown as { daemon: { requests: Record<string, unknown>[] } }).daemon.requests);
  const owner: ChatItem = { kind: "owner", id: "e1", at: T0, body: "Check the berths, then merge #41." };
  const frame = ({ version: _, project: __, ...rest }: Record<string, unknown>) => rest;

  test("thinking, writing, a tool and idle: the Working timer, the Thinking line, the answer growing then read under the same key; Stop, Steer and Queue", async () => {
    const page = await open(7);
    await checkpoint(page, [owner]);
    await page.getByText("Check the berths, then merge #41.").waitFor({ timeout: 2_000 });
    await emit(page, frame(turn("idle", at(0))));
    // Nothing works yet: the round button is Send.
    expect(await page.locator("[data-working]").count()).toBe(0);
    await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 2_000 });

    await setNow(page, 0);
    await emit(page, frame(turn("thinking", at(0))));
    const working = page.locator("[data-working]");
    expect(await working.textContent()).toBe("Working for 0s");
    // Twelve seconds on, the row says so at its next draw.
    await setNow(page, 12);
    await emit(page, frame(turn("thinking", at(0))));
    expect(await working.textContent()).toBe("Working for 12s");

    // Its reasoning: a brain, "Thinking" shimmering, its first heading as its line, closed.
    await emit(page, frame(delta("g4:1", "reasoning", "**Counting the berths**\nThe north quay has four.")));
    const thought = page.locator('[data-thought="live"]');
    expect(await thought.locator("[data-preview]").textContent()).toBe("Counting the berths");
    expect(await thought.locator("[data-shine]").textContent()).toBe("Thinking");
    expect(await thought.getByRole("button").getAttribute("aria-expanded")).toBe("false");

    // The answer as it is written, in the coordinator's place, marked to recognise its node later.
    await emit(page, frame(turn("writing", at(13))));
    await emit(page, frame(delta("g4:1", "text", "North quay: four berths.")));
    const answer = page.locator('[data-item="streaming"]');
    await answer.locator("[data-streaming] p").first().waitFor({ timeout: 2_000 });
    await answer.evaluate((li) => li.setAttribute("data-mark", "partial"));
    await emit(page, frame(delta("g4:1", "text", "North quay: four berths.\n\nSouth quay: two.")));
    expect(await answer.locator("[data-streaming] p").allTextContents()).toEqual([
      "North quay: four berths.",
      "South quay: two.",
    ]);
    // No time and no Copy while it is written; the thought stopped shimmering.
    expect(await answer.locator("[data-meta]").count()).toBe(0);
    expect(await page.locator('[data-thought="live"] [data-shine]').count()).toBe(0);

    // The newest call runs, its row (THE-2053's) shining.
    await emit(page, { ...tool, type: "chat.tool" });
    await emit(page, frame(turn("tool", at(15), { tool: { id: tool.id, name: tool.name }, queued: 0 })));
    const call = page.locator('[data-tool="fleet.status"]');
    expect(await call.locator("[data-shine]").textContent()).toBe("Read the fleet");

    // With text, the round button steers; ⌘Enter queues instead.
    const field = page.getByRole("textbox", { name: "Message" });
    await field.fill("Merge #44 first.");
    await page.getByRole("button", { name: "Steer message" }).click();
    await emptied(page);
    await field.fill("Then look at HAR-15.");
    await page.keyboard.press("ControlOrMeta+Enter");
    await emptied(page);
    const sends = (await requests(page)).filter((r) => r.type === "chat.send");
    expect(sends.map((r) => [r.body, r.whenBusy])).toEqual([
      ["Merge #44 first.", undefined],
      ["Then look at HAR-15.", "queue"],
    ]);
    // The queued message waits apart, faded, with the turn's count.
    await page.locator("[data-queued]").getByText("Then look at HAR-15.").waitFor({ timeout: 2_000 });
    await setNow(page, 15);
    await emit(page, frame(turn("tool", at(15), { tool: { id: tool.id, name: tool.name }, queued: 1 })));
    expect(await working.textContent()).toBe("Working for 15s· 1 queued");

    // The steered message is placed: a checkpoint's reading holds it, so it is no longer on its way.
    await checkpoint(page, [owner, { kind: "owner", id: "e2", at: at(14), body: "Merge #44 first." }]);
    await page.locator('[data-item="owner"]').nth(1).getByText("Merge #44 first.").waitFor({ timeout: 2_000 });

    // An empty field: Stop, which interrupts the turn. pi's abort withdraws the queued message: the reading
    // right after the Stop holds the stopped answer and the call's result, not it, and its words come back
    // to the field rather than vanish. The steered one, delivered, stays delivered even past the reading's
    // window (this reading leaves it out).
    await reading(
      page,
      [
        owner,
        {
          kind: "coordinator",
          id: "g4:1",
          at: at(16),
          body: "North quay: four berths.\n\nSouth quay: two.",
          reasoning: "**Counting the berths**\nThe north quay has four.",
          aborted: true,
        },
        { kind: "tool", ...tool, output: '{"ok":true}' },
      ],
      turn("idle", at(20)),
    );
    const stop = page.getByRole("button", { name: "Stop generation" });
    expect(await stop.getAttribute("title")).toBe("Interrupt");
    await stop.click();
    await page.waitForFunction(() => document.querySelector("textarea")?.value === "Then look at HAR-15.", undefined, {
      timeout: 2_000,
    });
    expect((await requests(page)).map((r) => r.type).slice(-2)).toEqual(["chat.stop", "chat.read"]);
    await emit(page, frame(turn("idle", at(20))));
    const read = page.locator('[data-mark="partial"]');
    await page.locator('[data-mark="partial"][data-item="coordinator"]').waitFor({ timeout: 2_000 });
    expect(await read.locator("[data-streaming]").count()).toBe(0);
    expect(await read.locator("[data-stopped]").textContent()).toBe("stoppedYou stopped this response");
    expect(await read.locator('[data-thought="done"] [data-preview]').textContent()).toBe("Counting the berths");
    expect(await page.locator("[data-working]").count()).toBe(0);
    // No queued bubble stays, nor a message on its way.
    expect(await page.locator("[data-queued]").count()).toBe(0);
    expect(await page.locator('[data-item="owner"]').count()).toBe(1);
    // The call's row stays where it was, its result read: it no longer shines.
    expect(await call.textContent()).toBe("Read the fleet");
    expect(await call.locator("[data-shine]").count()).toBe(0);
    await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 2_000 });
    await page.context().close();
  }, 20_000);

  test("an older daemon (minor 4) shows nothing live and no Stop", async () => {
    const page = await open(4);
    await checkpoint(page, [owner]);
    await page.getByText("Check the berths, then merge #41.").waitFor({ timeout: 2_000 });
    // Even frames it would not send change nothing.
    await emit(page, frame(turn("idle", at(0))));
    await emit(page, frame(turn("thinking", at(1))));
    await emit(page, frame(delta("g4:1", "text", "North quay: four berths.")));
    await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 2_000 });
    expect(await page.locator("[data-working]").count()).toBe(0);
    expect(await page.locator('[data-item="streaming"]').count()).toBe(0);
    expect(await page.getByRole("button", { name: "Stop generation" }).count()).toBe(0);
    await page.context().close();
  }, 20_000);
});
