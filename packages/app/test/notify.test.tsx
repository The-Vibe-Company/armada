import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ChatItem, ChatTurn } from "@armada/protocol";
import { type Browser, chromium, type Page } from "playwright-core";
import { renderToStaticMarkup } from "react-dom/server";
import type { FoldedInboxItem } from "../src/fleet/state";
import { roomOnScreen, TOAST_MS, Toasts } from "../src/notify/Notifications";
import {
  answerOf,
  createNotifier,
  firstLine,
  type Notice,
  type NotifyWorld,
  type OsNotification,
  type OsNotificationClass,
} from "../src/notify/rules";
import { OS_NOTIFICATIONS_KEY, osNotificationsOn } from "../src/notify/settings";

// The app's notifications (THE-2055), after T3 Code's: a coordinator's turn
// that ends after writing (its conversation, read then, holds what it wrote),
// or a question for the owner that opens, for a project whose room is not on
// screen. On a fake `Notification`, a fake focus
// and a fake room on screen: a toast when focused, an OS notification and the
// badge when not, nothing for the room on screen, nothing when the switch is off.
// Then in Chromium (test/notify-page.tsx): the toast's life and the switch.

const version = { major: 1, minor: 7 };
const T0 = "2026-03-10T15:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();
const turn = (project: string, state: ChatTurn["state"], since = at(0)): ChatTurn => ({
  type: "chat.turn",
  version,
  project,
  state,
  since,
  queued: 0,
});
const owner = (seconds: number, body: string): ChatItem => ({
  kind: "owner",
  id: `o${seconds}`,
  at: at(seconds),
  body,
});
const said = (seconds: number, body: string, more: { aborted?: true } = {}): ChatItem => ({
  kind: "coordinator",
  id: `c${seconds}`,
  at: at(seconds),
  body,
  ...more,
});
/** What Harbor's conversation holds once its coordinator answered at 0:15. */
const ANSWERED: ChatItem[] = [
  said(0, "Earlier: all quiet."),
  owner(10, "Check the berths."),
  { kind: "tool", id: "t1", at: at(12), name: "fleet.status", input: {}, output: "{}", failed: false },
  said(15, "## Berths\nNorth quay: four berths.\n\nSouth quay: two."),
];
const delta = (project: string, text: string) =>
  ({ type: "chat.delta", version, project, id: "g4:1", kind: "text", text }) as const;
const question = (id: string, body: string): FoldedInboxItem => ({
  id,
  ticket: "HAR-15",
  kind: "owner-request",
  body,
  at: T0,
});

/** A synthetic world: the window's focus, the room on screen and the switch as the test sets them. */
function world(given: {
  focused?: boolean;
  onScreen?: string | null;
  os?: boolean;
  permission?: NotificationPermission;
}) {
  const notes: { title: string; body: string; tag: string; silent: boolean; closed: boolean; note: OsNotification }[] =
    [];
  const toasts: Notice[] = [];
  const badges: number[] = [];
  const opened: string[] = [];
  const reads: string[] = [];
  const readings = new Map<string, readonly ChatItem[]>([
    ["harbor", ANSWERED],
    ["tidewater", ANSWERED],
  ]);
  const Fake = class implements OsNotification {
    static permission: NotificationPermission = given.permission ?? "granted";
    onclick: ((event: Event) => void) | null = null;
    constructor(title: string, options: { body: string; tag: string; silent: boolean }) {
      notes.push({ title, ...options, closed: false, note: this });
    }
    close() {
      const held = notes.find((n) => n.note === this);
      if (held) held.closed = true;
    }
  } satisfies OsNotificationClass;
  const env: NotifyWorld & { focus: boolean; screen: string | null; os: boolean } = {
    focus: given.focused ?? true,
    screen: given.onScreen ?? null,
    os: given.os ?? true,
    onScreen: () => env.screen,
    focused: () => env.focus,
    osEnabled: () => env.os,
    Notification: Fake,
    nameOf: (project) => ({ harbor: "Harbor", tidewater: "Tidewater" })[project] ?? project,
    toast: (notice) => void toasts.push(notice),
    badge: (count) => void badges.push(count),
    open: (project) => void opened.push(project),
    read: async (project) => {
      reads.push(project);
      const items = readings.get(project);
      if (!items) throw new Error("The daemon did not answer");
      return items;
    },
  };
  return { env, notifier: createNotifier(env), notes, toasts, badges, opened, reads, readings };
}

/** A project's coordinator works from 0:11 (a call, no words streamed, as a fast turn does) and comes back to idle. */
async function answers(notifier: ReturnType<typeof createNotifier>, project = "harbor") {
  notifier.frame(turn(project, "idle"));
  notifier.frame(turn(project, "thinking", at(11)));
  notifier.frame(turn(project, "tool", at(12)));
  notifier.frame(turn(project, "thinking", at(14)));
  await notifier.frame(turn(project, "idle", at(16)));
}

