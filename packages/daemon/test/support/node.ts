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

/** Startup progress may precede the address; tests wait for the actual bound server. */
export async function daemonReady(child: import("node:child_process").ChildProcess): Promise<{
  url: string;
  wsUrl: string;
  readers: import("../../src/server/readers.ts").ReaderState[];
  timings: Record<string, number>;
}> {
  const { createInterface } = await import("node:readline");
  if (!child.stdout) throw new Error("daemon stdout is not piped");
  const lines = createInterface({ input: child.stdout });
  try {
    return await new Promise((resolve, reject) => {
      const exited = () => reject(new Error("daemon exited before readiness"));
      child.once("exit", exited);
      lines.on("line", (line) => {
        try {
          const value = JSON.parse(line);
          if (value.url) {
            child.off("exit", exited);
            resolve(value);
          }
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    lines.close();
  }
}
