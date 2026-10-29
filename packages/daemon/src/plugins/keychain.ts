import { type Keychain, systemKeychain } from "../keychain.ts";

/** Called only after declaration checks; the shared gateway owns storage and redaction. */
export async function readPluginSecret(name: string, keychain?: Pick<Keychain, "read">): Promise<string | null> {
  try {
    const environment =
      name === "LINEAR_API_KEY"
        ? process.env.LINEAR_API_KEY
        : name === "GITHUB_TOKEN"
          ? process.env.GITHUB_TOKEN
          : undefined;
    if (environment?.trim()) return environment.trim();
    const chain = keychain ?? systemKeychain();
    if (name === "GITHUB_TOKEN") {
      const owner = await chain.read("github", "github");
      if (owner) return owner;
    }
    return await chain.read("plugin", name);
  } catch {
    return null;
  }
}
