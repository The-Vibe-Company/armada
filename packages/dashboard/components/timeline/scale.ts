// The live timeline's geometry (THE-868, THE-880): where a time falls on a
// row, the hour marks, each phase's color. Pure, so the drawing stays a plain
// map of what core gives each row (`SessionTimeline`) onto x positions.
import { type AgentPhase, type SessionTimeline, TIMELINE_HOURS } from "@armada/core/read";

/** The hours the view shows at once; the rest of the rows' `TIMELINE_HOURS` is a scroll away. */
export const VISIBLE_HOURS = 3;
/** How many views wide the track is: the CSS sizes it from this (`--tl-zoom`). */
export const ZOOM = TIMELINE_HOURS / VISIBLE_HOURS;

const MIN = 60_000;
const HOUR = 60 * MIN;
/** The drawing follows the clock by steps this long: about a pixel at 3 h, and rows redraw only at each step. */
export const STEP_MS = 15_000;
/** No hour mark this close to now, where the "now" label sits. */
const NOW_LABEL_MS = 15 * MIN;

export interface Scale {
  start: number;
  end: number;
  /** A time's place on the track, in percent, kept on the track. */
  x: (at: number | string) => number;
}

/** The whole track: the last `TIMELINE_HOURS` up to now, now on the right. */
export function scaleOf(now: number): Scale {
  const end = Math.floor(now / STEP_MS) * STEP_MS;
  const start = end - TIMELINE_HOURS * HOUR;
  const x = (at: number | string) => {
    const t = typeof at === "string" ? Date.parse(at) : at;
    return Math.max(0, Math.min(100, ((t - start) / (end - start)) * 100));
  };
  return { start, end, x };
}

/** Every whole hour of the viewer's clock on the track, but the one next to now. */
export function hourMarks(scale: Scale): number[] {
  const marks: number[] = [];
  const first = new Date(scale.start);
  first.setMinutes(0, 0, 0);
  for (let t = first.getTime() + HOUR; t < scale.end - NOW_LABEL_MS; t += HOUR) if (t > scale.start) marks.push(t);
  return marks;
}

/** A phase's color: the shell's tones (the plan and the work in blue, a decision orange, a failure red, done green). */
export const PHASE_COLOR: Record<AgentPhase, string> = {
  planning: "var(--frontier)",
  "awaiting-approval": "var(--accent)",
  "awaiting-validation": "var(--accent)",
  implementing: "var(--frontier)",
  shipping: "var(--frontier)",
  blocked: "var(--critical)",
  "ready-to-merge": "var(--done)",
  merged: "var(--done)",
  released: "var(--text-3)",
};

/** A phase segment's place on the row; null when it ended before the track. */
export function segmentBox(s: SessionTimeline["phases"][number], scale: Scale): { x: number; width: number } | null {
  const to = s.to === null ? scale.end : Date.parse(s.to);
  if (to <= scale.start) return null;
  const x = scale.x(s.from);
  return { x, width: Math.max(0, scale.x(to) - x) };
}

/** A span drawn on a row: its x and width in percent, null when it ended before the track or has no length. */
export function spanBox(from: string | number, to: string | number | null, scale: Scale) {
  const x = scale.x(from);
  const width = scale.x(to ?? scale.end) - x;
  return width > 0 ? { x, width } : null;
}