test("focused on another screen: a turn that wrote and ended shows a toast with the project and its first line", async () => {
  const w = world({ focused: true, onScreen: "tidewater" });
  await answers(w.notifier);
  expect(w.toasts).toEqual([
    { kind: "answered", project: "harbor", name: "Harbor", line: "Berths", tag: "harbor:answered" },
  ]);
  // A toast is the whole notice: no OS notification, no badge.
  expect(w.notes).toEqual([]);
  expect(w.badges).toEqual([]);
});

test("unfocused: an OS notification, silent, with the badge's count; its click opens the room; focus clears the badge", async () => {
  const w = world({ focused: false });
  await answers(w.notifier);
  expect(w.notes.map(({ note: _, ...n }) => n)).toEqual([
    { title: "Coordinator answered", body: "Harbor\nBerths", tag: "harbor:answered", silent: true, closed: false },
  ]);
  expect(w.badges).toEqual([1]);
  expect(w.toasts).toEqual([]);
  // A question opened in Tidewater, already read once with nothing open: a second notification, a badge of 2.
  w.notifier.inbox("tidewater", []);
  w.notifier.inbox("tidewater", [
    question("q1", "Ship TID-7 before the freeze?\n\nOptions:\n1. Yes (recommended)\n2. No"),
  ]);
  expect(w.notes.at(-1)?.title).toBe("Question for you");
  expect(w.notes.at(-1)?.body).toBe("Tidewater\nShip TID-7 before the freeze?");
  expect(w.badges).toEqual([1, 2]);
  // Its click closes it, counts one less and opens Tidewater's room.
  w.notes.at(-1)?.note.onclick?.(new Event("click"));
  expect(w.opened).toEqual(["tidewater"]);
  expect(w.notes.at(-1)?.closed).toBe(true);
  expect(w.badges.at(-1)).toBe(1);
  // The window takes the focus: what is left is read.
  w.notifier.focus();
  expect(w.notes.every((n) => n.closed)).toBe(true);
  expect(w.badges.at(-1)).toBe(0);
});

test("a newer notice of the same project and kind replaces the older one, and the badge counts it once", async () => {
  const w = world({ focused: false });
  await answers(w.notifier);
  await answers(w.notifier);
  expect(w.notes.map((n) => n.closed)).toEqual([true, false]);
  expect(w.badges).toEqual([1, 1]);
});

test("nothing for the room on screen, focused or not", async () => {
  for (const focused of [true, false]) {
    const w = world({ focused, onScreen: "harbor" });
    await answers(w.notifier);
    w.notifier.inbox("harbor", []);
    w.notifier.inbox("harbor", [question("q1", "Ship HAR-15?")]);
    expect(w.toasts).toEqual([]);
    expect(w.notes).toEqual([]);
    // Another project still tells.
    await answers(w.notifier, "tidewater");
    expect(w.toasts.length + w.notes.length).toBe(1);
  }
});

test("nothing in the background when the switch is off, or the platform has not allowed it", async () => {
  const off = world({ focused: false, os: false });
  await answers(off.notifier);
  expect(off.notes).toEqual([]);
  expect(off.badges).toEqual([]);
  expect(off.toasts).toEqual([]);
  // The switch on, the same turn notifies: the switch is what held it.
  off.env.os = true;
  await answers(off.notifier);
  expect(off.notes).toHaveLength(1);

  const refused = world({ focused: false, permission: "denied" });
  await answers(refused.notifier);
  expect(refused.notes).toEqual([]);
  expect(refused.badges).toEqual([]);
});

test("only news: the idle turn of a subscription, a turn that wrote nothing and the questions first read say nothing", async () => {
  const w = world({ focused: true });
  w.notifier.frame(turn("harbor", "idle"));
  expect(await w.notifier.frame(turn("harbor", "idle"))).toBeUndefined();
  // A turn from 0:20 that only ran a tool: the reading's newest answer is older than it.
  w.notifier.frame(turn("harbor", "tool", at(20)));
  await w.notifier.frame(turn("harbor", "idle", at(25)));
  // A turn whose answer was stopped.
  w.readings.set("harbor", [...ANSWERED, owner(30, "Stop that."), said(32, "Starting on", { aborted: true })]);
  w.notifier.frame(turn("harbor", "writing", at(31)));
  await w.notifier.frame(turn("harbor", "idle", at(33)));
  // Questions already open when the app first read the project.
  w.notifier.inbox("harbor", [question("q1", "Ship HAR-15?")]);
  w.notifier.inbox("harbor", [question("q1", "Ship HAR-15?")]);
  expect(w.toasts).toEqual([]);
  // The room on screen is not even read.
  w.env.screen = "harbor";
  await answers(w.notifier);
  expect(w.reads).toEqual(["harbor", "harbor"]);
});

