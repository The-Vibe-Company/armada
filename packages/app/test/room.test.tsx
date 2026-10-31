import { expect, test } from "bun:test";
import { fold } from "@armada/daemon/fold";
import type { ChatItem } from "@armada/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { SAMPLE_PROJECTS, sampleEvents } from "../scripts/dev-daemon";
import { routeOf } from "../src/lib/route";
import { type Chat, withSent } from "../src/room/chat";
import { lastCoordinatorSeq } from "../src/room/unread";
import { parseQuestion, segments } from "../src/room/view";
import { RoomView } from "../src/screens/Room";

// A project's room (THE-1996) on the daemon's own fold of a synthetic log and a
// synthetic conversation: its header, the conversation with its tool calls
// folded above the answer, and the panel (THE-2085) opening on the agents with
// the pinned question first. The header's own rules are test/room-header.test.tsx's,
// the panel's in a browser test/room-panel.test.tsx's; the live part (a message
// sent, the coordinator's answer, a reload) runs in a browser (test/build.test.ts).

const AT = "2026-03-10T09:00:00.000Z";
const NOW = Date.parse("2026-03-10T15:00:00.000Z");
const at = (minute: number) => new Date(Date.parse(AT) + minute * 60_000).toISOString();

const conversation: ChatItem[] = [
  { kind: "owner", id: "e1", at: at(1), body: "Merge HAR-20 first, then look at #41." },
  {
    kind: "tool",
    id: "t1",
    at: at(2),
    name: "fleet.status",
    input: {},
    output: '{"ok":true,"tables":{"sessions":[]}}',
    failed: false,
  },
  {
    kind: "tool",
    id: "t2",
    at: at(2),
    name: "hold.add",
    input: { reason: " " },
    output: '{"ok":false,"code":"empty_reason","message":"say why merges wait","next":"hold.add with a reason"}',
    failed: true,
  },
  { kind: "coordinator", id: "e2", at: at(3), body: "Merging #44 now; HAR-15 after its checks." },
  { kind: "line", id: "m1", at: at(4), body: "HAR-15 is blocked: #41 is red. I told its worker." },
];

function render(
  chat: Partial<Chat> = {},
  { asked = true, readAt = undefined as Record<string, string> | undefined } = {},
) {
  const events = sampleEvents(AT)
    .filter((e) => asked || !(e.kind === "inbox.opened" && e.payload.kind === "owner-request"))
    .map((e, i) => ({ ...e, seq: i + 1 }));
  const state = JSON.parse(JSON.stringify(fold(events).projects.harbor));
  if (readAt) state.readAt = readAt;
  const project = SAMPLE_PROJECTS[0];
  if (!project) throw new Error("no sample project");
  const full: Chat = {
    status: "ready",
    coordinator: true,
    items: conversation,
    problem: null,
    send: async () => {},
    answer: async () => {},
    ...chat,
  };
  return renderToStaticMarkup(
    <RoomView project={project} snapshot={{ state }} live now={NOW} zone="UTC" chat={full} />,
  );
}

