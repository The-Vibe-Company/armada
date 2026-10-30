import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { KeychainBackend } from "./backend.ts";
import { fileKeychain } from "./file.ts";

/** The native binding is lazy: Linux never loads it. No credential is passed in argv. */
export function macKeychain(): KeychainBackend {
  const configured = process.env.XDG_CONFIG_HOME?.trim();
  const root = configured && isAbsolute(configured) ? configured : join(homedir(), ".config");
  // Only lock directories live on disk; credentials stay in the native Keychain.
  const mutex = fileKeychain(join(root, "armada", "desktop", "keychain-locks"));
  const entry = async (service: string, account: string) => {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry(service, account);
  };
  return {
    storage: "os-keychain",
    lock: (service, account) => mutex.lock(service, account),
    async read(service, account) {
      return (await entry(service, account)).getPassword();
    },
    async write(service, account, value) {
      await (await entry(service, account)).setPassword(value);
    },
    async delete(service, account) {
      const credential = await entry(service, account);
      if ((await credential.getPassword()) !== null) await credential.deletePassword();
    },
  };
}
