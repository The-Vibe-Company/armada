import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const resource = (name: string) => readFileSync(fileURLToPath(new URL(`../resources/${name}`, import.meta.url)));

test("the app's icon is the mark on its tile, rendered at 1024 px and as an icns", () => {
  const svg = resource("icon.svg").toString();
  assert.match(svg, /fill="#b6f15a"/, "the leader keeps the mark's green");
  assert.equal((svg.match(/<path /g) ?? []).length, 5, "all five agents of the mark");
  const png = resource("icon.png");
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  assert.equal(resource("icon.icns").subarray(0, 4).toString(), "icns");
});
