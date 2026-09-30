// The one place Armada resolves its keys. Each key comes from the environment
// first, then from the machine store (~/.config/armada/credentials), then,
// for non-secret settings only, from the personal config. GitHub keeps its
// own chain and ends with the GitHub CLI login. Every command asks this
// function and nothing else.
import type { PersonalConfig } from "./machine.ts";

export type CredentialName = "linearApiKey" | "tursoUrl" | "tursoToken" | "githubToken";

export type CredentialSource =
  | { kind: "env"; variable: string }
  | { kind: "store" }
  | { kind: "config"; key: string }
  | { kind: "gh" };

export interface Credentials {
  /** Linear personal API key, or null when none is configured. */
  linearApiKey: string | null;
  /** Turso (libSQL) database URL, or null. */
  tursoUrl: string | null;
  /** Turso database token, or null. */
  tursoToken: string | null;
  /** GitHub token, or null when none is configured. */
  githubToken: string | null;
  /** Where each value came from; null when it is missing. Safe to print. */
  sources: Record<CredentialName, CredentialSource | null>;
}

export interface StoredKey {
  name: Exclude<CredentialName, "githubToken">;
  /** Environment variable and credentials-file key. */
  variable: string;
  /** Whether the value must never be echoed. */
  secret: boolean;
  label: string;
  /** Where to get it. */
  hint: string;
}

export const LINEAR_KEY: StoredKey = {
  name: "linearApiKey",
  variable: "LINEAR_API_KEY",
  secret: true,
  label: "Linear API key",
  hint: "Linear > Settings > Security & access > Personal API keys",
};

/** The keys Armada keeps in the machine store, in prompt order. */
export const STORED_KEYS: readonly StoredKey[] = [
  LINEAR_KEY,
  {
    name: "tursoUrl",
    variable: "ARMADA_TURSO_URL",
    secret: false,
    label: "Turso database URL",
    hint: "libsql://<database>-<organization>.turso.io, from `turso db show <database> --url`",
  },
  {
    name: "tursoToken",
    variable: "ARMADA_TURSO_TOKEN",
    secret: true,
    label: "Turso database token",
    hint: "`turso db tokens create <database>`",
  },
];

export interface CredentialSources {
  env: Record<string, string | undefined>;
  /** Values of the machine credentials file, if any. */
  store?: Record<string, string>;
  /** Personal config.toml, if any. */
  personal?: PersonalConfig;
  /** Token from the GitHub CLI (`gh auth token`); called only when the environment has none. */
  ghToken?: () => string | null;
}

const clean = (v: string | null | undefined) => v?.trim() || null;

type Found = { value: string; source: CredentialSource } | null;

const fromEnv = (env: CredentialSources["env"], variable: string): Found => {
  const value = clean(env[variable]);
  return value ? { value, source: { kind: "env", variable } } : null;
};

/**
 * Linear: LINEAR_API_KEY, then the credentials file. Turso: ARMADA_TURSO_URL and
 * ARMADA_TURSO_TOKEN, then the credentials file (the URL also from config.toml
 * `turso.url`). GitHub: GITHUB_TOKEN, then GH_TOKEN, then `gh auth token`.
 */
export function resolveCredentials({ env, store = {}, personal, ghToken }: CredentialSources): Credentials {
  const fromStore = (variable: string): Found => {
    const value = clean(store[variable]);
    return value ? { value, source: { kind: "store" } } : null;
  };
  const stored = (variable: string): Found => fromEnv(env, variable) ?? fromStore(variable);
  const fromGh = (): Found => {
    const value = clean(ghToken?.());
    return value ? { value, source: { kind: "gh" } } : null;
  };

  const tursoUrlConfig = clean(personal?.turso.url);
  const found: Record<CredentialName, Found> = {
    linearApiKey: stored("LINEAR_API_KEY"),
    tursoUrl:
      stored("ARMADA_TURSO_URL") ??
      (tursoUrlConfig ? { value: tursoUrlConfig, source: { kind: "config", key: "turso.url" } } : null),
    tursoToken: stored("ARMADA_TURSO_TOKEN"),
    githubToken: fromEnv(env, "GITHUB_TOKEN") ?? fromEnv(env, "GH_TOKEN") ?? fromGh(),
  };
  return {
    linearApiKey: found.linearApiKey?.value ?? null,
    tursoUrl: found.tursoUrl?.value ?? null,
    tursoToken: found.tursoToken?.value ?? null,
    githubToken: found.githubToken?.value ?? null,
    sources: {
      linearApiKey: found.linearApiKey?.source ?? null,
      tursoUrl: found.tursoUrl?.source ?? null,
      tursoToken: found.tursoToken?.source ?? null,
      githubToken: found.githubToken?.source ?? null,
    },
  };
}

/** Stored keys with no value from any source, in prompt order. */
export const missingKeys = (credentials: Credentials): StoredKey[] =>
  STORED_KEYS.filter((k) => credentials[k.name] === null);

/** The sentence a command prints when a required key is missing. Names the variable, never a value. */
export function missingKeyMessage(key: StoredKey): string {
  return `${key.variable} is not set. Set it in the environment, or run \`armada auth login\` to store it on this machine (${key.hint}).`;
}