test("a reading that fails falls back on the words the turn streamed, if any", async () => {
  const w = world({ focused: true });
  w.readings.delete("harbor");
  w.notifier.frame(turn("harbor", "writing", at(11)));
  w.notifier.frame(delta("harbor", "North quay: four berths."));
  await w.notifier.frame(turn("harbor", "idle", at(16)));
  w.notifier.frame(turn("harbor", "thinking", at(20)));
  await w.notifier.frame(turn("harbor", "idle", at(22)));
  expect(w.toasts.map((t) => t.line)).toEqual(["North quay: four berths."]);
});

test("what a turn wrote: the newest answer or line said since it began, never a stopped one", () => {
  expect(answerOf(ANSWERED, at(11))).toBe("Berths");
  expect(answerOf(ANSWERED, at(20))).toBeNull();
  expect(answerOf([...ANSWERED, said(18, "Stopped mid-way", { aborted: true })], at(11))).toBe("Berths");
  expect(answerOf([{ kind: "line", id: "l1", at: at(12), body: "HAR-15 is blocked: #41 is red." }], at(11))).toBe(
    "HAR-15 is blocked: #41 is red.",
  );
  expect(answerOf([], at(0))).toBeNull();
});

test("the first line: markdown's marks left out, cut at 120 characters", () => {
  expect(firstLine("\n\n> **Merged #44.** HAR-15 next.\nMore.")).toBe("Merged #44. HAR-15 next.");
  expect(firstLine("- `HAR-15` is blocked")).toBe("HAR-15 is blocked");
  const long = firstLine("word ".repeat(60));
  expect(long).toHaveLength(120);
  expect(long.endsWith("…")).toBe(true);
  expect(firstLine("  \n ")).toBe("");
});

test("the room on screen: a project's room in a visible window, never its rules, a session or another screen", () => {
  expect(roomOnScreen("#/projects/harbor", true)).toBe("harbor");
  expect(roomOnScreen("#/projects/harbor", false)).toBeNull();
  expect(roomOnScreen("#/projects/harbor/rules", true)).toBeNull();
  expect(roomOnScreen("#/sessions/HAR-15", true)).toBeNull();
  expect(roomOnScreen("#/settings", true)).toBeNull();
});

test("the switch is on by default, and off once stored off", () => {
  const storage = (value: string | null) => ({
    getItem: (key: string) => (key === OS_NOTIFICATIONS_KEY ? value : null),
  });
  expect(osNotificationsOn(storage(null))).toBe(true);
  expect(osNotificationsOn(storage("on"))).toBe(true);
  expect(osNotificationsOn(storage("off"))).toBe(false);
  expect(osNotificationsOn(null)).toBe(true);
});

test("a toast says what happened, in which project, its first line, and opens the room", () => {
  const html = renderToStaticMarkup(
    <Toasts
      toasts={[{ kind: "question", project: "harbor", name: "Harbor", line: "Ship HAR-15?", tag: "harbor:question" }]}
      close={() => {}}
      open={() => {}}
    />,
  );
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain('data-toast="question"');
  const words = html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  expect(words).toBe("Question for you Harbor Ship HAR-15? Open the room");
  expect(html).toContain('aria-label="Dismiss"');
});

const ORIGIN = "http://notify.test";

