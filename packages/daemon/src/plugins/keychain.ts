import { execFile } from "node:child_process";

export const PLUGIN_KEYCHAIN_SERVICE = "armada.plugins";
type SecretCommand = (file: string, args: string[]) => Promise<string>;
const command: SecretCommand = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 }, (error, stdout) => {
      // Child-process errors can include credentials in stdout/stderr. Discard them.
      if (error) reject(new Error("plugin secret unavailable"));
      else resolve(stdout);
    });
  });

/** Called only after the loader checks declaration. Missing/locked entries return null. */
export async function readPluginSecret(
  name: string,
  options: { platform?: string; command?: SecretCommand } = {},
): Promise<string | null> {
  if ((options.platform ?? process.platform) !== "darwin") return null;
  try {
    const value = await (options.command ?? command)("security", [
      "find-generic-password",
      "-s",
      PLUGIN_KEYCHAIN_SERVICE,
      "-a",
      name,
      "-w",
    ]);
    // security adds one line ending; preserve whitespace inside the stored value.
    return (value.endsWith("\n") ? value.slice(0, -1) : value) || null;
  } catch {
    return null;
  }
}