/** The markup as words, every tag a space: `#41 .` reads `#41.` on screen. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
/** The markup between an element's opening (found by `marker`) and the end of the room's next block. */
const block = (html: string, marker: RegExp, end: RegExp) => {
  const start = html.search(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = html.slice(start);
  const stop = rest.slice(1).search(end);
  return stop < 0 ? rest : rest.slice(0, stop + 1);
};

test("the room is its chat: one header line, no sky, the conversation, then the panel on the agents", () => {
  const html = render();
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  const header = block(html, /<header/, /<\/header>/);
  expect(header).toMatch(/<h1[^>]*>Harbor<\/h1><span[^>]*>example\/harbor<\/span>/);
  expect(text(header)).toBe(
    "Harbor example/harbor 1 blocked 1 waiting for you 1 in progress 1 ready to merge 1 merged today",
  );
  expect(header).toMatch(/aria-pressed="true" aria-controls="room-panel"/);
  // The sky flies in the hangar only; the facts line and the quiet sentence are gone.
  expect(html).not.toContain("data-sky");
  expect(html).not.toContain("in flight");
  // The focus goes header, thread, field, panel: the page's order.
  const order = ["<header", "data-thread", 'aria-label="Message the coordinator"', 'id="room-panel"'].map((m) =>
    html.indexOf(m),
  );
  expect(order.every((at, k) => at > (order[k - 1] ?? -1))).toBe(true);
});

test("the panel opens on the agents, the question waiting first with its choices and a labelled note", () => {
  const html = render();
  const panel = block(html, /<aside[^>]*id="room-panel"/, /<\/aside>/);
  const tabs = [...panel.matchAll(/<button[^>]*role="tab"[^>]*aria-selected="(true|false)"[^>]*>([^<]+)<\/button>/g)];
  expect(tabs.map((m) => `${m[2]}${m[1] === "true" ? " (open)" : ""}`)).toEqual([
    "Agents (open)",
    "Pull requests",
    "Rules",
    "Log",
  ]);
  // The card comes first, then the agents by state.
  expect(panel.indexOf("data-pinned")).toBeLessThan(panel.indexOf('data-group-heading="blocked"'));
  const card = block(panel, /<section[^>]*data-pinned/, /<\/section>/);
  expect(text(card)).toStartWith("HAR-15 Price berths by the hour Codex");
  expect(text(card)).toContain("Two berth tests time out under the full suite. Fix the wait, or raise the timeout?");
  const buttons = [...card.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => text(m[1] ?? ""));
  expect(buttons).toEqual(["Fix the wait · recommended", "Raise the timeout", "Let me look"]);
  // The recommended choice is the primary button; the note is a field with its label.
  expect(card).toMatch(/<button[^>]*class="[^"]*bg-text text-bg[^"]*"[^>]*>Fix the wait/);
  const note = card.match(/<label for="([^"]+)"[^>]*>Note<\/label><input id="([^"]+)"/);
  expect(note?.[1]).toBe(note?.[2]);
  const rows = [...panel.matchAll(/data-row="harbor\/([^"]+)"/g)].map((m) => m[1]);
  expect(rows).toEqual(["HAR-15", "HAR-18", "HAR-12", "HAR-20", "HAR-9"]);
  // With its card on screen, the field does not say it again; nothing waits: no card.
  expect(html).not.toContain("data-asking");
  expect(render({}, { asked: false })).not.toContain("data-pinned");
});

test("the conversation shows who said what, the turn's tool calls folded above the answer, the coordinator's line on its state's dot", () => {
  const html = render();
  const thread = block(html, /<ol[^>]*data-thread/, /<\/ol>/);
  const items = [...thread.matchAll(/data-item="([a-z]+)"/g)].map((m) => m[1]);
  expect(items).toEqual(["owner", "fold", "coordinator", "line"]);
  // Who said it is for screen readers; the time follows each message (THE-2050: the thread's own test is thread.test.tsx).
  expect(text(thread)).toContain("You: Merge HAR-20 first, then look at #41 . 09:01");
  expect(text(thread)).toContain("Coordinator: Merging #44 now; HAR-15 after its checks. 09:03");
  // The work is closed until a click opens it (THE-2053: its rows are work-rows.test.tsx's).
  expect(text(thread)).toContain("Worked for 1m 00s");
  expect(thread).not.toContain("data-tool");
  // The ids are set apart; the blocked ticket's line wears its state on its dot and its id.
  expect(thread).toMatch(/data-dot="blocked"/);
  expect(thread).toMatch(/<span class="font-mono text-meta text-red">HAR-15<\/span> is blocked/);
});

test("the owner's field is labelled and sends; without a coordinator it says why", () => {
  const html = render();
  const form = block(html, /<form[^>]*aria-label="Message the coordinator"/, /<\/form>/);
  const field = form.match(/<label for="([^"]+)"[^>]*>Message<\/label><textarea id="([^"]+)"/);
  expect(field?.[1]).toBe(field?.[2]);
  expect(form).toMatch(/<button type="submit" aria-label="Send"/);
  const alone = render({ coordinator: false, items: [] });
  expect(text(alone)).toContain("No coordinator runs for this project yet");
  // Nothing said yet: the empty room's hero (THE-2055), with the fleet's sentence the header no longer says (THE-2085).
  expect(text(alone)).toContain("What should we work on? 1 agent blocked, 1 waiting for your decision.");
  expect(alone).toMatch(/<textarea id="[^"]+"[^>]*disabled=""/);
});

test("the room's rules: its address, a question's choices, ids in a message", () => {
  expect(routeOf("#/projects/harbor")).toEqual({ kind: "project", id: "harbor" });
  expect(routeOf("#/projects/a%20b")).toEqual({ kind: "project", id: "a b" });
  // The panel's tab is in the address; the old rules page is replaced by the Rules tab.
  expect(routeOf("#/projects/harbor?panel=prs")).toEqual({ kind: "project", id: "harbor", panel: "prs" });
  expect(routeOf("#/projects/harbor?panel=elsewhere")).toEqual({ kind: "project", id: "harbor" });
  // An agent's page in the room's lane (THE-2089).
  expect(routeOf("#/projects/harbor?panel=agents&agent=HAR-15")).toEqual({
    kind: "project",
    id: "harbor",
    panel: "agents",
    agent: "HAR-15",
  });
  expect(routeOf("#/projects/harbor/rules")).toEqual({
    kind: "rules",
    id: "harbor",
    redirect: "#/projects/harbor?panel=rules",
  });
  // A session's page has its own route (src/session/route.ts): the agents' rows lead there.
  expect(routeOf("#/sessions/HAR-15")).toEqual({ kind: "home" });
  expect(routeOf("#/projects/harbor/extra")).toEqual({ kind: "home" });
  expect(routeOf("#/projects/%E0%A4%A")).toEqual({ kind: "home" });
  expect(routeOf("")).toEqual({ kind: "home" });
  expect(parseQuestion("Which?\n\nOptions:\n- North — recommended\n- South")).toEqual({
    question: "Which?",
    choices: [
      { label: "North", recommended: true },
      { label: "South", recommended: false },
    ],
  });
  expect(parseQuestion("Free text only")).toEqual({ question: "Free text only", choices: [] });
  expect(segments("HAR-15 waits on #41.").map((s) => `${s.kind}:${s.text}`)).toEqual([
    "ticket:HAR-15",
    "text: waits on ",
    "pr:#41",
    "text:.",
  ]);
});

test("a sent message stays until a reading holds it, and the room reads again past its last coordinator event", () => {
  const sent = [{ project: "harbor", id: "m1", body: "Merge HAR-20 first", at: Date.parse(at(10)) }];
  const before = withSent(conversation, sent, "harbor");
  expect(before.at(-1)).toEqual({ kind: "owner", id: "sent:m1", at: at(10), body: "Merge HAR-20 first" });
  // Another project's message is not this room's.
  expect(withSent(conversation, sent, "lantern")).toBe(conversation);
  // The same words said earlier do not stand for it; said once it was sent, they do.
  const earlier = [...conversation, { kind: "owner" as const, id: "e9", at: at(1), body: "Merge HAR-20 first" }];
  expect(withSent(earlier, sent, "harbor").at(-1)?.id).toBe("sent:m1");
  const placed = [...conversation, { kind: "owner" as const, id: "e10", at: at(10), body: "Merge HAR-20 first" }];
  expect(withSent(placed, sent, "harbor")).toBe(placed);
  const event = (seq: number, kind: string) => ({ seq, project: "harbor", kind, at: AT, actor: "a", payload: {} });
  expect(
    lastCoordinatorSeq({
      seq: 9,
      events: [
        event(3, "coordinator.checkpoint"),
        event(7, "session.reported"),
        { ...event(9, "coordinator.checkpoint"), actor: "reader" },
      ],
    }),
  ).toBe(3);
  expect(lastCoordinatorSeq(undefined)).toBe(0);
});
