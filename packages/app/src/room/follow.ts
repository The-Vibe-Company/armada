// How the room's thread scrolls (THE-2054), after T3 Code's timeline
// (`useTimelineFollow.ts`, `timelineViewport.ts`, `timelineScrollAnchoring.ts`,
// `MessagesTimeline.logic.ts`): three modes on plain scroll geometry, no DOM.
// Following keeps the end in view; anchoring pins the message the owner just
// sent near the top and reserves the space its answer grows into; free
// scrolling holds what the owner reads still. A position is kept per project.

/** The scroller's geometry: `scrollTop`, `scrollHeight`, `clientHeight`. */
export interface Geometry {
  top: number;
  height: number;
  viewport: number;
}

/** At the end within this (sub-pixel rounding). */
export const AT_END_PX = 1;
/** Back near the end within this, after leaving it, follows again (streaming leaves the band for a frame). */
export const REARM_PX = 40;
/** A sent message sits this far from the thread's top (T3 Code's `CHAT_TIMELINE_ANCHOR_OFFSET`). */
export const ANCHOR_OFFSET = 24;
/** "Scroll to end" shows this long after the owner left the end, so it never flashes. */
export const PILL_DELAY = 150;

/**
 * `following` the end; `anchoring` the owner's last message near the top;
 * `free` where the owner scrolled, `away` once past REARM_PX of the end.
 */
export type Follow = { mode: "following" } | { mode: "anchoring" } | { mode: "free"; away: boolean };

export const FOLLOWING: Follow = { mode: "following" };
export const ANCHORING: Follow = { mode: "anchoring" };

export type FollowEvent =
  /** The owner moved the thread (wheel, touch, keys, the scrollbar, PageUp/PageDown). */
  | { type: "navigated"; up: boolean }
  /** The thread scrolled, for whatever reason: how far it is from the end now. */
  | { type: "scrolled"; fromEnd: number }
  /** The owner sent a message the thread shows. */
  | { type: "sent" }
  /** "Scroll to end". */
  | { type: "toEnd" }
  /** The answer under the anchored message no longer fits under it. */
  | { type: "overflowed" };

export const fromEnd = (g: Geometry): number => Math.max(0, g.height - g.top - g.viewport);

/** The mode after an event; the same object when nothing changes. */
export function transition(state: Follow, event: FollowEvent): Follow {
  switch (event.type) {
    case "navigated":
      // Following lets go only when the owner goes up; an anchored turn lets go on any move.
      if (state.mode === "following") return event.up ? { mode: "free", away: false } : state;
      if (state.mode === "anchoring") return { mode: "free", away: false };
      return state;
    case "scrolled": {
      if (state.mode !== "free") return state;
      // At the very end, or back in the band after leaving it, the thread follows again.
      if (event.fromEnd <= AT_END_PX || (state.away && event.fromEnd <= REARM_PX)) return FOLLOWING;
      if (!state.away && event.fromEnd > REARM_PX) return { mode: "free", away: true };
      return state;
    }
    case "sent":
      return state.mode === "anchoring" ? state : ANCHORING;
    case "toEnd":
      return state.mode === "following" ? state : FOLLOWING;
    case "overflowed":
      return state.mode === "anchoring" ? FOLLOWING : state;
  }
}

/** Whether "Scroll to end" is wanted (it shows PILL_DELAY later, and hides at once). */
export const wantsPill = (state: Follow): boolean => state.mode === "free" && state.away;

/** Following moves smoothly while the coordinator works, at once otherwise (and always under reduced motion). */
export const followBehavior = (working: boolean, reducedMotion: boolean): ScrollBehavior =>
  working && !reducedMotion ? "smooth" : "instant";

/**
 * The space reserved under the anchored message so that, scrolled to the end,
 * it sits ANCHOR_OFFSET from the top: `below` is the content from the message's
 * top to the list's end, `padEnd` the scroller's bottom padding. `overflows`
 * once the answer under it no longer fits.
 */
export function endSpace(viewport: number, below: number, padEnd: number): { space: number; overflows: boolean } {
  const room = viewport - ANCHOR_OFFSET - below - padEnd;
  return { space: Math.max(0, room), overflows: room < 0 };
}

/** A row as measured: its key and its edges from the scroller's visible top. */
export interface RowBox {
  key: string;
  top: number;
  bottom: number;
}

/** Where the owner reads: the first row still visible and how far its top is from the scroller's. */
export interface Anchor {
  row: string;
  offset: number;
}

export function anchorRow(rows: readonly RowBox[]): Anchor | null {
  const row = rows.find((r) => r.bottom > 0);
  return row ? { row: row.key, offset: row.top } : null;
}

/** How far to scroll so the anchored row is back where it was (positive: down). */
export const correction = (before: Anchor, now: number): number => now - before.offset;

/** PageUp and PageDown move a viewport less a little overlap, so a line stays on screen. */
export const pageStep = (viewport: number): number => Math.max(REARM_PX, viewport - 48);

/** A project's remembered place: the row read and its offset, or the end. */
export interface Position extends Anchor {
  atEnd: boolean;
}

export interface PositionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const POSITION_KEY = (project: string) => `armada.room.position.${project}`;

export function readPosition(storage: PositionStorage | null, project: string): Position | null {
  try {
    const value: unknown = JSON.parse(storage?.getItem(POSITION_KEY(project)) ?? "null");
    if (!value || typeof value !== "object") return null;
    const { row, offset, atEnd } = value as Record<string, unknown>;
    if (typeof row !== "string" || typeof offset !== "number" || typeof atEnd !== "boolean") return null;
    return { row, offset, atEnd };
  } catch {
    return null;
  }
}

export function writePosition(storage: PositionStorage | null, project: string, position: Position): void {
  try {
    storage?.setItem(POSITION_KEY(project), JSON.stringify(position));
  } catch {
    /* Storage full or refused: the room opens at the end. */
  }
}
