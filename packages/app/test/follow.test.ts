import { expect, test } from "bun:test";
import {
  ANCHOR_OFFSET,
  ANCHORING,
  anchorRow,
  correction,
  endSpace,
  FOLLOWING,
  type Follow,
  followBehavior,
  fromEnd,
  pageStep,
  readPosition,
  transition,
  wantsPill,
  writePosition,
} from "../src/room/follow";

// The thread's scroll rules (THE-2054) on synthetic geometry: a 600 px
// viewport over 2000 px of conversation.

const at = (top: number) => fromEnd({ top, height: 2000, viewport: 600 });

test("following lets go only when the owner goes up, and holds through the frames a stream leaves the end", () => {
  expect(transition(FOLLOWING, { type: "navigated", up: false })).toBe(FOLLOWING);
  // A streamed chunk scrolls the end out of view for a frame: still following.
  expect(transition(FOLLOWING, { type: "scrolled", fromEnd: at(1300) })).toBe(FOLLOWING);
  const free = transition(FOLLOWING, { type: "navigated", up: true });
  expect(free).toEqual({ mode: "free", away: false });
  expect(wantsPill(free)).toBe(false);
});

test("free scrolling re-arms at the end, or within 40 px once it left that band", () => {
  const free: Follow = { mode: "free", away: false };
  // Just up from the end: free, inside the band, no pill and no re-arm short of the very end.
  expect(transition(free, { type: "scrolled", fromEnd: at(1380) })).toBe(free);
  expect(transition(free, { type: "scrolled", fromEnd: at(1399.5) })).toBe(FOLLOWING);
  // Past 40 px of the end: away, and the pill is wanted.
  const away = transition(free, { type: "scrolled", fromEnd: at(1359) });
  expect(away).toEqual({ mode: "free", away: true });
  expect(wantsPill(away)).toBe(true);
  expect(transition(away, { type: "scrolled", fromEnd: at(900) })).toBe(away);
  // Back within 40 px: following again.
  expect(at(1360)).toBe(40);
  expect(transition(away, { type: "scrolled", fromEnd: at(1361) })).toBe(FOLLOWING);
  expect(transition(away, { type: "scrolled", fromEnd: at(1359) })).toBe(away);
  expect(transition(away, { type: "toEnd" })).toBe(FOLLOWING);
});

test("a sent message anchors the turn until the answer outgrows the room under it, or the owner moves", () => {
  expect(transition(FOLLOWING, { type: "sent" })).toBe(ANCHORING);
  const away: Follow = { mode: "free", away: true };
  expect(transition(away, { type: "sent" })).toBe(ANCHORING);
  // Scrolls that are not the owner's (the anchoring's own) change nothing.
  expect(transition(ANCHORING, { type: "scrolled", fromEnd: 500 })).toBe(ANCHORING);
  expect(transition(ANCHORING, { type: "overflowed" })).toBe(FOLLOWING);
  expect(transition(ANCHORING, { type: "navigated", up: false })).toEqual({ mode: "free", away: false });
  // Only an anchored turn overflows.
  expect(transition(FOLLOWING, { type: "overflowed" })).toBe(FOLLOWING);
});

test("the end space puts the anchored message 24 px from the top, and is spent as its answer grows", () => {
  // The owner's message and what follows it are 100 px; 12 px of padding under the list.
  expect(endSpace(600, 100, 12)).toEqual({ space: 600 - ANCHOR_OFFSET - 100 - 12, overflows: false });
  expect(endSpace(600, 564, 12)).toEqual({ space: 0, overflows: false });
  expect(endSpace(600, 565, 12)).toEqual({ space: 0, overflows: true });
});

test("free scrolling holds the first visible row where it was", () => {
  const rows = [
    { key: "a", top: -300, bottom: -20 },
    { key: "b", top: -20, bottom: 180 },
    { key: "c", top: 180, bottom: 400 },
  ];
  const anchor = anchorRow(rows);
  expect(anchor).toEqual({ row: "b", offset: -20 });
  // An item above pushed it 120 px down: scroll down as much. The oldest left: scroll up.
  if (!anchor) throw new Error("no anchor");
  expect(correction(anchor, 100)).toBe(120);
  expect(correction(anchor, -80)).toBe(-60);
  expect(anchorRow([])).toBeNull();
});

test("following is smooth while the coordinator works, instant otherwise and under reduced motion", () => {
  expect(followBehavior(true, false)).toBe("smooth");
  expect(followBehavior(false, false)).toBe("instant");
  expect(followBehavior(true, true)).toBe("instant");
  expect(pageStep(600)).toBe(552);
});

test("a project's place is kept and read back; a broken one is none", () => {
  const map = new Map<string, string>();
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v) };
  expect(readPosition(storage, "harbor")).toBeNull();
  writePosition(storage, "harbor", { row: "c4", offset: -12, atEnd: false });
  expect(readPosition(storage, "harbor")).toEqual({ row: "c4", offset: -12, atEnd: false });
  expect(readPosition(storage, "lantern")).toBeNull();
  map.set("armada.room.position.harbor", "{nope");
  expect(readPosition(storage, "harbor")).toBeNull();
});
