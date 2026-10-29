import { execFile } from "node:child_process";

type Command = (file: string, args: readonly string[], signal?: AbortSignal) => Promise<string>;
interface TokenOptions {
  signal?: AbortSignal;
  command?: Command;
  keychain?: { read(service: "github", account: string): Promise<string | null> };
}
const command: Command = (file, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: "utf8", timeout: 5000, maxBuffer: 16384, signal }, (error, stdout) => {
      if (error) reject(new Error("GitHub credential command failed"));
      else resolve(stdout);
    });
  });

/** Declared secret first, then the owner's gh session. No keychain/backend access in a plugin. */
export async function githubToken(options: TokenOptions = {}): Promise<string> {
  const usable = (value: string | null) => {
    const token = value?.trim();
    return token && !/\s/.test(token) && !options.signal?.aborted ? token : null;
  };
  if (!options.signal?.aborted) {
    try {
      const token = usable((await options.keychain?.read("github", "github")) ?? null);
      if (token) return token;
    } catch {
      /* Secret backend details never escape. */
    }
  }
  if (!options.signal?.aborted) {
    try {
      const token = usable(await (options.command ?? command)("gh", ["auth", "token"], options.signal));
      if (token) return token;
    } catch {
      /* gh errors may include credentials. */
    }
  }
  throw new Error("GitHub credentials unavailable");
}
