import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ChatItem } from "@armada/protocol";
import { type Browser, chromium, type Page } from "playwright-core";
import { renderToStaticMarkup } from "react-dom/server";
import { readFleetState } from "../src/fleet/state";
import type { Chat } from "../src/room/chat";
import { STARTER_ASKS, starterAsks } from "../src/room/view";
import { RoomView } from "../src/screens/Room";

// The empty room's hero (THE-2055), after T3 Code's draft hero: the starter
// asks the fleet's facts allow, on synthetic folded states; the hero on an
// empty conversation and gone once something is said; then in Chromium, on a
// fake daemon client (test/room-live-page.tsx), a chip sends its words and the
// field glides down to its dock (and does not, under reduced motion).

const AT = "2026-03-10T09:00:00.000Z";
const NOW = Date.parse("2026-03-10T15:00:00.000Z");
const PROJECT = { id: "harbor", name: "Harbor", repository: "example/harbor" };

const session = (ticket: string, state: string) => ({
  ticket,
  session: `s-${ticket}`,
  title: `${ticket}'s work`,
  phase: state === "blocked" ? "blocked" : "implementing",
  state,
  reason: "",
  flowStep: "implementing",
  at: AT,
});
const ticket = (id: string, more: Record<string, unknown> = {}) => ({ id, status: "unstarted", ...more });
const pr = (number: number, ticket: string, more: Record<string, unknown> = {}) => ({
  number,
  ticket,
  state: "open",
  ci: "success",
  conflicting: false,
  ...more,
});
const fold = (o: Record<string, unknown>) => readFleetState(o);

test("Sum up today always; each other ask only when its fact holds", () => {
  expect(starterAsks(fold({}))).toEqual([STARTER_ASKS.today]);
  expect(
    starterAsks(
      fold({
        sessions: [session("HAR-1", "blocked")],
        tickets: [ticket("HAR-2")],
        pullRequests: [pr(41, "HAR-3")],
      }),
    ),
  ).toEqual(["What is blocked?", "Launch what is ready", "Merge what is green", "Sum up today"]);
});

test("What is blocked? only for a blocked session", () => {
  expect(starterAsks(fold({ sessions: [session("HAR-1", "in-progress"), session("HAR-4", "released")] }))).toEqual([
    STARTER_ASKS.today,
  ]);
  expect(starterAsks(fold({ sessions: [session("HAR-1", "blocked")] }))).toContain(STARTER_ASKS.blocked);
});

test("Launch what is ready: a leaf not started, its blockers done, held by nobody, with no open pull request", () => {
  const launch = (o: Record<string, unknown>) => starterAsks(fold(o)).includes(STARTER_ASKS.launch);
  expect(launch({ tickets: [ticket("HAR-2")] })).toBe(true);
  expect(
    launch({ tickets: [ticket("HAR-2", { status: "backlog", blockers: [{ id: "HAR-1", status: "completed" }] })] }),
  ).toBe(true);
  // Each fact that keeps it from launching.
  expect(launch({ tickets: [ticket("HAR-2", { status: "started" })] })).toBe(false);
  expect(launch({ tickets: [ticket("HAR-2", { status: "completed" })] })).toBe(false);
  expect(launch({ tickets: [ticket("HAR-2", { phase: "planning" })] })).toBe(false);
  expect(launch({ tickets: [ticket("HAR-2", { blockers: [{ id: "HAR-1", status: "started" }] })] })).toBe(false);
  expect(launch({ tickets: [ticket("HAR-2")], sessions: [session("HAR-2", "in-progress")] })).toBe(false);
  expect(launch({ tickets: [ticket("HAR-2")], pullRequests: [pr(41, "HAR-2", { ci: "pending" })] })).toBe(false);
  expect(launch({ tickets: [ticket("HAR-2"), ticket("HAR-9", { status: "started", parent: "HAR-2" })] })).toBe(false);
  // A ticket the fold reads without a status (an older reader) is never said ready.
  expect(launch({ tickets: [{ id: "HAR-2" }] })).toBe(false);
});

