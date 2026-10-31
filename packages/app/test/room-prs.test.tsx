import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fold } from "@armada/daemon/fold";
import type { EventInput } from "@armada/protocol";
import type { Page } from "playwright-core";
import { renderToStaticMarkup } from "react-dom/server";
import { fleetItems } from "../src/fleet/overview";
import { readFleetState } from "../src/fleet/state";
import { type Merging, PullRequests } from "../src/room/PullRequests";
import {
  checkHref,
  forgeReads,
  type MergeHold,
  type OpenPullRequest,
  openPullRequests,
  stepHold,
} from "../src/room/pr-rules";
import { type RoomBrowser, roomBrowser, settled } from "./room-browser";

// The panel's Pull requests (THE-2086), after T3 Code's pull request rows, on
// a synthetic fold folded by the daemon itself: a Ready pull request, a red
// one, one whose checks run, a draft and one in conflict with main. Its rules
// first, its markup, then the room in Chromium on a fake daemon client
// (test/room-panel-page.tsx): Merge asks the coordinator in the chat and holds
// "Merging…" until the coordinator's turn ends or the fold sees the merge.

const AT = "2026-03-10T09:00:00.000Z";
const NOW = Date.parse("2026-03-10T15:00:00.000Z");
type Of<K extends EventInput["kind"]> = Extract<EventInput, { kind: K }>["payload"];
const e = <K extends EventInput["kind"]>(kind: K, payload: Of<K>, actor = "worker") =>
  ({ project: "harbor", kind, at: AT, actor, payload }) as EventInput;

/** A ticket in flight at `phase`. */
const agent = (id: string, title: string, phase: Of<"session.reported">["phase"]) => [
  e("ticket.seen", { id, title, status: "started" }, "tracker"),
  e("session.claimed", {
    ticket: id,
    session: `s-${id}`,
    generation: 1,
    owner: "default",
    runtime: "claude",
    handle: `h-${id}`,
  }),
  e("session.reported", { ticket: id, session: `s-${id}`, phase, reason: phase }),
];
type Pull = Of<"pull-request.opened">;
const pull = (number: number, ticket: string, title: string, more: Partial<Pull> = {}): Pull => ({
  repository: "example/harbor",
  number,
  ticket,
  title,
  url: `https://github.com/example/harbor/pull/${number}`,
  state: "open",
  head: `${number}c46a81f00d2b8e0c1a5e7d6b3f9a2c4e8d1b7a`,
  headRef: `feature/${ticket.toLowerCase()}`,
  draft: false,
  conflicting: false,
  review: "none",
  ci: "success",
  checks: [],
  checksComplete: true,
  ...more,
});
const green = (name: string, runId: number) => ({ name, state: "success" as const, runId, runAttempt: 1 });

const LOG: EventInput[] = [
  ...agent("HAR-31", "The daemon signs in to Armada", "ready-to-merge"),
  ...agent("HAR-32", "Price berths by the hour", "shipping"),
  ...agent("HAR-33", "Show the pilot's schedule", "shipping"),
  ...agent("HAR-34", "Let skippers book a berth", "implementing"),
  ...agent("HAR-9", "Name the harbour's quays", "ready-to-merge"),
  e(
    "pull-request.opened",
    pull(374, "HAR-31", "The daemon signs in to Armada as armada login does", {
      checks: [green("build", 11), green("lint", 11), green("test", 12), green("typecheck", 12)],
    }),
    "github",
  ),
  e(
    "pull-request.opened",
    pull(375, "HAR-32", "Price berths by the hour", {
      ci: "failure",
      checks: [green("lint", 21), { name: "test", state: "failure", runId: 22, runAttempt: 2 }],
    }),
    "github",
  ),
  e(
    "pull-request.opened",
    pull(376, "HAR-33", "Show the pilot's schedule", {
      ci: "pending",
      checks: [green("lint", 31), { name: "e2e", state: "pending" }],
    }),
    "github",
  ),
  e("pull-request.opened", pull(377, "HAR-34", "Let skippers book a berth", { draft: true, ci: "none" }), "github"),
  e(
    "pull-request.opened",
    pull(369, "HAR-9", "Name the harbour's quays", { conflicting: true, review: "changes_requested" }),
    "github",
  ),
];
/** The fold of a log, as the page's seed and `window.daemon.show` take it. */
const reading = (log: EventInput[]) => {
  const events = log.map((x, i) => ({ ...x, seq: i + 1 }));
  return { state: fold(events).projects.harbor, events };
};
const prsOf = (log: EventInput[]) => {
  const state = readFleetState(reading(log).state);
  return openPullRequests(state, fleetItems([{ id: "harbor", state }], { now: NOW, zone: "UTC" }));
};

