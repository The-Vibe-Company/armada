// Shared by Bun's first test preload and Node's --import, before test modules load.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ARMADA_KEYCHAIN ??= "file";
if (process.env.XDG_CONFIG_HOME === undefined) {
  const directory = mkdtempSync(join(tmpdir(), "armada-test-config-"));
  process.env.XDG_CONFIG_HOME = directory;
  // Children inherit this root; only its creator removes it after the run.
  process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
}
