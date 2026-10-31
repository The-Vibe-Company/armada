import assert from "node:assert/strict";
import { test } from "node:test";
import { BADGE_MAX, badgeCount, externalUrl, fromApp, pickedFolder } from "../src/bridge.ts";

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

test("the system browser opens http and https addresses off the app's own origin, nothing else", () => {
  const app = "http://127.0.0.1:4831";
  assert.equal(
    externalUrl("https://armada.example/device?code=ABCDEFGH", app),
    "https://armada.example/device?code=ABCDEFGH",
  );
  assert.equal(externalUrl("http://localhost:4822/device", app), "http://localhost:4822/device");
  for (const value of [
    `${app}/#/settings`,
    "file:///etc/hosts",
    "javascript:alert(1)",
    "conductor://workspace/1",
    "not a url",
    42,
    undefined,
  ])
    assert.equal(externalUrl(value, app), null);
});

test("the folder picker answers its one chosen folder, or nothing", () => {
  assert.equal(pickedFolder({ canceled: false, filePaths: ["/Users/owner/Dev/kestrel"] }), "/Users/owner/Dev/kestrel");
  assert.equal(pickedFolder({ canceled: true, filePaths: ["/Users/owner/Dev/kestrel"] }), null);
  assert.equal(pickedFolder({ canceled: false, filePaths: [] }), null);
  assert.equal(pickedFolder({ canceled: false, filePaths: ["/a", "/b"] }), null);
});
