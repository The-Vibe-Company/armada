// The one place Armada resolves its keys. Each key comes from the environment
// first, then from the machine store (~/.config/armada/credentials), then,
// for non-secret settings only, from the personal config. GitHub keeps its
// own chain and ends with the GitHub CLI login. The Armada API address and
// the terminal's sign-in to it resolve here too. Every command asks this
// function and nothing else.
import type { ArmadaSignIn } from "./armada-api.ts";
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
  /** The Armada API: ARMADA_API_URL, then `[api] url` in config.toml, then the built-in address. */
  armadaApi: { url: string; source: CredentialSource | { kind: "default" } };
  /**
   * How this terminal signs in to Armada: ARMADA_API_KEY from the environment,
   * then what `armada login` stored (a session token or an API key); null when
   * signed out. `source` is safe to print; the secret never is.
   */
  armadaSignIn: (ArmadaSignIn & { source: CredentialSource }) | null;
}

/** The Armada the CLI talks to unless ARMADA_API_URL or `[api] url` names another (self-hosting). */
export const DEFAULT_ARMADA_API_URL = "https://armada.thevibecompany.co";

/** Credentials-file keys of the sign-in; `armada login` writes one, `armada logout` removes both. */
export const SESSION_TOKEN_VARIABLE = "ARMADA_SESSION_TOKEN";
export const API_KEY_VARIABLE = "ARMADA_API_KEY";
export const API_URL_VARIABLE = "ARMADA_API_URL";

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
  const apiUrlConfig = clean(personal?.api.url);
  const apiUrl = fromEnv(env, API_URL_VARIABLE);
  const armadaApi: Credentials["armadaApi"] = apiUrl
    ? { url: apiUrl.value, source: apiUrl.source }
    : apiUrlConfig
      ? { url: apiUrlConfig, source: { kind: "config", key: "api.url" } }
      : { url: DEFAULT_ARMADA_API_URL, source: { kind: "default" } };
  // The environment's key wins: a headless coordinator is configured by its environment.
  const envKey = fromEnv(env, API_KEY_VARIABLE);
  const session = fromStore(SESSION_TOKEN_VARIABLE);
  const storedKey = fromStore(API_KEY_VARIABLE);
  const armadaSignIn: Credentials["armadaSignIn"] = envKey
    ? { kind: "api-key", key: envKey.value, source: envKey.source }
    : session
      ? { kind: "session", token: session.value, source: session.source }
      : storedKey
        ? { kind: "api-key", key: storedKey.value, source: storedKey.source }
        : null;
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
    armadaApi,
    armadaSignIn,
  };
}

/** Stored keys with no value from any source, in prompt order. */
export const missingKeys = (credentials: Credentials): StoredKey[] =>
  STORED_KEYS.filter((k) => credentials[k.name] === null);

/** The sentence a command prints when a required key is missing. Names the variable, never a value. */
export function missingKeyMessage(key: StoredKey): string {
  return `${key.variable} is not set. Set it in the environment, or run \`armada auth login\` to store it on this machine (${key.hint}).`;
}