test("Ready first, then by ticket; each pull request says its state, most pressing first", () => {
  const prs = prsOf(LOG);
  expect(prs.map((p) => `#${p.number} ${p.ticket} ${p.word}`)).toEqual([
    "#374 HAR-31 ready",
    // HAR-9 is ready to merge, but its conflict says first.
    "#369 HAR-9 conflicts",
    "#375 HAR-32 red",
    "#376 HAR-33 running",
    "#377 HAR-34 draft",
  ]);
  // A merged pull request, or one of a ticket no longer in flight, is not open here.
  const merged = prsOf([...LOG, e("pull-request.merged", pull(374, "HAR-31", "x", { state: "merged" }), "github")]);
  expect(merged.map((p) => p.number)).not.toContain(374);
});

test("a check opens its Actions run, its attempt past the first; without a run, the pull request's checks", () => {
  const pr = { number: 375, url: "https://github.com/example/harbor/pull/375" };
  expect(checkHref({ name: "lint", state: "success", runId: 21, runAttempt: 1 }, pr, "example/harbor")).toBe(
    "https://github.com/example/harbor/actions/runs/21",
  );
  expect(checkHref({ name: "test", state: "failure", runId: 22, runAttempt: 2 }, pr, "example/harbor")).toBe(
    "https://github.com/example/harbor/actions/runs/22/attempts/2",
  );
  expect(checkHref({ name: "e2e", state: "pending" }, pr, "example/harbor")).toBe(
    "https://github.com/example/harbor/pull/375/checks",
  );
});

test("Merge holds until the coordinator answered its message and its turn is over, or the pull request leaves", () => {
  const open = new Set([374]);
  const owner = (id: string, body: string) => ({ kind: "owner" as const, id, body });
  const line = (id: string) => ({ kind: "coordinator" as const, id, body: "…" });
  // An earlier Merge #374, answered: the new hold is not about it.
  const before = [owner("o1", "Merge #374"), line("c1")];
  const hold: MergeHold = { pr: 374, earlier: new Set(["o1"]) };
  const idle = { state: "idle" as const };
  // The message is not in the conversation yet: an idle turn (the last one's end) does not release it.
  expect(stepHold(hold, { open, items: before, turn: idle })).toBe(hold);
  // It is: the turn calls a tool after it, still running, then the coordinator's answer and its turn ends.
  const asked = [...before, owner("o2", "Merge #374")];
  expect(stepHold(hold, { open, items: asked, turn: idle })).toBe(hold);
  expect(stepHold(hold, { open, items: [...asked, line("t1")], turn: { state: "tool" } })).toBe(hold);
  expect(stepHold(hold, { open, items: [...asked, line("t1"), line("c2")], turn: idle })).toBeNull();
  // A missed frame: the answer is read while the turn shows idle all along. An older daemon without a live turn too.
  expect(stepHold(hold, { open, items: [...asked, line("c2")], turn: null })).toBeNull();
  // Older lines rolling out of the conversation's window change nothing.
  expect(stepHold(hold, { open, items: [owner("o2", "Merge #374")], turn: idle })).toBe(hold);
  // Merged: the fold no longer lists it open, whatever the conversation says.
  expect(stepHold(hold, { open: new Set(), items: before, turn: { state: "writing" } })).toBeNull();
});

test("pull requests read while a forge is connected, or before the daemon lists its providers", () => {
  const forge = (state: "connected" | "disconnected" | "missing", enabled = true) => ({
    seam: "forge" as const,
    state,
    enabled,
  });
  expect(forgeReads(null)).toBe(true);
  expect(forgeReads([forge("connected")])).toBe(true);
  expect(forgeReads([forge("disconnected")])).toBe(false);
  expect(forgeReads([forge("connected", false)])).toBe(false);
  expect(forgeReads([{ seam: "tracker", state: "connected", enabled: true }])).toBe(false);
});

const render = (prs: readonly OpenPullRequest[], more: { reads?: boolean; merging?: Merging } = {}) =>
  renderToStaticMarkup(
    <PullRequests
      prs={prs}
      repository="example/harbor"
      ticketHref={(t) => `#/projects/harbor?panel=prs&agent=${t}`}
      merging={more.merging ?? { held: new Set(), problem: null, merge() {} }}
      {...(more.reads === undefined ? {} : { reads: more.reads })}
    />,
  );
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replace(/\s+/g, " ")
    .trim();
