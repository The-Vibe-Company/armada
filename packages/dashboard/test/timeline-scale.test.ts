import { describe, expect, test } from "bun:test";
import { hourMarks, scaleOf, segmentBox, spanBox, ZOOM } from "../components/timeline/scale.ts";

const NOW = new Date(2026, 9, 1, 13, 42, 10).getTime();
/** Day 0 is the day before (30 September), -1 the one before. */
const at = (h: number, m = 0, day = 1) => new Date(2026, 9, day, h, m).getTime();

describe("the live timeline's scale", () => {
  test("spans the last 24 hours, 3 of them in view, and moves by 15 s steps", () => {
    const s = scaleOf(NOW);
    expect(ZOOM).toBe(8);
    expect(s.end).toBe(new Date(2026, 9, 1, 13, 42, 0).getTime());
    expect(s.x(s.end)).toBe(100);
    expect(s.x(at(1, 42))).toBe(50);
    // The view opens on its last eighth: the last 3 hours.
    expect(s.x(at(10, 42))).toBe(87.5);
    expect(s.x(at(6, 0, 0))).toBe(0);
  });

  test("marks every whole hour of the viewer's clock, but the one next to now", () => {
    const marks = hourMarks(scaleOf(NOW));
    expect(marks).toHaveLength(24);
    expect(marks[0]).toBe(at(14, 0, 0));
    expect(marks.at(-1)).toBe(at(13));
    // 14:00 is 3 minutes before now: it would sit on the "now" label.
    expect(hourMarks(scaleOf(at(14, 3))).at(-1)).toBe(at(13));
  });

  test("a phase that ended before the track is left out; one that started before is cut at its start", () => {
    const s = scaleOf(NOW);
    const iso = (t: number) => new Date(t).toISOString();
    expect(
      segmentBox({ phase: "planning", from: iso(at(9, 0, -1)), to: iso(at(11, 0, -1)), summary: null }, s),
    ).toBeNull();
    expect(segmentBox({ phase: "implementing", from: iso(at(11, 0, -1)), to: null, summary: null }, s)).toEqual({
      x: 0,
      width: 100,
    });
    expect(spanBox(at(1, 42), null, s)).toEqual({ x: 50, width: 50 });
    expect(spanBox(at(1, 0, -1), at(2, 0, -1), s)).toBeNull();
  });
});
