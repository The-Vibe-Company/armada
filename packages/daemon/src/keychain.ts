import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type ModelConfig, modelConfigSchema, modelKindSchema, piCoordinatorModelSchema } from "@armada/protocol";
import type { KeychainBackend } from "./secrets/backend.ts";
import { fileKeychain } from "./secrets/file.ts";
import { macKeychain } from "./secrets/macos.ts";

export type ModelProvider = string;
export type SecretService = "coordinator" | "linear" | "github" | "plugin" | "pi";
export interface PluginCredential {
  provider: ModelProvider;
  key: string;
  config?: ModelConfig;
  model?: never;
}
export type CoordinatorCredential = PluginCredential | { provider: string; model: string; key?: never; config?: never };
export interface CredentialStatus {
  provider: ModelProvider | null;
  storage: KeychainBackend["storage"];
  needsRepair?: boolean;
  config?: ModelConfig;
}
/** Migrate the pre-plugin OpenAI identity without persisting or exposing its key. */
export function coordinatorModelConfig(provider: string, config?: ModelConfig) {
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
  pi: "armada.pi",
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

  async remove(service: SecretService, account: string): Promise<void> {
    try {
      if (!account || !Object.hasOwn(services, service) || !this.#backend.delete) throw new Error();
      await this.#backend.delete(services[service], account);
    } catch {
      throw new Error("Credential could not be removed");
    }
  }

  async lock(service: SecretService, account: string): Promise<() => Promise<void>> {
    try {
      if (!account || !Object.hasOwn(services, service)) throw new Error();
      const release = await this.#backend.lock?.(services[service], account);
      return async () => {
        try {
          await release?.();
        } catch {
          throw new Error("Credential lock could not be released");
        }
      };
    } catch {
      throw new Error("Credential storage is busy");
    }
  }

  async selectCoordinator(selection: { provider: string; model: string }): Promise<void> {
    const value = piCoordinatorModelSchema.parse(selection);
    const release = await this.lock("coordinator", "coordinator");
    try {
      const previous = await this.coordinator();
      if (previous?.key) await this.write("coordinator", "plugin", JSON.stringify(previous));
      await this.write("coordinator", "coordinator", JSON.stringify(value));
    } finally {
      await release();
    }
  }

  async setCoordinator(provider: ModelProvider, key: string, config?: ModelConfig): Promise<void> {
    if (
      !modelKindSchema.safeParse(provider).success ||
      !validKey(key) ||
      (config && !modelConfigSchema.safeParse(config).success)
    )
      throw new Error("Invalid model credential");
    const value = JSON.stringify({ ...coordinatorModelConfig(provider, config), key });
    const release = await this.lock("coordinator", "coordinator").catch(() => {
      throw new Error("Credential could not be saved");
    });
    try {
      await this.write("coordinator", "coordinator", value);
    } finally {
      await release();
    }
  }

  async coordinator(): Promise<CoordinatorCredential | null> {
    const value = await this.read("coordinator", "coordinator");
    if (value === null) return null;
    return this.#parseCoordinator(value);
  }

  async pluginCoordinator(): Promise<PluginCredential | null> {
    const active = await this.coordinator();
    if (active?.key) return active as PluginCredential;
    const backup = await this.read("coordinator", "plugin");
    const saved = backup === null ? null : this.#parseCoordinator(backup);
    return saved?.key ? (saved as PluginCredential) : null;
  }

  #parseCoordinator(value: string): CoordinatorCredential {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed.model === "string") return piCoordinatorModelSchema.parse(parsed);
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

/** macOS never silently falls back to a file if the Keychain is locked/unavailable.
 * `ARMADA_KEYCHAIN=file` picks the file under `XDG_CONFIG_HOME` on every platform: for
 * the tests that start a real daemon, so none of them reaches the owner's Keychain. */
export function systemKeychain(): Keychain {
  const file = process.env.ARMADA_KEYCHAIN?.trim() === "file";
  if (!file && process.platform === "darwin") return new Keychain(macKeychain());
  if (!file && process.platform !== "linux") throw new Error("Credential storage is unsupported on this platform");
  const configured = process.env.XDG_CONFIG_HOME?.trim();
  const root = configured && isAbsolute(configured) ? configured : join(homedir(), ".config");
  return new Keychain(fileKeychain(join(root, "armada", "desktop", "credentials")));
}
