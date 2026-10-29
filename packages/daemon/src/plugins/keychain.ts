import { type Keychain, systemKeychain } from "../keychain.ts";

/** Called only after declaration checks; the shared gateway owns storage and redaction. */
export async function readPluginSecret(name: string, keychain?: Pick<Keychain, "read">): Promise<string | null> {
  try {
    return await (keychain ?? systemKeychain()).read("plugin", name);
  } catch {
    return null;
  }
}
