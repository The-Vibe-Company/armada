import type { KeychainBackend } from "./backend.ts";

/** The native binding is lazy: Linux never loads it. No credential is passed in argv. */
export function macKeychain(): KeychainBackend {
  const entry = async (service: string, account: string) => {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry(service, account);
  };
  return {
    storage: "os-keychain",
    async read(service, account) {
      return (await entry(service, account)).getPassword();
    },
    async write(service, account, value) {
      await (await entry(service, account)).setPassword(value);
    },
  };
}
