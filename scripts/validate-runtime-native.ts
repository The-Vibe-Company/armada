/** CI/Linux-only proof of the native artifact; never run native Linux extraction on macOS. */
import { join } from "node:path";

if (process.platform !== "linux" || Bun.version !== "1.4.2")
  throw new Error("Native validation requires Linux and Bun 1.4.2.");
for (const [name, expected] of [
  ["claude", "2.1.322 (Claude Code)"],
  ["codex", "codex-cli 0.167.0"],
]) {
  const result = Bun.spawnSync([join(import.meta.dir, "../packages/agent-runtime/dist", name!), "--version"]);
  if (result.exitCode !== 0 || result.stdout.toString().trim() !== expected)
    throw new Error(`Pinned ${name} native version validation failed.`);
}
