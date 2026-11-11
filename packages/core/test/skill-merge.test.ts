import { expect, test } from "bun:test";
import { mergeSkillPins } from "../src/skill-merge.ts";

test("skill merging uses slug identity across catalogs and rejects excessive effective pins", () => {
  expect(mergeSkillPins(["one/notes@1.0.0"], ["notes@2.0.0"], ["two/notes@3.0.0"])).toEqual(["two/notes@3.0.0"]);
  const full = Array.from({ length: 20 }, (_, i) => `skill-${i}@1.0.0`);
  expect(() => mergeSkillPins(full, ["extra@1.0.0"])).toThrow();
  // The limit is on effective slugs, not the sum of all layer lengths.
  expect(mergeSkillPins(full, ["skill-0@2.0.0"])).toHaveLength(20);
});
