import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../src/version.ts";

test("every workspace package carries the version the binary reports", async () => {
  const root = join(import.meta.dir, "../../..");
  const paths = [
    "package.json",
    ...["packages", "apps"].flatMap((directory) =>
      readdirSync(join(root, directory)).map((name) => `${directory}/${name}/package.json`),
    ),
  ];
  for (const path of paths) {
    const pkg = await Bun.file(join(root, path)).json();
    expect({ path, version: pkg.version }).toEqual({ path, version: VERSION });
  }
});
