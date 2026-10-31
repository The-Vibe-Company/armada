import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fold } from "@armada/daemon/fold";
import type { EventInput } from "@armada/protocol";
import type { Page } from "playwright-core";
import { sampleEvents } from "../scripts/dev-daemon";
import { agentKey, agentStep } from "../src/room/panel-rules";
import { type RoomBrowser, roomBrowser, settled } from "./room-browser";

// An agent's page in the room's lane (THE-2089), after T3 Code's thread view
// swapping under a sidebar that keeps its place: the hop's rules on synthetic
// input, then the room in Chromium on a fake daemon client
// (test/room-panel-page.tsx) over the daemon's own fold of a synthetic log:
// a row shows its agent in place of the chat, the panel kept open on it; the
// keys hop between agents; the Coordinator and Escape bring the chat back as
// it was; the lane's buttons act; an agent that hands back or is released
// stays on screen; the sheet of a narrow window closes on a row.

test("↑ and ↓ walk the agents in the list's order, the Coordinator first, the ends holding", () => {
  const order = ["HAR-12", "HAR-15", "HAR-18"];
  expect(agentStep(order, null, 1)).toBe("HAR-12");
  expect(agentStep(order, "HAR-12", 1)).toBe("HAR-15");
  expect(agentStep(order, "HAR-12", -1)).toBeNull();
  expect(agentStep(order, null, -1)).toBeNull();
  expect(agentStep(order, "HAR-18", 1)).toBe("HAR-18");
  // An agent no longer in the list (released) steps from the Coordinator.
  expect(agentStep(order, "HAR-30", 1)).toBe("HAR-12");
  const key = (k: string, more: Partial<KeyboardEvent> = {}) =>
    agentKey({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...more });
  expect(["ArrowUp", "k", "ArrowDown", "j", "Escape"].map((k) => key(k))).toEqual([
    { kind: "step", by: -1 },
    { kind: "step", by: -1 },
    { kind: "step", by: 1 },
    { kind: "step", by: 1 },
    { kind: "chat" },
  ]);
  // The panel's and the field's own chords are not the lane's.
  expect(key("ArrowDown", { metaKey: true })).toBeNull();
  expect(key("j", { shiftKey: true })).toBeNull();
  expect(key("x")).toBeNull();
});

const AT = "2026-03-10T09:00:00.000Z";
/** Harbor's sample log and a worker's question on HAR-12: the agents read HAR-12, HAR-15, HAR-18, HAR-20, HAR-9. */
const LOG: EventInput[] = [
  ...sampleEvents(AT).filter((e) => e.project === "harbor"),
  {
    project: "harbor",
    kind: "inbox.opened",
    at: AT,
    actor: "worker",
    payload: {
      id: "q-har-12",
      ticket: "HAR-12",
      kind: "question",
      body: "Which tide table, the port's or the navy's?\n\nOptions:\n- the port's\n- the navy's",
    },
  },
];
/** The fold of a log, as the page's seed and `window.daemon.show` take it. */
const reading = (log: EventInput[]) => {
  const events = log.map((e, i) => ({ ...e, seq: i + 1 }));
  return { state: fold(events).projects.harbor, events };
};

