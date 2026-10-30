import type { KeychainBackend } from "../../src/secrets/backend.ts";

/** Tests generate credentials at runtime; no key belongs in a fixture. */
export class FakeKeychain implements KeychainBackend {
  readonly storage = "os-keychain" as const;
  readonly entries = new Map<string, string>();
  async read(service: string, account: string) {
    return this.entries.get(JSON.stringify([service, account])) ?? null;
  }
  async write(service: string, account: string, value: string) {
    this.entries.set(JSON.stringify([service, account]), value);
  }
  async delete(service: string, account: string) {
    this.entries.delete(JSON.stringify([service, account]));
  }
}