/** Each row's markup, by its number; `words` without its checks' names (read from the strip on their own). */
const rowsOf = (html: string) =>
  html
    .split('<li data-pr-row="')
    .slice(1)
    .map((row) => ({
      pr: row.slice(0, row.indexOf('"')),
      html: row,
      words: text(row.slice(row.indexOf(">") + 1).replace(/<ul aria-label="Checks".*?<\/ul>/, "")),
    }));

test("a row: its number, title, ticket, short head, checks as dots that open their runs, its state; Merge on Ready only", () => {
  const rows = rowsOf(render(prsOf(LOG)));
  expect(rows.map((r) => r.words)).toEqual([
    "#374 The daemon signs in to Armada as armada login does Merge HAR-31 374c46a Ready",
    "#369 Name the harbour's quays HAR-9 369c46a Conflicts Changes requested",
    "#375 Price berths by the hour HAR-32 375c46a Red CI · test",
    "#376 Show the pilot's schedule HAR-33 376c46a Checks running",
    "#377 Let skippers book a berth HAR-34 377c46a Draft",
  ]);
  const [ready, , red] = rows;
  // One dot per check, named by its title, opening its run.
  const dots = (html: string) =>
    [...html.matchAll(/<li class="flex"><a href="([^"]+)"[^>]*title="([^"]+)" data-check="([a-z]+)"/g)].map(
      (m) => `${m[2]} ${m[3]} ${m[1]}`,
    );
  expect(dots(ready?.html ?? "")).toEqual([
    "build: passed success https://github.com/example/harbor/actions/runs/11",
    "lint: passed success https://github.com/example/harbor/actions/runs/11",
    "test: passed success https://github.com/example/harbor/actions/runs/12",
    "typecheck: passed success https://github.com/example/harbor/actions/runs/12",
  ]);
  expect(dots(red?.html ?? "")).toEqual([
    "lint: passed success https://github.com/example/harbor/actions/runs/21",
    "test: failed failure https://github.com/example/harbor/actions/runs/22/attempts/2",
  ]);
  // The row opens the pull request; the ticket its agent's page.
  expect(ready?.html).toContain('href="https://github.com/example/harbor/pull/374"');
  expect(ready?.html).toContain('href="#/projects/harbor?panel=prs&amp;agent=HAR-31"');
  // Merge is on the Ready row only.
  expect(rows.filter((r) => r.html.includes("data-merge")).map((r) => r.pr)).toEqual(["374"]);
});

test("Merge held says Merging…; nothing open says so; a disconnected forge points to Settings", () => {
  const held = render(prsOf(LOG), { merging: { held: new Set([374]), problem: null, merge() {} } });
  expect(rowsOf(held)[0]?.words).toContain("Merging…");
  expect(text(render([]))).toBe("No open pull request");
  const off = render([], { reads: false });
  expect(text(off)).toBe("Connect GitHub in Settings to read pull requests");
  expect(off).toContain('href="#/settings/providers"');
  expect(off).not.toContain("No open pull request");
});

