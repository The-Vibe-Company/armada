import { describe, expect, test } from "bun:test";
import { hourMarks, scaleOf, segmentBox } from "../components/timeline/scale.ts";

const NOW = new Date(2026, 9, 1, 13, 42, 10).getTime();
const at = (h: number, m = 0) => new Date(2026, 9, 1, h, m).getTime();

describe("the live timeline's scale", () => {
  test("places times on the span, keeps them on the row, and moves by 15 s steps", () => {
    const s = scaleOf(NOW, 4);
    expect(s.end).toBe(new Date(2026, 9, 1, 13, 42, 0).getTime());
    expect(s.x(s.end)).toBe(100);
    expect(s.x(at(11, 42))).toBe(50);
    expect(s.x(at(6))).toBe(0);
  });

  test("marks whole hours of the viewer's clock, every 2 h over 8 h", () => {
    expect(hourMarks(scaleOf(NOW, 2), 2)).toEqual([at(12), at(13)]);
    expect(hourMarks(scaleOf(NOW, 8), 8)).toEqual([at(6), at(8), at(10), at(12)]);
    // 14:00 is 3 minutes before now: it would sit on the "now" label.
    expect(hourMarks(scaleOf(at(14, 3), 2), 2)).toEqual([at(13)]);
  });

  test("a phase that ended before the span is left out; one that started before is cut at its start", () => {
    const s = scaleOf(NOW, 2);
    const iso = (t: number) => new Date(t).toISOString();
    expect(segmentBox({ phase: "planning", from: iso(at(9)), to: iso(at(11)), summary: null }, s)).toBeNull();
    expect(segmentBox({ phase: "implementing", from: iso(at(11)), to: null, summary: null }, s)).toEqual({
      x: 0,
      width: 100,
    });
  });
});
