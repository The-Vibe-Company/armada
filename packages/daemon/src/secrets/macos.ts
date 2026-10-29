import type { KeychainBackend } from "./backend.ts";

/** The native binding is lazy: Linux never loads it. No credential is passed in argv. */
export function macKeychain(
  readCommand?: (file: string, args: readonly string[], signal?: AbortSignal) => Promise<string>,
  signal?: AbortSignal,
): KeychainBackend {
  const entry = async (service: string, account: string) => {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry(service, account);
  };
  return {
    storage: "os-keychain",
    async read(service, account) {
      // Preserve the GitHub accessor's existing command injection contract. Production uses the native library.
      if (readCommand)
        return readCommand("security", ["find-generic-password", "-s", service, "-a", account, "-w"], signal);
      return (await entry(service, account)).getPassword();
    },
    async write(service, account, value) {
      await (await entry(service, account)).setPassword(value);
    },
  };
}
