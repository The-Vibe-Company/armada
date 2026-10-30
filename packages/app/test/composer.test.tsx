import { expect, test } from "bun:test";
import type { ChatItem } from "@armada/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "../src/room/Composer";
import {
  afterSend,
  caretLines,
  coordinatorModel,
  DRAFT_WAIT,
  DRAFTS_KEY,
  type DraftStorage,
  draftKeeper,
  FIELD_MAX,
  fieldHeight,
  type KeyPress,
  keyIntent,
  ownerHistory,
  stepHistory,
  type Timers,
} from "../src/room/compose";

// The room's composer (THE-2051), after T3 Code's: its rules on synthetic
// keys, a fake `localStorage` and fake timers, and its markup as a fresh room
// draws it. The real field (typing, its height, Enter) runs in Chromium in
// test/build.test.ts.

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});
const anywhere = { first: true, last: true, browsing: false };

function fakeStorage(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}
function fakeTimers(): Timers & { elapse(ms: number): void } {
  let now = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  let next = 0;
  return {
    set: (run, ms) => {
      due.set(++next, { at: now + ms, run });
      return next;
    },
    clear: (handle) => void due.delete(handle as number),
    elapse(ms) {
      now += ms;
      for (const [id, timer] of [...due]) {
        if (timer.at > now) continue;
        due.delete(id);
        timer.run();
      }
    },
  };
}

const render = (props: Partial<Parameters<typeof Composer>[0]> = {}) =>
  renderToStaticMarkup(
    <Composer project="harbor" send={async () => {}} disabled={false} hint={null} storage={null} {...props} />,
  );

test("Enter and ⌘Enter send; Shift+Enter is left to the textarea, which inserts the line", () => {
  expect(keyIntent(press("Enter"), anywhere)).toBe("send");
  expect(keyIntent(press("Enter", { metaKey: true }), anywhere)).toBe("send");
  expect(keyIntent(press("Enter", { ctrlKey: true }), anywhere)).toBe("send");
  expect(keyIntent(press("Enter", { shiftKey: true }), anywhere)).toBeNull();
  // An input method's Enter picks a character.
  expect(keyIntent(press("Enter", { isComposing: true }), anywhere)).toBeNull();
  expect(keyIntent(press("Enter", { keyCode: 229 }), anywhere)).toBeNull();
  expect(keyIntent(press("a"), anywhere)).toBeNull();
});

test("PageUp and PageDown page the thread from the field (THE-2054); with a modifier they are the field's", () => {
  expect(keyIntent(press("PageUp"), anywhere)).toBe("page-up");
  expect(keyIntent(press("PageDown"), anywhere)).toBe("page-down");
  expect(keyIntent(press("PageUp", { shiftKey: true }), anywhere)).toBeNull();
  expect(keyIntent(press("PageDown", { metaKey: true }), anywhere)).toBeNull();
  // The field is a textarea: a key left to it writes a new line.
  expect(render()).toMatch(/<textarea id="[^"]+" rows="2"/);
});

test("the field grows with its lines from two and stops at the max, then scrolls", () => {
  const LINE = 21; // 14 px at 1.5
  const PAD = 18; // pt-3.5 and pb-1
  const heights = [2, 3, 6, 9, 10, 20].map((lines) => fieldHeight(lines * LINE + PAD));
  expect(heights.map((h) => h.height)).toEqual([60, 81, 144, 207, FIELD_MAX, FIELD_MAX]);
  expect(heights.map((h) => h.scrolls)).toEqual([false, false, false, false, true, true]);
  expect(render()).toContain("max-h-52");
});

