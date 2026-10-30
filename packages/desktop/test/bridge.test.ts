import assert from "node:assert/strict";
import { test } from "node:test";
import { BADGE_MAX, badgeCount, fromApp } from "../src/bridge.ts";

test("the dock's badge takes a whole count up to its cap; anything else clears it", () => {
  assert.equal(badgeCount(3), 3);
  assert.equal(badgeCount(BADGE_MAX + 40), BADGE_MAX);
  for (const value of [0, -2, 1.5, Number.NaN, "4", null, undefined, {}]) assert.equal(badgeCount(value), 0);
});

test("only a page of the app's own origin reaches the bridge", () => {
  const app = "http://127.0.0.1:4831";
  assert.equal(fromApp(`${app}/#/projects/harbor`, app), true);
  assert.equal(fromApp(app, `${app}/`), true);
  for (const url of [
    "http://127.0.0.1:4832/",
    "https://example.com/",
    "file:///index.html",
    "not a url",
    "",
    undefined,
  ])
    assert.equal(fromApp(url, app), false);
});
