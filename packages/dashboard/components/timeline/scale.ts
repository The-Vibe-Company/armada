// The live timeline's geometry (THE-868): where a time falls on a row, the
// hour marks, each phase's color. Pure, so the drawing stays a plain map of
// what core gives each row (`FleetRow.timeline`) onto x positions.
import type { AgentPhase, FleetRow } from "@armada/core/read";

/** The spans the switch offers, in hours; the rows carry the longest (core's TIMELINE_HOURS). */
export const SPANS = [2, 4, 8] as const;
export type Span = (typeof SPANS)[number];
export const DEFAULT_SPAN: Span = 4;

const HOUR = 3_600_000;
/** The drawing follows the clock by steps this long: 0.5 px at 8 h, and rows redraw only at each step. */
export const STEP_MS = 15_000;

export interface Scale {
  start: number;
  end: number;
  /** A time's place on the row, in percent, kept on the row. */
  x: (at: number | string) => number;
}

export function scaleOf(now: number, span: Span): Scale {
  const end = Math.floor(now / STEP_MS) * STEP_MS;
  const start = end - span * HOUR;
  const x = (at: number | string) => {
    const t = typeof at === "string" ? Date.parse(at) : at;
    return Math.max(0, Math.min(100, ((t - start) / (end - start)) * 100));
  };
  return { start, end, x };
}

/** The hour marks of a span, on whole hours of the viewer's clock: every hour, every 2 h over 8 h, none next to now. */
export function hourMarks(scale: Scale, span: Span): number[] {
  const every = span > 4 ? 2 : 1;
  const marks: number[] = [];
  const first = new Date(scale.start);
  first.setMinutes(0, 0, 0);
  // None right before now, where the "now" label sits.
  const last = scale.end - (scale.end - scale.start) * 0.06;
  for (let t = first.getTime() + HOUR; t < last; t += HOUR)
    if (new Date(t).getHours() % every === 0 && t > scale.start) marks.push(t);
  return marks;
}

/** A phase's color: the shell's tones (the plan and the work in blue, a decision orange, a failure red, done green). */
export const PHASE_COLOR: Record<AgentPhase, string> = {
  planning: "var(--frontier)",
  "awaiting-approval": "var(--accent)",
  implementing: "var(--frontier)",
  shipping: "var(--frontier)",
  blocked: "var(--critical)",
  "ready-to-merge": "var(--done)",
  merged: "var(--done)",
  released: "var(--text-3)",
};

/** A phase segment's place on the row; null when it ended before the span. */
export function segmentBox(
  s: FleetRow["timeline"]["phases"][number],
  scale: Scale,
): { x: number; width: number } | null {
  const to = s.to === null ? scale.end : Date.parse(s.to);
  if (to <= scale.start) return null;
  const x = scale.x(s.from);
  return { x, width: Math.max(0, scale.x(to) - x) };
}