test("a draft is kept per project, 300 ms after the last key, restored when the room opens again, cleared once sent", () => {
  const storage = fakeStorage();
  const timers = fakeTimers();
  const keeper = draftKeeper(storage, timers);
  keeper.keep("harbor", "Merge HAR-20");
  keeper.keep("harbor", "Merge HAR-20 first,\nthen #41.");
  timers.elapse(DRAFT_WAIT - 1);
  expect(storage.map.has(DRAFTS_KEY)).toBe(false);
  timers.elapse(1);
  expect(JSON.parse(storage.map.get(DRAFTS_KEY) ?? "")).toEqual({ harbor: "Merge HAR-20 first,\nthen #41." });

  // Away and back: a fresh room on the same storage holds the draft, and Send is on; another project's field is empty.
  const back = render({ storage });
  expect(back).toMatch(/<textarea[^>]*>Merge HAR-20 first,\nthen #41.<\/textarea>/);
  expect(back).toMatch(/<button type="submit" aria-label="Send" class=/);
  expect(render({ project: "tidewater", storage })).toMatch(/<textarea[^>]*><\/textarea>/);

  // The room closing writes a draft still waiting; a sent message forgets it.
  keeper.keep("tidewater", "Look at the tides.");
  keeper.flush();
  keeper.drop("harbor");
  expect(JSON.parse(storage.map.get(DRAFTS_KEY) ?? "")).toEqual({ tidewater: "Look at the tides." });
  // An unreadable entry is no draft.
  storage.map.set(DRAFTS_KEY, "{not json");
  expect(render({ project: "tidewater", storage })).toMatch(/<textarea[^>]*><\/textarea>/);
});

test("↑ on the first line recalls the last message sent, ↓ on the last brings the draft back, Esc leaves", () => {
  const at = "2026-03-10T09:00:00.000Z";
  const items: ChatItem[] = [
    { kind: "owner", id: "1", at, body: "Merge HAR-20 first." },
    { kind: "coordinator", id: "2", at, body: "Merging." },
    { kind: "owner", id: "3", at, body: "Then look at #41." },
    { kind: "owner", id: "4", at, body: " Then look at #41. " },
  ];
  const history = ownerHistory(items);
  expect(history).toEqual(["Then look at #41.", "Merge HAR-20 first."]);

  // ↑ only from the first line; ↓ only from the last, while walking.
  expect(caretLines("one\ntwo", 2, 2)).toEqual({ first: true, last: false });
  expect(caretLines("one\ntwo", 5, 5)).toEqual({ first: false, last: true });
  expect(keyIntent(press("ArrowUp"), { first: false, last: true, browsing: false })).toBeNull();
  expect(keyIntent(press("ArrowUp"), { first: true, last: false, browsing: false })).toBe("older");
  expect(keyIntent(press("ArrowDown"), { first: true, last: true, browsing: false })).toBeNull();
  expect(keyIntent(press("ArrowDown"), { first: true, last: true, browsing: true })).toBe("newer");
  expect(keyIntent(press("Escape"), { first: true, last: true, browsing: true })).toBe("leave");

  const up = stepHistory(history, "a draft", null, "older");
  expect(up).toEqual({ text: "Then look at #41.", recall: { index: 0, draft: "a draft" } });
  const further = stepHistory(history, up?.text ?? "", up?.recall ?? null, "older");
  expect(further?.text).toBe("Merge HAR-20 first.");
  // Past the oldest there is nowhere to go.
  expect(stepHistory(history, further?.text ?? "", further?.recall ?? null, "older")).toBeNull();
  const down = stepHistory(history, further?.text ?? "", further?.recall ?? null, "newer");
  expect(down?.text).toBe("Then look at #41.");
  expect(stepHistory(history, down?.text ?? "", down?.recall ?? null, "newer")).toEqual({
    text: "a draft",
    recall: null,
  });
  expect(stepHistory(history, further?.text ?? "", further?.recall ?? null, "leave")).toEqual({
    text: "a draft",
    recall: null,
  });
  expect(stepHistory([], "", null, "older")).toBeNull();

  // Sent as recalled, the draft comes back. Edited, the arrows are the caret's again and Esc gives the draft back.
  expect(afterSend("Then look at #41.", "Then look at #41.", up?.recall ?? null)).toBe("a draft");
  const edited = { index: null, draft: "a draft" };
  expect(stepHistory(history, "Then look at #42.", edited, "older")).toBeNull();
  expect(stepHistory(history, "Then look at #42.", edited, "newer")).toBeNull();
  expect(stepHistory(history, "Then look at #42.", edited, "leave")).toEqual({ text: "a draft", recall: null });
  expect(afterSend("Then look at #42.", "Then look at #42.", edited)).toBe("a draft");
  // A plain message empties the field; one the owner went on writing during the send is left alone.
  expect(afterSend("Merge.", " Merge. ", null)).toBe("");
  expect(afterSend("Merge.", "Merge. Then", null)).toBeNull();
});

test("Send is round, labelled, and off while the field is blank", () => {
  const blank = render();
  expect(blank).toMatch(/<button type="submit" aria-label="Send" disabled=""[^>]*rounded-full/);
  expect(blank).toContain('placeholder="Tell the coordinator what to do."');
  // The live turn's ticket puts its own buttons in Send's place.
  const live = render({ primary: (f) => <button type="button">Stop {f.text.length}</button> });
  expect(live).toContain('<button type="button">Stop 0</button>');
  expect(live).not.toContain('aria-label="Send"');
});

test("the footer names the coordinator's model when the daemon says it, else nothing", () => {
  const models = [
    {
      kind: "anthropic",
      description: "Anthropic",
      config: { type: "object", properties: { model: { type: "string", default: "claude-default" } } },
    },
  ];
  expect(coordinatorModel(null)).toBeNull();
  expect(coordinatorModel({ provider: null, storage: "file" })).toBeNull();
  expect(coordinatorModel({ provider: "anthropic", storage: "file", models })).toBe("claude-default");
  expect(coordinatorModel({ provider: "anthropic", storage: "file", models, config: { model: "claude-chosen" } })).toBe(
    "claude-chosen",
  );
  expect(coordinatorModel({ provider: "custom", storage: "file", models })).toBeNull();
  expect(render({ model: "claude-chosen" })).toMatch(/<span class="[^"]*font-mono[^"]*"[^>]*>claude-chosen<\/span>/);
  expect(render()).not.toContain("font-mono");
});
