import { execFile } from "node:child_process";

export type TokenCommand = (file: string, args: readonly string[], signal?: AbortSignal) => Promise<string>;

const command: TokenCommand = (file, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024, signal }, (error, stdout) => {
      // Child-process errors can contain stdout/stderr and credentials; never propagate them.
      if (error) reject(new Error("GitHub credential command failed"));
      else resolve(stdout);
    });
  });

/** Owner credentials only. Reserved OS service armada.github, account github; gh is the fallback. */
export async function githubToken(
  options: { signal?: AbortSignal; command?: TokenCommand; platform?: string } = {},
): Promise<string> {
  const run = options.command ?? command;
  const sources: [string, string[]][] = [
    ...((options.platform ?? process.platform) === "darwin"
      ? [["security", ["find-generic-password", "-s", "armada.github", "-a", "github", "-w"]] as [string, string[]]]
      : []),
    ["gh", ["auth", "token"]],
  ];
  for (const [file, args] of sources) {
    if (options.signal?.aborted) break;
    try {
      const token = (await run(file, args, options.signal)).trim();
      if (token && !/\s/.test(token) && !options.signal?.aborted) return token;
    } catch {
      // A missing keychain entry/CLI or locked keychain falls through without logging.
    }
  }
  throw new Error("GitHub credentials unavailable; sign in with gh auth login or save the owner token in the keychain");
}
