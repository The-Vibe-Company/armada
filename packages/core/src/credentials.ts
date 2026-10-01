// The one place Armada resolves its keys. Each key comes from the environment
// first, then from Armada (the organization's keys, handed to a signed-in
// terminal), then from the machine store (~/.config/armada/credentials),
// then, for non-secret settings only, from the personal config. GitHub keeps
// its own chain and ends with the GitHub CLI login. The Armada API address and
// the terminal's sign-in to it resolve here too, including the worker session
// of the ticket a worker command acts on. Every command asks this function and
// nothing else.
import type { ArmadaSignIn } from "./armada-api.ts";
import type { PersonalConfig } from "./machine.ts";

export type CredentialName = "linearApiKey" | "githubToken";

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
  /** GitHub token, or null when none is configured. */
  githubToken: string | null;
  /** Where each value came from; null when it is missing. Safe to print. */
  sources: Record<CredentialName, CredentialSource | null>;
  /** The Armada API: ARMADA_API_URL, then `[api] url` in config.toml, then the built-in address. */
  armadaApi: { url: string; source: CredentialSource | { kind: "default" } };
  /**
   * How this terminal signs in to Armada: the worker session stored for the
   * ticket a worker command acts on, then ARMADA_API_KEY from the environment,
   * then what `armada login` stored (a session token or an API key); null when
   * signed out. `source` is safe to print; the secret never is.
   */
  armadaSignIn: (ArmadaSignIn & { source: CredentialSource }) | null;
  /** The tickets this machine holds a worker session for (`armada login --launch-token`). */
  workerTickets: string[];
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
 * Keys earlier versions kept in the credentials file for a fleet database the
 * CLI no longer reaches (it goes through the Armada API): `armada login`,
 * `armada logout` and `armada auth logout` remove them, so no stale secret
 * stays on the machine. Never read.
 */
export const RETIRED_VARIABLES = ["ARMADA_TURSO_URL", "ARMADA_TURSO_TOKEN", "ARMADA_TURSO_LEASE"] as const;

/**
 * Credentials-file key prefix of a worker session (`armada login
 * --launch-token`), one per ticket, so several workers can share a machine.
 * `armada release` and `armada logout` remove it.
 */
