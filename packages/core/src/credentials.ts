// The one place Armada resolves its keys. Each key comes from the environment
// first, then from Armada (the organization's keys, handed to a signed-in
// terminal), then from the machine store (~/.config/armada/credentials),
// then, for non-secret settings only, from the personal config. GitHub keeps
// its own chain and ends with the GitHub CLI login. The Armada API address and
// the terminal's sign-in to it resolve here too. Every command asks this
// function and nothing else.
import type { ArmadaSignIn } from "./armada-api.ts";
import type { PersonalConfig } from "./machine.ts";

export type CredentialName = "linearApiKey" | "tursoUrl" | "tursoToken" | "githubToken";

export type CredentialSource =
  | { kind: "env"; variable: string }
  | { kind: "store" }
  /** Handed out by Armada; `detail` says whose key or which token, e.g. "your own key". */
  | { kind: "armada"; detail: string }
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
  /**
   * The Armada a stored sign-in belongs to when it is not `armadaApi`: the
   * sign-in is then not used, so its token never reaches another server.
   */
  armadaSignInElsewhere: string | null;
}

/** The Armada the CLI talks to unless ARMADA_API_URL or `[api] url` names another (self-hosting). */
export const DEFAULT_ARMADA_API_URL = "https://armada.thevibecompany.co";

/** Credentials-file keys of the sign-in; `armada login` writes one, `armada logout` removes both. */
export const SESSION_TOKEN_VARIABLE = "ARMADA_SESSION_TOKEN";
export const API_KEY_VARIABLE = "ARMADA_API_KEY";
export const API_URL_VARIABLE = "ARMADA_API_URL";
/** Credentials-file key: the Armada that issued the stored sign-in, which is sent nowhere else. */
export const SIGNED_IN_TO_VARIABLE = "ARMADA_SIGNED_IN_TO";
/**
 * Credentials-file key: the short-lived Turso token Armada made for this
 * terminal, with its expiry, kept until it is renewed. `armada login`,
 * `armada logout` and `armada auth logout` remove it.
 */
export const TURSO_LEASE_VARIABLE = "ARMADA_TURSO_LEASE";

/** A Turso token made by Armada for this terminal. */
export interface TursoLease {
  /** The Armada that made it (`armadaAddress`): it is used only while the CLI talks to that one. */
  api: string;
  organization: string;
  url: string;
  token: string;
  expiresAt: string;
  /** Which Turso keys it was made from; Armada replaces it when they change. */
  revision: string;
}

/** The lease as one credentials-file value (base64url JSON, so it fits a KEY=value line). */
export const formatLease = (lease: TursoLease) => Buffer.from(JSON.stringify(lease), "utf8").toString("base64url");

/** The lease a credentials-file value holds, or null when it is not one. */
export function parseLease(value: string | null | undefined): TursoLease | null {
  if (!value?.trim()) return null;
  try {
    const l = JSON.parse(Buffer.from(value.trim(), "base64url").toString("utf8")) as Record<string, unknown>;
    const keys = ["api", "organization", "url", "token", "expiresAt", "revision"] as const;
    if (!keys.every((k) => typeof l[k] === "string" && l[k])) return null;
    if (Number.isNaN(Date.parse(String(l.expiresAt)))) return null;
    return Object.fromEntries(keys.map((k) => [k, String(l[k])])) as unknown as TursoLease;
  } catch {
    return null;
  }
}

/** What Armada handed out for this command, with where each came from. */
export interface ArmadaKeys {
  linearApiKey: { value: string; detail: string } | null;
  turso: { url: string; token: string; detail: string } | null;
}

/** An Armada's address as sign-ins are bound to it: origin and path, without a trailing slash. */
export function armadaAddress(url: string): string {
  try {
    const u = new URL(url.trim());
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.trim();
  }
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
  /** The organization's keys from Armada, when this terminal is signed in to one that keeps them. */
  armada?: ArmadaKeys | null;
}

const clean = (v: string | null | undefined) => v?.trim() || null;

type Found = { value: string; source: CredentialSource } | null;

const fromEnv = (env: CredentialSources["env"], variable: string): Found => {
  const value = clean(env[variable]);
  return value ? { value, source: { kind: "env", variable } } : null;
};

/**
 * Linear: LINEAR_API_KEY, then Armada, then the credentials file. Turso:
 * ARMADA_TURSO_URL and ARMADA_TURSO_TOKEN, then Armada (URL and token as a
 * pair, only when the environment sets neither), then the credentials file
 * (the URL also from config.toml `turso.url`). GitHub: GITHUB_TOKEN, then
 * GH_TOKEN, then `gh auth token`.
 */
export function resolveCredentials({ env, store = {}, personal, ghToken, armada }: CredentialSources): Credentials {
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
  // A stored sign-in is only sent to the Armada that issued it.
  const signedInTo = armadaAddress(clean(store[SIGNED_IN_TO_VARIABLE]) ?? DEFAULT_ARMADA_API_URL);
  const here = signedInTo === armadaAddress(armadaApi.url);
  const session = fromStore(SESSION_TOKEN_VARIABLE);
  const storedKey = fromStore(API_KEY_VARIABLE);
  const armadaSignInElsewhere = !here && (session || storedKey) ? signedInTo : null;
  const armadaSignIn: Credentials["armadaSignIn"] = envKey
    ? { kind: "api-key", key: envKey.value, source: envKey.source }
    : session && here
      ? { kind: "session", token: session.value, source: session.source }
      : storedKey && here
        ? { kind: "api-key", key: storedKey.value, source: storedKey.source }
        : null;
  const fromArmada = (value: string | undefined, detail: string | undefined): Found =>
    value && detail ? { value, source: { kind: "armada", detail } } : null;
  // A URL from one place and a token from another would open no database: Armada gives both, or neither.
  const tursoPair =
    armada?.turso && !fromEnv(env, "ARMADA_TURSO_URL") && !fromEnv(env, "ARMADA_TURSO_TOKEN") ? armada.turso : null;
  const found: Record<CredentialName, Found> = {
    linearApiKey:
      fromEnv(env, "LINEAR_API_KEY") ??
      fromArmada(armada?.linearApiKey?.value, armada?.linearApiKey?.detail) ??
      fromStore("LINEAR_API_KEY"),
    tursoUrl:
      fromArmada(tursoPair?.url, tursoPair?.detail) ??
      stored("ARMADA_TURSO_URL") ??
      (tursoUrlConfig ? { value: tursoUrlConfig, source: { kind: "config", key: "turso.url" } } : null),
    tursoToken: fromArmada(tursoPair?.token, tursoPair?.detail) ?? stored("ARMADA_TURSO_TOKEN"),
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
    armadaSignInElsewhere: envKey ? null : armadaSignInElsewhere,
  };
}

/** Stored keys with no value from any source, in prompt order. */
export const missingKeys = (credentials: Credentials): StoredKey[] =>
  STORED_KEYS.filter((k) => credentials[k.name] === null);

/** The sentence a command prints when a required key is missing. Names the variable, never a value. */
export function missingKeyMessage(key: StoredKey): string {
  return `${key.variable} is not set. Set it in the environment, run \`armada auth login\` to store it on this machine (${key.hint}), or sign in with \`armada login\` to an Armada that keeps your organization's keys.`;
}
