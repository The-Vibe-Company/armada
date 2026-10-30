import assert from "node:assert/strict";
import { test } from "node:test";
import { BADGE_MAX, badgeCount } from "../src/bridge.ts";

test("the dock's badge takes a whole count up to its cap; anything else clears it", () => {
  assert.equal(badgeCount(3), 3);
  assert.equal(badgeCount(BADGE_MAX + 40), BADGE_MAX);
  for (const value of [0, -2, 1.5, Number.NaN, "4", null, undefined, {}]) assert.equal(badgeCount(value), 0);
});
