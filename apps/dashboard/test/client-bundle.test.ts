import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

test("no client component reaches the Boat adapter, its SDK or the server-only capacity loader", () => {
  const clients = files(SRC).filter((path) => /^\s*["']use client["']/.test(readFileSync(path, "utf8")));
  expect(clients.length).toBeGreaterThan(0);
  for (const path of clients) {
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(/@armada\/provider-boat|@boatdev\/sdk|golden-capacity|@armada\/core\/server/);
  }
  // The only importer of the adapter is the server loader.
  const importers = files(SRC).filter((path) => readFileSync(path, "utf8").includes("@armada/provider-boat"));
  expect(importers.map((path) => path.slice(SRC.length + 1))).toEqual(["lib/data/golden-capacity.ts"]);
});
