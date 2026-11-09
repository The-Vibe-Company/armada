import { expect, test } from "bun:test";
import { join } from "node:path";
import { VERSION } from "../src/version.ts";

test("every workspace package carries the version the binary reports", async () => {
  const root = join(import.meta.dir, "../../..");
  const paths = [
    "package.json",
    // Native apps are not Bun workspaces; only package manifests carry this version.
    ...new Bun.Glob("{packages,apps}/*/package.json").scanSync({ cwd: root }),
  ];
  for (const path of paths) {
    const pkg = await Bun.file(join(root, path)).json();
    expect({ path, version: pkg.version }).toEqual({ path, version: VERSION });
  }
});