export const WORKER_SESSION_PREFIX = "ARMADA_WORKER_SESSION_";
export const workerSessionVariable = (ticket: string) =>
  `${WORKER_SESSION_PREFIX}${ticket.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

/** A worker session kept on the machine: which Armada, which ticket of which project. */
export interface StoredWorker {
  /** The Armada that issued it (`armadaAddress`): it is sent to no other. */
  api: string;
  token: string;
  ticket: string;
  project: string;
  organization: string;
  id: string;
}

/** A record as one credentials-file value (base64url JSON, so it fits a KEY=value line). */
const formatRecord = (record: object) => Buffer.from(JSON.stringify(record), "utf8").toString("base64url");

/** The record of non-empty strings a credentials-file value holds, or null when it is not one. */
function parseRecord<K extends string>(value: string | null | undefined, keys: readonly K[]): Record<K, string> | null {
  if (!value?.trim()) return null;
  try {
    const r = JSON.parse(Buffer.from(value.trim(), "base64url").toString("utf8")) as Record<string, unknown>;
    if (!keys.every((k) => typeof r[k] === "string" && r[k])) return null;
    return Object.fromEntries(keys.map((k) => [k, String(r[k])])) as Record<K, string>;
  } catch {
    return null;
  }
}

export const formatWorkerSession = (worker: StoredWorker) => formatRecord(worker);

export function parseWorkerSession(value: string | null | undefined): StoredWorker | null {
  return parseRecord(value, ["api", "token", "ticket", "project", "organization", "id"]);
}

/** The worker sessions of the credentials file, each under its ticket's key. */
export function storedWorkers(store: Record<string, string>): StoredWorker[] {
  return Object.entries(store).flatMap(([variable, value]) => {
    if (!variable.startsWith(WORKER_SESSION_PREFIX)) return [];
    const w = parseWorkerSession(value);
    return w && workerSessionVariable(w.ticket) === variable ? [w] : [];
  });
}

/** What Armada handed out for this command, with where each came from. */
export interface ArmadaKeys {
  linearApiKey: { value: string; detail: string } | null;
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
export const STORED_KEYS: readonly StoredKey[] = [LINEAR_KEY];

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
  /** The ticket a worker command acts on: its stored worker session, if any, signs the command in. */
  ticket?: string | null;
}

const clean = (v: string | null | undefined) => v?.trim() || null;

type Found = { value: string; source: CredentialSource } | null;

const fromEnv = (env: CredentialSources["env"], variable: string): Found => {
  const value = clean(env[variable]);
  return value ? { value, source: { kind: "env", variable } } : null;
};

/**
 * Linear: LINEAR_API_KEY, then Armada, then the credentials file. GitHub:
 * GITHUB_TOKEN, then GH_TOKEN, then `gh auth token`. The fleet's live data
 * needs no key: it is reached through Armada with the sign-in.
 */
export function resolveCredentials({
  env,
  store = {},
  personal,
  ghToken,
  armada,
  ticket,
}: CredentialSources): Credentials {
  const fromStore = (variable: string): Found => {
    const value = clean(store[variable]);
    return value ? { value, source: { kind: "store" } } : null;
  };
  const fromGh = (): Found => {
    const value = clean(ghToken?.());
    return value ? { value, source: { kind: "gh" } } : null;
  };

  const apiUrlConfig = clean(personal?.api.url);
  const apiUrl = fromEnv(env, API_URL_VARIABLE);
  const workers = storedWorkers(store);
  const worker = ticket ? workers.find((w) => w.ticket === ticket.toUpperCase()) : undefined;
  // A worker launched from another Armada talks to that one: its launch message named it once, at sign-in.
  const armadaApi: Credentials["armadaApi"] = apiUrl
    ? { url: apiUrl.value, source: apiUrl.source }
    : apiUrlConfig
      ? { url: apiUrlConfig, source: { kind: "config", key: "api.url" } }
      : worker
        ? { url: worker.api, source: { kind: "store" } }
        : { url: DEFAULT_ARMADA_API_URL, source: { kind: "default" } };
  // The worker session of the command's ticket comes first: it is what the launch set up.
  const workerHere = worker && armadaAddress(worker.api) === armadaAddress(armadaApi.url) ? worker : null;
  // The environment's key wins: a headless coordinator is configured by its environment.
  const envKey = fromEnv(env, API_KEY_VARIABLE);
  // A stored sign-in is only sent to the Armada that issued it.
  const signedInTo = armadaAddress(clean(store[SIGNED_IN_TO_VARIABLE]) ?? DEFAULT_ARMADA_API_URL);
  const here = signedInTo === armadaAddress(armadaApi.url);
  const session = fromStore(SESSION_TOKEN_VARIABLE);
  const storedKey = fromStore(API_KEY_VARIABLE);
  const armadaSignInElsewhere = !here && (session || storedKey) ? signedInTo : null;
  const armadaSignIn: Credentials["armadaSignIn"] = workerHere
    ? {
        kind: "worker",
        token: workerHere.token,
        ticket: workerHere.ticket,
        project: workerHere.project,
        source: { kind: "store" },
      }
    : envKey
      ? { kind: "api-key", key: envKey.value, source: envKey.source }
      : session && here
        ? { kind: "session", token: session.value, source: session.source }
        : storedKey && here
          ? { kind: "api-key", key: storedKey.value, source: storedKey.source }
          : null;
  const fromArmada = (value: string | undefined, detail: string | undefined): Found =>
    value && detail ? { value, source: { kind: "armada", detail } } : null;
  const found: Record<CredentialName, Found> = {
    linearApiKey:
      fromEnv(env, "LINEAR_API_KEY") ??
      fromArmada(armada?.linearApiKey?.value, armada?.linearApiKey?.detail) ??
      fromStore("LINEAR_API_KEY"),
    githubToken: fromEnv(env, "GITHUB_TOKEN") ?? fromEnv(env, "GH_TOKEN") ?? fromGh(),
  };
  return {
    linearApiKey: found.linearApiKey?.value ?? null,
    githubToken: found.githubToken?.value ?? null,
    sources: {
      linearApiKey: found.linearApiKey?.source ?? null,
      githubToken: found.githubToken?.source ?? null,
    },
    armadaApi,
    armadaSignIn,
    workerTickets: workers.map((w) => w.ticket),
    armadaSignInElsewhere: envKey || workerHere ? null : armadaSignInElsewhere,
  };
}

/** Stored keys with no value from any source, in prompt order. */
export const missingKeys = (credentials: Credentials): StoredKey[] =>
  STORED_KEYS.filter((k) => credentials[k.name] === null);

/** The sentence a command prints when a required key is missing. Names the variable, never a value. */
export function missingKeyMessage(key: StoredKey): string {
  return `${key.variable} is not set. Set it in the environment, run \`armada auth login\` to store it on this machine (${key.hint}), or sign in with \`armada login\` to an Armada that keeps your organization's keys.`;
}
