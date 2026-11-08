import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../src/version.ts";

test("every workspace package carries the version the binary reports", async () => {
  const packages = join(import.meta.dir, "../..");
  const names = readdirSync(packages);
  expect(names).toContain("cli");
  for (const name of names) {
    const pkg = await Bun.file(join(packages, name, "package.json")).json();
    expect({ name, version: pkg.version }).toEqual({ name, version: VERSION });
  }
});
