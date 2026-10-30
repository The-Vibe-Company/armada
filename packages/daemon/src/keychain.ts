import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type CoordinatorModel, modelConfigSchema, modelKindSchema } from "@armada/protocol";
import type { KeychainBackend } from "./secrets/backend.ts";
import { fileKeychain } from "./secrets/file.ts";
import { macKeychain } from "./secrets/macos.ts";

export type ModelProvider = string;
export type SecretService = "coordinator" | "linear" | "github" | "plugin";
export interface CoordinatorCredential {
  provider: ModelProvider;
  key: string;
  config?: CoordinatorModel["config"];
}
export interface CredentialStatus {
  provider: ModelProvider | null;
  storage: KeychainBackend["storage"];
  needsRepair?: boolean;
  config?: CoordinatorModel["config"];
}
/** Migrate the pre-plugin OpenAI identity without persisting or exposing its key. */
export function coordinatorModelConfig(provider: string, config?: CoordinatorModel["config"]) {
  return provider === "openai"
    ? {
        provider: "openai-compatible",
        config: { baseURL: "https://api.openai.com/v1", model: "gpt-4.1-mini", ...config },
      }
    : { provider, config };
}
class InvalidCoordinatorCredential extends Error {}

const services = {
  coordinator: "armada.coordinator",
  linear: "armada.linear",
  github: "armada.github",
  plugin: "armada.plugins",
} as const;
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

  async setCoordinator(provider: ModelProvider, key: string, config?: CoordinatorModel["config"]): Promise<void> {
    if (
      !modelKindSchema.safeParse(provider).success ||
      !validKey(key) ||
      (config && !modelConfigSchema.safeParse(config).success)
    )
      throw new Error("Invalid model credential");
    // One entry atomically replaces both the provider and its key.
    await this.write(
      "coordinator",
      "coordinator",
      JSON.stringify({ ...coordinatorModelConfig(provider, config), key }),
    );
  }

  async coordinator(): Promise<CoordinatorCredential | null> {
    const value = await this.read("coordinator", "coordinator");
    if (value === null) return null;
    try {
      const parsed = JSON.parse(value);
      if (
        !modelKindSchema.safeParse(parsed.provider).success ||
        typeof parsed.key !== "string" ||
        !validKey(parsed.key)
      )
        throw new Error();
      const config = parsed.config === undefined ? undefined : modelConfigSchema.parse(parsed.config);
      const normalized = coordinatorModelConfig(parsed.provider, config);
      return {
        provider: normalized.provider,
        key: parsed.key,
        ...(normalized.config ? { config: normalized.config } : {}),
      };
    } catch {
      throw new InvalidCoordinatorCredential("Saved model credential is invalid");
    }
  }

  async status(): Promise<CredentialStatus> {
    let saved: CoordinatorCredential | null;
    try {
      saved = await this.coordinator();
    } catch (error) {
      if (!(error instanceof InvalidCoordinatorCredential)) throw error;
      return { provider: null, storage: this.#backend.storage, needsRepair: true };
    }
    return {
      provider: saved?.provider ?? null,
      storage: this.#backend.storage,
      ...(saved?.config ? { config: saved.config } : {}),
    };
  }
}

/** macOS never silently falls back to a file if the Keychain is locked/unavailable. */
export function systemKeychain(): Keychain {
  if (process.platform === "darwin") return new Keychain(macKeychain());
  if (process.platform !== "linux") throw new Error("Credential storage is unsupported on this platform");
  const configured = process.env.XDG_CONFIG_HOME?.trim();
  const root = configured && isAbsolute(configured) ? configured : join(homedir(), ".config");
  return new Keychain(fileKeychain(join(root, "armada", "desktop", "credentials")));
}
