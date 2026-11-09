import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../src/version.ts";

test("every workspace package carries the version the binary reports", async () => {
  const root = join(import.meta.dir, "../../..");
  // A workspace package is a `packages/*` or `apps/*` directory with a package.json, as Bun resolves
  // the root `workspaces`; a native app directory such as `apps/ios` is not one.
  const paths = [
    "package.json",
    ...["packages", "apps"].flatMap((directory) =>
      readdirSync(join(root, directory))
        .map((name) => `${directory}/${name}/package.json`)
        .filter((path) => existsSync(join(root, path))),
    ),
  ];
  for (const path of paths) {
    const pkg = await Bun.file(join(root, path)).json();
    expect({ path, version: pkg.version }).toEqual({ path, version: VERSION });
  }
});
