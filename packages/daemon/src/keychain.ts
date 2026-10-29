import { homedir } from "node:os";
import { join } from "node:path";
import type { KeychainBackend } from "./secrets/backend.ts";
import { fileKeychain } from "./secrets/file.ts";
import { macKeychain } from "./secrets/macos.ts";

export type ModelProvider = "anthropic" | "openai";
export type SecretService = "coordinator" | "linear" | "github";
export type SecretAccessor = (service: "linear", project: string) => Promise<string | null>;
export interface CoordinatorCredential {
  provider: ModelProvider;
  key: string;
}
export interface CredentialStatus {
  provider: ModelProvider | null;
  storage: KeychainBackend["storage"];
}
const services = { coordinator: "armada.coordinator", linear: "armada.linear", github: "armada.github" } as const;
const validKey = (key: string) => key.length > 0 && key.length <= 8192 && /^[!-~]+$/.test(key);

/** The only secret-read boundary. Providers receive read(), never the raw backend.
 * Native errors may contain a key: neither errors nor causes cross this boundary.
 */
export class Keychain {
  readonly #backend: KeychainBackend;
  constructor(backend: KeychainBackend) {
    this.#backend = backend;
  }

  async read(service: SecretService, account: string): Promise<string | null> {
    try {
      if (!account || !Object.hasOwn(services, service)) throw new Error();
      return await this.#backend.read(services[service], account);
    } catch {
      throw new Error("Credential lookup failed");
    }
  }

  async write(service: SecretService, account: string, value: string): Promise<void> {
    try {
      if (!account || !Object.hasOwn(services, service) || !value || value.length > 16384) throw new Error();
      await this.#backend.write(services[service], account, value);
    } catch {
      throw new Error("Credential could not be saved");
    }
  }

  async setCoordinator(provider: ModelProvider, key: string): Promise<void> {
    if ((provider !== "anthropic" && provider !== "openai") || !validKey(key))
      throw new Error("Invalid model credential");
    // One entry atomically replaces both the provider and its key.
    await this.write("coordinator", "coordinator", JSON.stringify({ provider, key }));
  }

  async coordinator(): Promise<CoordinatorCredential | null> {
    const value = await this.read("coordinator", "coordinator");
    if (value === null) return null;
    try {
      const parsed = JSON.parse(value);
      if (
        (parsed.provider !== "anthropic" && parsed.provider !== "openai") ||
        typeof parsed.key !== "string" ||
        !validKey(parsed.key)
      )
        throw new Error();
      return { provider: parsed.provider, key: parsed.key };
    } catch {
      throw new Error("Saved model credential is invalid");
    }
  }

  async status(): Promise<CredentialStatus> {
    return { provider: (await this.coordinator())?.provider ?? null, storage: this.#backend.storage };
  }
}

/** macOS never silently falls back to a file if the Keychain is locked/unavailable. */
export function systemKeychain(): Keychain {
  if (process.platform === "darwin") return new Keychain(macKeychain());
  if (process.platform !== "linux") throw new Error("Credential storage is unsupported on this platform");
  return new Keychain(
    fileKeychain(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "armada", "desktop", "credentials")),
  );
}

/** Compatibility with the Linear provider's injected accessor. */
export async function readLinearKey(access: SecretAccessor, project: string): Promise<string> {
  let key: string | null;
  try {
    key = await access("linear", project);
  } catch {
    throw new Error("Linear keychain lookup failed");
  }
  if (!key) throw new Error("Linear key is missing from the keychain");
  return key;
}