test("Merge what is green: an open pull request, green and without a conflict", () => {
  const merge = (p: Record<string, unknown>) =>
    starterAsks(fold({ pullRequests: [pr(41, "HAR-3", p)] })).includes(STARTER_ASKS.merge);
  expect(merge({})).toBe(true);
  expect(merge({ ci: "pending" })).toBe(false);
  expect(merge({ ci: "failure" })).toBe(false);
  expect(merge({ conflicting: true })).toBe(false);
  expect(merge({ state: "merged" })).toBe(false);
});

function render(chat: Partial<Chat>, state: Record<string, unknown> = {}) {
  const full: Chat = {
    status: "ready",
    coordinator: true,
    items: [],
    problem: null,
    send: async () => {},
    answer: async () => {},
    ...chat,
  };
  return renderToStaticMarkup(
    <RoomView project={PROJECT} snapshot={{ state }} live now={NOW} zone="UTC" chat={full} />,
  );
}
const chips = (html: string) =>
  [
    ...(html.match(/<ul aria-label="Starter asks".*?<\/ul>/)?.[0] ?? "").matchAll(/<button[^>]*>([^<]+)<\/button>/g),
  ].map((m) => m[1]);

test("an empty conversation shows the hero, the field under it and the chips its fold allows", () => {
  const html = render({}, { sessions: [session("HAR-1", "blocked")], pullRequests: [pr(41, "HAR-3")] });
  expect(html).toMatch(/<h2[^>]*class="[^"]*text-hero [^"]*sm:text-hero-lg[^"]*"[^>]*>What should we work on\?<\/h2>/);
  // The headline, then the field, then the chips; no thread yet.
  const [headline, field, asks] = [
    "data-hero",
    'aria-label="Message the coordinator"',
    'aria-label="Starter asks"',
  ].map((marker) => html.indexOf(marker));
  expect(headline).toBeGreaterThan(-1);
  expect(field).toBeGreaterThan(headline ?? 0);
  expect(asks).toBeGreaterThan(field ?? 0);
  expect(html).not.toContain("data-thread");
  expect(chips(html)).toEqual(["What is blocked?", "Merge what is green", "Sum up today"]);
  // The page's one h1 is still its title.
  expect(html.match(/<h1\b/g)).toHaveLength(1);
});

test("no hero once something is said, while the conversation is read, or with the coordinator at work", () => {
  const owner: ChatItem = { kind: "owner", id: "e1", at: AT, body: "Check the berths." };
  for (const chat of [
    { items: [owner] },
    { status: "reading" as const },
    {
      live: {
        turn: {
          type: "chat.turn",
          version: { major: 1, minor: 7 },
          project: "harbor",
          state: "thinking",
          since: AT,
          queued: 0,
        } as const,
        started: AT,
        entries: [],
      },
    },
  ]) {
    const html = render(chat);
    expect(html).not.toContain("What should we work on?");
    expect(html).not.toContain('aria-label="Starter asks"');
    expect(html).toContain("data-thread");
  }
});

test("without a coordinator the chips are disabled with the field", () => {
  const html = render({ coordinator: false });
  expect(html).toContain("What should we work on?");
  expect(html).toMatch(/<button type="button" disabled=""[^>]*>Sum up today<\/button>/);
});

const ORIGIN = "http://hero.test";
/**
 * The page has no Tailwind build: these are the few utilities that lay out the room's column (the hero's two
 * halves around the field, the thread above it), so where the field stands means what it means in the app.
 */
const LAYOUT = [
  ".flex{display:flex}",
  ".flex-col{flex-direction:column}",
  ".flex-1{flex:1 1 0%}",
  ".flex-none{flex:none}",
  ".min-h-0{min-height:0}",
  ".h-full{height:100%}",
  ".justify-end{justify-content:flex-end}",
  ".overflow-hidden{overflow:hidden}",
  ".overflow-y-auto{overflow-y:auto}",
  ".relative{position:relative}",
  ".h-50{height:200px}",
  ".absolute{position:absolute}",
  ".inset-0{inset:0}",
].join("");