describe("the panel's Pull requests in a browser", () => {
  let room: RoomBrowser | undefined;

  // The page's bundle, its styles and the headless shell (installed before the suite) are setup, not behaviour deadlines.
  beforeAll(async () => {
    room = await roomBrowser(JSON.stringify(reading(LOG)));
  }, 60_000);
  afterAll(async () => {
    await room?.close();
  }, 10_000);

  const open = (hash?: string): Promise<Page> => {
    if (!room) throw new Error("browser setup did not complete");
    return room.open(1280, hash);
  };
  const panel = (page: Page) => page.getByRole("complementary", { name: "Panel" });
  const hash = (page: Page) => page.evaluate(() => window.location.hash);
  const sent = (page: Page) =>
    page.evaluate(() =>
      (window as unknown as { daemon: { requests: Record<string, unknown>[] } }).daemon.requests
        .filter((r) => r.type === "chat.send")
        .map((r) => r.body),
    );
  const turn = (page: Page, state: "idle" | "thinking" | "tool") =>
    page.evaluate(
      (s) =>
        (window as unknown as { daemon: { frame(f: unknown): void } }).daemon.frame({
          type: "chat.turn",
          version: { major: 1, minor: 7 },
          project: "harbor",
          state: s,
          since: "2026-03-10T15:00:00.000Z",
          queued: 0,
        }),
      state,
    );

  const say = (page: Page, items: unknown[]) =>
    page.evaluate(
      (json) => (window as unknown as { daemon: { say(i: unknown): void } }).daemon.say(JSON.parse(json)),
      JSON.stringify(items),
    );
  // Said now: the room matches a message it sent with the reading's by its words and its time, from the page's clock.
  const said = (id: string, second: number, body: string, kind: "owner" | "coordinator" = "owner") => ({
    kind,
    id,
    at: new Date(Date.now() + second * 1000).toISOString(),
    body,
  });

  test("the ready pill opens Pull requests, its count in the tab; Merge asks the coordinator and holds until it answers or merges", async () => {
    const page = await open();
    const side = panel(page);
    // The tab says how many are open, two words for a screen reader; the header's ready to merge opens it.
    await settled(() => side.getByRole("tab", { name: "Pull requests 5" }).count(), 1);
    await page.locator('[data-pill="ready"]').click();
    await settled(() => hash(page), "#/projects/harbor?panel=prs");
    const merge = side.locator("[data-merge]");
    await settled(() => merge.count(), 1);

    // Merge while the coordinator's last turn is ending: "Merge #374" in the chat, then Merging….
    await turn(page, "tool");
    await merge.click();
    await settled(() => sent(page), ["Merge #374"]);
    await settled(() => merge.innerText(), "Merging…");
    expect(await merge.isDisabled()).toBe(true);
    // That turn's end is not the answer: nothing after the message yet.
    await turn(page, "idle");
    await turn(page, "tool");
    await say(page, [said("o1", 1, "Merge #374")]);
    await settled(() => merge.innerText(), "Merging…");
    // The coordinator refused (its answer is in the thread) and its turn ended: the pull request is still open, Merge comes back.
    await say(page, [
      said("o1", 1, "Merge #374"),
      said("c1", 2, "#374 has 2 unresolved review threads.", "coordinator"),
    ]);
    await settled(() => merge.innerText(), "Merging…");
    await turn(page, "idle");
    await settled(() => merge.innerText(), "Merge");
    // A later turn of the coordinator does not hold the row again.
    await turn(page, "thinking");
    await settled(() => merge.innerText(), "Merge");
    await turn(page, "idle");

    // Again, and this time the fold sees it merged: the row leaves, the count follows.
    await merge.click();
    await settled(() => merge.innerText(), "Merging…");
    const merged = JSON.stringify(
      reading([...LOG, e("pull-request.merged", pull(374, "HAR-31", "x", { state: "merged" }), "github")]),
    );
    await page.evaluate(
      (json) => (window as unknown as { daemon: { show(n: unknown): void } }).daemon.show(JSON.parse(json)),
      merged,
    );
    await settled(() => side.locator('[data-pr-row="374"]').count(), 0);
    await settled(() => side.getByRole("tab", { name: "Pull requests 4" }).count(), 1);
    await settled(() => sent(page), ["Merge #374", "Merge #374"]);
  });

  test("a Merge the daemon refuses gives the button back, with its line under the row; a ticket keeps the tab", async () => {
    const page = await open("#/projects/harbor?panel=prs");
    const side = panel(page);
    const merge = side.locator("[data-merge]");
    await settled(() => merge.innerText(), "Merge");
    await page.evaluate(() =>
      (window as unknown as { daemon: { refuse(l: string): void } }).daemon.refuse("The coordinator is restarting"),
    );
    await merge.click();
    await settled(() => merge.innerText(), "Merge");
    await settled(
      () => side.locator('[data-pr-row="374"] [role="alert"]').innerText(),
      "The coordinator is restarting",
    );
    // The ticket's id shows its agent, the panel kept on Pull requests.
    await side.locator('[data-pr-row="374"]').getByRole("link", { name: "HAR-31" }).click();
    await settled(() => hash(page), "#/projects/harbor?panel=prs&agent=HAR-31");
  });

  test("a disconnected forge points to Settings above the list", async () => {
    const page = await open("#/projects/harbor?panel=prs");
    const side = panel(page);
    await side.locator("[data-pr-row]").first().waitFor();
    await page.evaluate(() =>
      (window as unknown as { daemon: { providers(p: unknown): void } }).daemon.providers([
        {
          id: "github",
          seam: "forge",
          name: "GitHub",
          mark: "github",
          state: "disconnected",
          enabled: true,
          config: {},
          restartRequired: false,
        },
      ]),
    );
    const link = side.getByRole("link", { name: "Connect GitHub in Settings" });
    await settled(() => link.getAttribute("href"), "#/settings/providers");
  });
});