describe("an agent's page in the room's lane, in a browser", () => {
  let room: RoomBrowser | undefined;

  // The page's bundle, its styles and the headless shell (installed before the suite) are setup, not behaviour deadlines.
  beforeAll(async () => {
    room = await roomBrowser(JSON.stringify(reading(LOG)));
  }, 60_000);
  afterAll(async () => {
    await room?.close();
  }, 10_000);

  const open = (width?: number, hash?: string): Promise<Page> => {
    if (!room) throw new Error("browser setup did not complete");
    return room.open(width, hash);
  };
  const panel = (page: Page) => page.getByRole("complementary", { name: "Panel" });
  const lane = (page: Page) => page.locator("[data-agent-lane]");
  const hash = (page: Page) => page.evaluate(() => window.location.hash);
  const current = (page: Page) =>
    panel(page)
      .locator('a[aria-current="page"]')
      .evaluateAll((els) => els.map((el) => el.closest("[data-row], [data-coordinator]")?.getAttribute("data-row")));
  const requests = (page: Page, type: string) =>
    page.evaluate(
      (t) =>
        (window as unknown as { daemon: { requests: Record<string, unknown>[] } }).daemon.requests.filter(
          (r) => r.type === t,
        ),
      type,
    );

  test("a row shows its agent in place of the chat, the panel open on it; ↓ hops; the Coordinator and Escape bring the chat back as it was", async () => {
    const page = await open();
    const side = panel(page);
    const field = page.getByLabel("Message", { exact: true });
    await field.fill("Merge HAR-20 once green");
    // The chat is the Coordinator's row, current.
    await settled(() => current(page), [null]);

    const row = side.locator('[data-row="harbor/HAR-15"] a[data-open]');
    await row.click();
    await settled(() => hash(page), "#/projects/harbor?panel=agents&agent=HAR-15");
    expect(await lane(page).locator("header").innerText()).toMatch(
      /^← Coordinator\s*·\s*HAR-15\s*·\s*Price berths by the hour$/,
    );
    await settled(() => lane(page).getByRole("region", { name: "State" }).getAttribute("data-state"), "blocked");
    await settled(() => lane(page).locator('[aria-current="step"]').innerText(), "Review & CI");
    // The chat is kept under the lane, out of reach; the panel stays open on the agent's row.
    await settled(() => field.isVisible(), false);
    await settled(() => side.isVisible(), true);
    await settled(() => current(page), ["harbor/HAR-15"]);

    // ↓ from the row: the next agent takes the lane, the focus on its row; the address is replaced, Back is not filled.
    const length = await page.evaluate(() => history.length);
    await page.keyboard.press("ArrowDown");
    await lane(page).getByRole("heading", { level: 2, name: "Let skippers book a berth from the quay" }).waitFor();
    await settled(() => current(page), ["harbor/HAR-18"]);
    await settled(
      () => page.evaluate(() => document.activeElement?.closest("[data-row]")?.getAttribute("data-row")),
      "harbor/HAR-18",
    );
    await settled(() => page.evaluate(() => history.length), length);
    // J and K too, from the lane; ↑ past the first agent is the chat.
    await lane(page).click({ position: { x: 600, y: 400 } });
    await page.keyboard.press("k");
    await settled(() => current(page), ["harbor/HAR-15"]);
    await page.keyboard.press("k");
    await settled(() => current(page), ["harbor/HAR-12"]);
    await page.keyboard.press("ArrowUp");
    await lane(page).waitFor({ state: "detached" });
    await settled(() => field.inputValue(), "Merge HAR-20 once green");

    // The Coordinator's row and Escape bring the chat back with its draft.
    await side.locator('[data-row="harbor/HAR-20"] a[data-open]').click();
    await lane(page).getByRole("heading", { level: 2, name: "Show the pilot's schedule" }).waitFor();
    await side.locator("[data-coordinator] a").click();
    await lane(page).waitFor({ state: "detached" });
    await settled(() => hash(page), "#/projects/harbor?panel=agents");
    await settled(() => field.isVisible(), true);
    await settled(() => field.inputValue(), "Merge HAR-20 once green");
    await side.locator('[data-row="harbor/HAR-9"] a[data-open]').click();
    await lane(page).waitFor();
    await page.keyboard.press("Escape");
    await lane(page).waitFor({ state: "detached" });
    await settled(() => current(page), [null]);
    // The project's name in the header is the way back too.
    await side.locator('[data-row="harbor/HAR-9"] a[data-open]').click();
    await page.getByRole("heading", { level: 1 }).getByRole("button", { name: "Harbor" }).click();
    await lane(page).waitFor({ state: "detached" });
    await settled(() => field.inputValue(), "Merge HAR-20 once green");
    await page.close();
  }, 20_000);

  test("the lane's Answer sends owner.answer; the drawer keeps its keys; ← Coordinator and Open full page lead away; a pill keeps the lane", async () => {
    const page = await open(1280, "#/projects/harbor?panel=log&agent=HAR-12");
    // An address naming an agent shows it, the panel on the tab it names.
    await settled(() => panel(page).getByRole("tab", { name: "Log" }).getAttribute("aria-selected"), "true");
    const card = lane(page).getByRole("region", { name: "State" });
    await card.getByText("Which tide table, the port's or the navy's?").waitFor();
    // A pill opens Agents at its group and leaves the lane as it is.
    await page.getByRole("button", { name: "2 blocked" }).click();
    await settled(() => hash(page), "#/projects/harbor?panel=agents&agent=HAR-12");
    await settled(() => lane(page).getAttribute("data-agent-lane"), "HAR-12");
    await card.getByRole("button", { name: "Answer" }).click();
    await card.getByRole("button", { name: "the navy's" }).click();
    await card.getByRole("status").getByText("Your answer is delivered to the worker.").waitFor();
    const answers = await requests(page, "owner.answer");
    expect(answers.map(({ project, item, choice }) => ({ project, item, choice }))).toEqual([
      { project: "harbor", item: "q-har-12", choice: "the navy's" },
    ]);

    // The worker's output drawer keeps its arrows and its Escape; the next Escape returns to the chat.
    await card.getByRole("button", { name: "Open the session" }).click();
    const drawer = page.getByRole("dialog", { name: "HAR-12's session" });
    await drawer.waitFor();
    await page.keyboard.press("ArrowDown");
    await settled(() => lane(page).getAttribute("data-agent-lane"), "HAR-12");
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "detached" });
    await settled(() => lane(page).getAttribute("data-agent-lane"), "HAR-12");
    await page.keyboard.press("Escape");
    await lane(page).waitFor({ state: "detached" });
    // The focus that was in the lane goes to the Coordinator's row: the keys still hop.
    await settled(() => page.evaluate(() => !!document.activeElement?.closest("[data-coordinator]")), true);
    await page.keyboard.press("j");
    await settled(() => lane(page).getAttribute("data-agent-lane"), "HAR-12");

    // ← Coordinator is the lane's way back to the chat; Open full page, to the session's own page.
    await lane(page).getByRole("link", { name: "← Coordinator" }).click();
    await lane(page).waitFor({ state: "detached" });
    await settled(() => hash(page), "#/projects/harbor?panel=agents");
    await panel(page).locator('[data-row="harbor/HAR-12"] a[data-open]').click();
    await lane(page).getByRole("link", { name: "Open full page →" }).click();
    await settled(() => hash(page), "#/sessions/HAR-12");
    await page.close();
  }, 15_000);

  test("an agent that hands back or is released stays in the lane, in its new state", async () => {
    const page = await open(1280, "#/projects/harbor?panel=agents&agent=HAR-18");
    const state = () => lane(page).getByRole("region", { name: "State" }).getAttribute("data-state");
    await settled(() => state(), "you");
    const later = "2026-03-10T10:00:00.000Z";
    const handedBack: EventInput = {
      project: "harbor",
      kind: "session.reported",
      at: later,
      actor: "worker",
      payload: { ticket: "HAR-18", session: "s-har-18-1", phase: "ready-to-merge", reason: "Handed back" },
    };
    const released: EventInput = {
      project: "harbor",
      kind: "session.released",
      at: later,
      actor: "worker",
      payload: { ticket: "HAR-18", session: "s-har-18-1", reason: "superseded" },
    };
    const show = (next: ReturnType<typeof reading>) =>
      page.evaluate((json) => {
        (window as unknown as { daemon: { show(r: unknown): void } }).daemon.show(JSON.parse(json));
      }, JSON.stringify(next));
    await show(reading([...LOG, handedBack]));
    await settled(() => state(), "ready");
    await show(reading([...LOG, handedBack, released]));
    await settled(() => state(), "released");
    expect(await lane(page).getByRole("region", { name: "State" }).innerText()).toMatch(/^Released\s+superseded$/);
    await settled(() => hash(page), "#/projects/harbor?panel=agents&agent=HAR-18");
    // Gone from the list, it marks no row; ↓ from it starts at the first agent.
    await settled(() => current(page), []);
    await lane(page).focus();
    await page.keyboard.press("ArrowDown");
    await settled(() => lane(page).getAttribute("data-agent-lane"), "HAR-12");
    await page.close();
  }, 15_000);

  test("below 900 px a row of the sheet shows its agent and closes the sheet", async () => {
    const page = await open(820);
    await page.getByRole("button", { name: "Panel", exact: true }).click();
    const sheet = page.locator("[data-sheet]");
    await sheet.waitFor();
    await sheet.locator('[data-row="harbor/HAR-20"] a[data-open]').click();
    await sheet.waitFor({ state: "detached" });
    await settled(() => lane(page).getByRole("region", { name: "State" }).getAttribute("data-state"), "ready");
    await settled(() => hash(page), "#/projects/harbor?panel=agents&agent=HAR-20");
    // Escape closes the sheet first, the lane next.
    await page.getByRole("button", { name: "Panel", exact: true }).click();
    await sheet.waitFor();
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await settled(() => lane(page).getAttribute("data-agent-lane"), "HAR-20");
    await page.keyboard.press("Escape");
    await lane(page).waitFor({ state: "detached" });
    await page.close();
  }, 15_000);
});