describe("the hero in a browser", () => {
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

  async function open(reducedMotion: "reduce" | "no-preference"): Promise<Page> {
    if (!browser) throw new Error("browser setup did not complete");
    const context = await browser.newContext({ reducedMotion, viewport: { width: 1000, height: 760 } });
    const page = await context.newPage();
    // No network: the page and its script are served here, anything else is refused.
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === ORIGIN && url.pathname === "/")
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html style="height:100%"><style>${LAYOUT}</style><body style="height:100%;margin:0"><div id="root" style="height:100%"></div><script type="module" src="/room.js"></script></body></html>`,
        });
      if (url.href === `${ORIGIN}/room.js`) return route.fulfill({ contentType: "text/javascript", body: bundle });
      return route.abort();
    });
    await page.goto(`${ORIGIN}/?minor=7`);
    await page.locator("[data-hero]").waitFor({ timeout: 5_000 });
    return page;
  }

  /** Where the field stands two frames after the hero leaves: still on its way, or already docked. */
  const watchDock = (page: Page) =>
    page.evaluate(() => {
      const probe = window as unknown as { early?: number };
      new MutationObserver((_, observer) => {
        if (document.querySelector("[data-hero]")) return;
        observer.disconnect();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const box = document.querySelector("[data-dock]")?.getBoundingClientRect();
            probe.early = box ? window.innerHeight - box.bottom : -1;
          }),
        );
      }).observe(document.body, { childList: true, subtree: true });
    });
  /** The field's distance to the window's bottom two frames after the hero left. */
  const early = (page: Page) =>
    page
      .waitForFunction(() => (window as unknown as { early?: number }).early !== undefined, undefined, {
        timeout: 2_000,
      })
      .then(() => page.evaluate(() => (window as unknown as { early: number }).early));
  const dockBottom = (page: Page) =>
    page.evaluate(() => {
      const box = document.querySelector("[data-dock]")?.getBoundingClientRect();
      return { bottom: box?.bottom ?? 0, centre: box ? box.top + box.height / 2 : 0, height: window.innerHeight };
    });
  /** The field at its dock, its glide over. */
  const docked = (page: Page) =>
    page.waitForFunction(
      () => {
        const box = document.querySelector("[data-dock]")?.getBoundingClientRect();
        return !!box && Math.abs(window.innerHeight - box.bottom) < 2;
      },
      undefined,
      { timeout: 2_000 },
    );

  test("a chip sends its words; the hero leaves and the field glides down to its dock", async () => {
    const page = await open("no-preference");
    // Between the headline and the chips: far from the bottom of the window.
    const before = await dockBottom(page);
    expect(before.height - before.bottom).toBeGreaterThan(100);
    const [headline, chips] = await Promise.all([
      page.locator("[data-hero]").boundingBox(),
      page.locator("[data-asks]").boundingBox(),
    ]);
    expect(before.centre).toBeGreaterThan((headline?.y ?? 0) + (headline?.height ?? 0));
    expect(before.centre).toBeLessThan(chips?.y ?? 0);
    await watchDock(page);
    await page.getByRole("button", { name: "Sum up today" }).click();
    await page.locator("[data-hero]").waitFor({ state: "detached", timeout: 2_000 });
    const sends = (
      await page.evaluate(
        () => (window as unknown as { daemon: { requests: Record<string, unknown>[] } }).daemon.requests,
      )
    ).filter((r) => r.type === "chat.send");
    expect(sends.map((r) => r.body)).toEqual(["Sum up today"]);
    // Two frames on, it is still on its way down; the message is in the thread, and the field docks under it.
    expect(await early(page)).toBeGreaterThan(20);
    await page.locator('[data-item="owner"]').getByText("Sum up today").waitFor({ timeout: 2_000 });
    await docked(page);
    await page.context().close();
  }, 20_000);

  test("under reduced motion the field docks at once", async () => {
    const page = await open("reduce");
    await watchDock(page);
    await page.getByRole("button", { name: "Sum up today" }).click();
    await page.locator("[data-hero]").waitFor({ state: "detached", timeout: 2_000 });
    expect(Math.abs(await early(page))).toBeLessThan(2);
    await docked(page);
    await page.context().close();
  }, 20_000);
});
