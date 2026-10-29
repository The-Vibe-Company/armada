import { expect, test } from "bun:test";
import { fold } from "@armada/daemon/fold";
import type { ChatItem } from "@armada/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { SAMPLE_PROJECTS, sampleEvents } from "../scripts/dev-daemon";
import { routeOf } from "../src/lib/route";
import { type Chat, lastCoordinatorSeq, withSent } from "../src/room/chat";
import { parseQuestion, segments, toolLine } from "../src/room/view";
import { RoomView } from "../src/screens/Room";

// A project's room (THE-1996) on the daemon's own fold of a synthetic log and a
// synthetic conversation: the band, the pinned question, the conversation with
// its tool calls as quiet lines, and the agents' rail. The live part (a message
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

function render(chat: Partial<Chat> = {}, { asked = true } = {}) {
  const events = sampleEvents(AT)
    .filter((e) => asked || !(e.kind === "inbox.opened" && e.payload.kind === "owner-request"))
    .map((e, i) => ({ ...e, seq: i + 1 }));
  const state = JSON.parse(JSON.stringify(fold(events).projects.harbor));
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

test("the room reads in the v7 anatomy: the facts line, then the project's name as the one h1", () => {
  const html = render();
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  const header = block(html, /<header/, /<\/header>/);
  expect(header).toMatch(/example\/harbor(?:(?!<h1).)*<h1[^>]*>Harbor<\/h1>/);
  expect(text(header)).toContain("4 agents in flight · 1 moving on their own · 1 ready to merge · 1 merged today");
  expect(text(header)).toContain("1 blocked · 2 waiting for you");
  expect(header).toMatch(/aria-expanded="true"[^>]*aria-controls="room-agents"/);
});

test("the sky flies as a 200 px band, the question waits pinned under it with its choices and a labelled note", () => {
  const html = render();
  const sky = block(html, /<section[^>]*data-sky="band"/, /<\/section>/);
  expect(sky).toContain("This project&#x27;s agents, grouped by state");
  expect(sky).toContain("h-50");
  // The card comes right after the band, before the conversation.
  expect(html.indexOf('data-sky="band"')).toBeLessThan(html.indexOf("data-pinned"));
  expect(html.indexOf("data-pinned")).toBeLessThan(html.indexOf("data-thread"));
  const card = block(html, /<section[^>]*data-pinned/, /<section/);
  expect(text(card)).toStartWith("HAR-15 Price berths by the hour Codex");
  expect(text(card)).toContain("Two berth tests time out under the full suite. Fix the wait, or raise the timeout?");
  const buttons = [...card.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => text(m[1] ?? ""));
  expect(buttons).toEqual(["Fix the wait · recommended", "Raise the timeout", "Let me look"]);
  // The recommended choice is the primary button; the note is a field with its label.
  expect(card).toMatch(/<button[^>]*class="[^"]*bg-text text-bg[^"]*"[^>]*>Fix the wait/);
  const note = card.match(/<label for="([^"]+)"[^>]*>Note<\/label><input id="([^"]+)"/);
  expect(note?.[1]).toBe(note?.[2]);
  // Nothing waits: no card, nothing pinned.
  expect(render({}, { asked: false })).not.toContain("data-pinned");
});

test("the conversation shows who said what, each tool call as one quiet closed line, the coordinator's line on its state's dot", () => {
  const html = render();
  const thread = block(html, /<ol[^>]*data-thread/, /<\/ol>/);
  const items = [...thread.matchAll(/data-item="([a-z]+)"/g)].map((m) => m[1]);
  expect(items).toEqual(["owner", "tool", "tool", "coordinator", "line"]);
  expect(text(thread)).toContain("You Merge HAR-20 first, then look at #41 . 09:01");
  expect(text(thread)).toContain("Coordinator Merging #44 now; HAR-15 after its checks. 09:03");
  const tools = [...thread.matchAll(/<details([^>]*)>([\s\S]*?)<\/details>/g)];
  expect(tools.map((m) => /\bopen\b/.test(m[1] ?? ""))).toEqual([false, false]);
  expect(tools.map((m) => text((m[2] ?? "").match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] ?? ""))).toEqual([
    "› fleet.status · done 09:02",
    '› hold.add reason: " " · refused: say why merges wait 09:02',
  ]);
  // Opened, a call shows its input and its result.
  expect(text(tools[1]?.[2] ?? "")).toContain('Result { "ok": false, "code": "empty_reason"');
  // The ids are set apart; the blocked ticket's line wears its state on its dot and its id.
  expect(thread).toMatch(/data-dot="blocked"/);
  expect(thread).toMatch(/<span class="font-mono text-meta text-red">HAR-15<\/span> is blocked/);
});

