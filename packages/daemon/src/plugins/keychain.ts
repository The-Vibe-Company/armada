import { execFile } from "node:child_process";
import { type Keychain, systemKeychain } from "../keychain.ts";

/** Called only after declaration checks; the shared gateway owns storage and redaction. */
export async function readPluginSecret(name: string, keychain?: Pick<Keychain, "read">): Promise<string | null> {
  try {
    const environment = process.env[name];
    if (environment?.trim()) return environment.trim();
    let chain: Pick<Keychain, "read"> | undefined = keychain;
    try {
      chain ??= systemKeychain();
    } catch {
      /* gh remains usable when the keychain is unavailable. */
    }
    const plugin = await chain?.read("plugin", name).catch(() => null);
    if (plugin) return plugin;
    // Keep credentials saved before plugins were introduced usable.
    if (name !== "GITHUB_TOKEN") return null;
    const owner = await chain?.read("github", "github").catch(() => null);
    if (owner) return owner;
    return await new Promise<string | null>((resolve) => {
      execFile("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000, maxBuffer: 16384 }, (error, stdout) => {
        const token = stdout?.trim();
        resolve(!error && token && !/\s/.test(token) ? token : null);
      });
    });
  } catch {
    return null;
  }
}
