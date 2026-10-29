import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("committed e2e recordings contain no API key prefix", async () => {
  const directory = resolve(import.meta.dir, "../.e2e/cache");
  const entries = await readdir(directory);
  expect(entries.filter((name) => name.endsWith(".json")).length).toBeGreaterThan(0);
  for (const name of entries) expect(await readFile(resolve(directory, name), "utf8")).not.toContain("sk-");
});
