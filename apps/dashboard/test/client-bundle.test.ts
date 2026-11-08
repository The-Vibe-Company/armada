import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const SRC = join(APP, "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

test("the dashboard depends on no provider adapter or SDK: its only workspace import is @armada/core", () => {
  const manifest = JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as Record<string, unknown>;
  const declared = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((field) =>
    Object.keys((manifest[field] as Record<string, string> | undefined) ?? {}),
  );
  expect(declared.filter((name) => name.startsWith("@armada/"))).toEqual(["@armada/core"]);
  expect(declared.filter((name) => /^@boatdev\/|modal/.test(name))).toEqual([]);
  expect(readFileSync(join(APP, "next.config.ts"), "utf8")).not.toMatch(/provider-|@boatdev/);
  for (const path of [...files(SRC), ...files(join(APP, "e2e"))]) {
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(/@armada\/provider-|@boatdev\/sdk|createBoatProvider/);
    for (const [, specifier] of source.matchAll(/from\s+["'](@armada\/[^"']+)["']/g))
      expect(specifier).toBe("@armada/core");
  }
});

test("no client component reaches the server-only control client", () => {
  const clients = files(SRC).filter((path) => /^\s*["']use client["']/.test(readFileSync(path, "utf8")));
  expect(clients.length).toBeGreaterThan(0);
  for (const path of clients) {
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(/@\/lib\/control|lib\/control\.ts|@armada\/core\/server/);
  }
});
