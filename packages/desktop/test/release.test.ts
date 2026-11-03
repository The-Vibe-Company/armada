import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PRODUCT_NAME } from "../src/packaging.ts";

// One version for the whole repository (THE-2228, decision 1): the tag release-please cuts
// is the CLI's, the desktop's and the daemon's, so the app's About panel and latest-mac.yml
// carry the release that the release workflow attaches them to.
const root = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const json = (path: string) => JSON.parse(read(path));
const BUMPED = ["packages/cli/package.json", "packages/desktop/package.json", "packages/daemon/package.json"];

test("release-please bumps the CLI, the desktop and the daemon to the one manifest version", () => {
  const version: string = json(".release-please-manifest.json")["."];
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(json("package.json").version, version, "the root package carries the manifest's version");

  const extraFiles: { type: string; path: string; jsonpath: string }[] =
    json("release-please-config.json").packages["."]["extra-files"];
  assert.deepEqual(
    extraFiles.map((file) => file.path).sort(),
    [...BUMPED].sort(),
    "every package whose version a release carries is bumped with it",
  );
  for (const file of extraFiles) {
    assert.deepEqual({ type: file.type, jsonpath: file.jsonpath }, { type: "json", jsonpath: "$.version" }, file.path);
    assert.equal(json(file.path).version, version, `${file.path} is at the released version`);
  }
});

test("the release workflow builds the desktop with its dist script and ships every file of the update feed", () => {
  const workflow = read(".github/workflows/release.yml");
  assert.match(workflow, /^\s+desktop:\n/m, "a desktop job");
  assert.match(workflow, /runs-on: macos-14/, "built on Apple Silicon");
  assert.match(workflow, /run: bun run --cwd packages\/desktop dist/, "the package's own dist script");
  assert.match(workflow, /desktop_only:/, "an artifact-only dispatch input");
  // What electron-builder writes under packages/desktop/release (packaging.ts: dmg and zip
  // targets, the feed's latest-mac.yml and the blockmaps), uploaded as the release's assets
  // and as the dispatch's artifact.
  for (const asset of [`${PRODUCT_NAME}-*.dmg`, `${PRODUCT_NAME}-*.zip`, "latest-mac.yml", "*.blockmap"]) {
    const uploads = workflow.split("\n").filter((line) => line.includes(asset));
    assert.ok(uploads.length >= 2, `${asset} reaches the release and the artifact`);
  }
  assert.match(workflow, /gh release upload "\$TAG"/, "attached to the release release-please created");
  assert.match(workflow, /unsigned/, "the release notes say when the DMG is unsigned");
});
