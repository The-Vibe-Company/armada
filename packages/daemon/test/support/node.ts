import { execFileSync } from "node:child_process";
import "../../../../scripts/test-env.ts";

/** Real daemon children always use disposable credentials, including scratch environments. */
export function daemonEnv(directory: string): NodeJS.ProcessEnv {
  return { ...process.env, ARMADA_KEYCHAIN: "file", XDG_CONFIG_HOME: directory };
}

// Root `bun test` discovers these Node suites too. Keep their children on Node:
// Bun's --import handling does not provide the Node preload used by offline boot fixtures.
// A Node-run suite already has the right executable; only the Bun host needs a bounded lookup.
export const nodeExecutable = process.versions.bun
  ? execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8", timeout: 10000 }).trim()
  : process.execPath;