describe("the notifications in a browser", () => {
  let browser: Browser | undefined;
  let bundle = "";

  // The page's bundle and the headless shell (installed before the suite) are setup, not behaviour deadlines.
  beforeAll(async () => {
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "notify-page.tsx")],
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

  async function open(): Promise<Page> {
    if (!browser) throw new Error("browser setup did not complete");
    const context = await browser.newContext();
    const page = await context.newPage();
    // No network: the page and its script are served here, anything else is refused.
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === ORIGIN && url.pathname === "/")
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><div id="root"></div><script type="module" src="/notify.js"></script>',
        });
      if (url.href === `${ORIGIN}/notify.js`) return route.fulfill({ contentType: "text/javascript", body: bundle });
      return route.abort();
    });
    await page.goto(`${ORIGIN}/#/projects/harbor`);
    await page.locator("[data-toasts]").waitFor({ state: "attached", timeout: 5_000 });
    return page;
  }

  const elapse = (page: Page, ms: number) =>
    page.evaluate((n) => (window as unknown as { daemon: { elapse(ms: number): void } }).daemon.elapse(n), ms);
  const readCount = (page: Page) =>
    page.evaluate(() => (window as unknown as { daemon: { reads: number } }).daemon.reads);

  /** Lantern's coordinator answers: a turn from 0:11 to 0:16 whose reading holds what it wrote. */
  // Handed over as JSON: Playwright's argument types do not unwind a tool's JSON input.
  const answer = (page: Page) =>
    page.evaluate((json) => {
      const daemon = (window as unknown as { daemon: { reading(i: unknown): void; emit(f: unknown): void } }).daemon;
      daemon.reading(JSON.parse(json));
      daemon.emit({
        type: "chat.turn",
        project: "lantern",
        state: "idle",
        since: "2026-03-10T15:00:00.000Z",
        queued: 0,
      });
      daemon.emit({
        type: "chat.turn",
        project: "lantern",
        state: "thinking",
        since: "2026-03-10T15:00:11.000Z",
        queued: 0,
      });
      daemon.emit({
        type: "chat.turn",
        project: "lantern",
        state: "idle",
        since: "2026-03-10T15:00:16.000Z",
        queued: 0,
      });
    }, JSON.stringify(ANSWERED));

  test("a toast in the live region, held while hovered, gone on its own after its time; Open the room opens it", async () => {
    const page = await open();
    expect(await page.evaluate(() => document.hasFocus())).toBe(true);
    await answer(page);
    const toast = page.locator('[aria-live="polite"] [data-toast="answered"]');
    await toast.waitFor({ timeout: 2_000 });
    expect(await toast.locator("p").allTextContents()).toEqual(["Coordinator answered", "LanternBerths"]);
    expect(await toast.locator("p span").allTextContents()).toEqual(["Lantern", "Berths"]);
    // Held while the pointer is on it, however long: its timer is cancelled.
    await toast.hover();
    await page.waitForFunction(
      () => (window as unknown as { daemon: { pending: number } }).daemon.pending === 0,
      undefined,
      {
        timeout: 2_000,
      },
    );
    await elapse(page, 60_000);
    expect(await toast.count()).toBe(1);
    // Left alone, it goes.
    const box = await toast.boundingBox();
    await page.mouse.move(10, (box?.y ?? 0) + (box?.height ?? 0) + 200);
    // Released: its time starts again once its timer is set.
    await page.waitForFunction(
      () => (window as unknown as { daemon: { pending: number } }).daemon.pending === 1,
      undefined,
      {
        timeout: 2_000,
      },
    );
    await elapse(page, TOAST_MS - 1);
    expect(await toast.count()).toBe(1);
    await elapse(page, 1);
    await toast.waitFor({ state: "detached", timeout: 2_000 });

    // Another answer; its button opens Lantern's room and closes it.
    await answer(page);
    await toast.waitFor({ timeout: 2_000 });
    await toast.getByRole("button", { name: "Open the room" }).click();
    expect(await page.evaluate(() => location.hash)).toBe("#/projects/lantern");
    await toast.waitFor({ state: "detached", timeout: 2_000 });
    // In Lantern's room now: its next answer tells nothing, its conversation not even read.
    const reads = await readCount(page);
    await answer(page);
    expect(await readCount(page)).toBe(reads);
    expect(await toast.count()).toBe(0);
    await page.context().close();
  }, 20_000);

  test("opening the room another way clears its toast; Dismiss closes one", async () => {
    const page = await open();
    const toast = page.locator('[data-toast="answered"]');
    await answer(page);
    await toast.waitFor({ timeout: 2_000 });
    await page.evaluate(() => {
      location.hash = "#/projects/lantern";
    });
    await toast.waitFor({ state: "detached", timeout: 2_000 });
    await page.evaluate(() => {
      location.hash = "#/settings";
    });
    await answer(page);
    await toast.getByRole("button", { name: "Dismiss" }).click();
    await toast.waitFor({ state: "detached", timeout: 2_000 });
    await page.context().close();
  }, 20_000);

  test("the Settings switch is on by default and keeps off on this device", async () => {
    const page = await open();
    const toggle = page.getByRole("switch", { name: "OS notifications" });
    expect(await toggle.getAttribute("aria-checked")).toBe("true");
    // No stylesheet here gives the switch a size: it is pressed as a click would.
    await toggle.dispatchEvent("click");
    expect(await toggle.getAttribute("aria-checked")).toBe("false");
    expect(await page.evaluate((key) => localStorage.getItem(key), OS_NOTIFICATIONS_KEY)).toBe("off");
    await page.reload();
    expect(await page.getByRole("switch", { name: "OS notifications" }).getAttribute("aria-checked")).toBe("false");
    await page.context().close();
  }, 20_000);
});