test("the agents' rail groups the project's agents by state, one row per agent opening its session", () => {
  const html = render();
  const rail = block(html, /<aside[^>]*id="room-agents"/, /<\/aside>/);
  expect(text(rail.match(/<div class="flex h-11[^"]*">(.*?)<\/div>/)?.[1] ?? "")).toBe(
    "Agents 4 in flight · 1 merged today ×",
  );
  const groups = [...rail.matchAll(/data-rail-group="([a-z]+)"/g)].map((m) => m[1]);
  expect(groups).toEqual(["blocked", "you", "running", "ready", "merged"]);
  const rows = [...rail.matchAll(/<a href="([^"]+)" data-rail-row="([^"]+)"[^>]*>(.*?)<\/a>/g)].map(
    (m) => `${m[2]} ${m[1]} | ${text(m[3] ?? "")}`,
  );
  expect(rows).toEqual([
    "HAR-15 #/sessions/HAR-15 | HAR-15 Price berths by the hour Review & CI 09:00 Red CI on #41",
    "HAR-18 #/sessions/HAR-18 | HAR-18 Let skippers book a berth from the quay Approval 09:00 Plan to approve",
    "HAR-12 #/sessions/HAR-12 | HAR-12 Draw the harbour map from the tide tables Code 09:00 Wiring the map to the tide feed",
    "HAR-20 #/sessions/HAR-20 | HAR-20 Show the pilot's schedule Ready 09:00 Handed back · #44 green",
    "HAR-9 #/sessions/HAR-9 | HAR-9 Name the harbour's quays #39 · 09:00",
  ]);
});

test("the owner's field is labelled and sends; without a coordinator it says why", () => {
  const html = render();
  const form = block(html, /<form[^>]*aria-label="Message the coordinator"/, /<\/form>/);
  const field = form.match(/<label for="([^"]+)"[^>]*>Message<\/label><input id="([^"]+)"/);
  expect(field?.[1]).toBe(field?.[2]);
  expect(text(form)).toContain("Send");
  const alone = render({ coordinator: false, items: [] });
  expect(text(alone)).toContain("No coordinator runs for this project yet");
  expect(text(alone)).toContain("Nothing said yet.");
  expect(alone).toMatch(/<input id="[^"]+" type="text"[^>]*disabled=""/);
});

test("the room's rules: its address, a question's choices, ids in a message, a tool's quiet line", () => {
  expect(routeOf("#/projects/harbor")).toEqual({ kind: "project", id: "harbor" });
  expect(routeOf("#/projects/a%20b")).toEqual({ kind: "project", id: "a b" });
  expect(routeOf("#/projects/harbor/rules")).toEqual({ kind: "rules", id: "harbor" });
  expect(routeOf("#/sessions/HAR-15")).toEqual({ kind: "session", ticket: "HAR-15" });
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
  const running = {
    kind: "tool",
    id: "t",
    at: AT,
    name: "merge.check",
    input: { pr: 41 },
    output: null,
    failed: false,
  } as const;
  expect(toolLine(running)).toEqual({ args: "pr: 41", outcome: "running" });
  expect(toolLine({ ...running, output: "boom", failed: true })).toEqual({ args: "pr: 41", outcome: "failed" });
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
    lastCoordinatorSeq({ seq: 9, events: [event(3, "coordinator.checkpoint"), event(7, "session.reported")] }),
  ).toBe(3);
  expect(lastCoordinatorSeq(undefined)).toBe(0);
});
