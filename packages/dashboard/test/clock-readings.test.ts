import { describe, expect, test } from "bun:test";
import { LANGUAGES, LONGEST_TIMES, STRINGS } from "../lib/i18n";

// The overview keeps a ticking time in a box as wide as its widest reading
// (`Steady`, THE-982): a reading longer than LONGEST_TIMES' would widen the
// box as the clock moves, a layout shift. Digits are tabular, so the count of
// characters stands for the width.
describe("a ticking time", () => {
  const MIN = 60_000;
  const times = Array.from({ length: 3 * 24 * 60 }, (_, k) => k * MIN + 30_000);

  for (const lang of LANGUAGES)
    for (const format of ["duration", "ago"] as const)
      test(`reads no longer than LONGEST_TIMES (${lang}, ${format})`, () => {
        const read = (ms: number) => STRINGS[lang][format](ms);
        const widest = Math.max(...LONGEST_TIMES.map((ms) => read(ms).length));
        expect(times.filter((ms) => read(ms).length > widest).map(read)).toEqual([]);
      });
});
