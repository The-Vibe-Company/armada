// The dashboard's accounts, as pure rules over an injected environment: which
// variables turn accounts on, who may create an account, and how a request is
// signed. Accounts replace the shared-password gate (`auth.ts`, THE-834) only
// once every required variable is set; until then the password gate keeps
// working exactly as before, and with neither the dashboard fails closed.
// `proxy.ts`, the Better Auth instance (`accounts.ts`) and the server checks
// share these rules. No secret leaves the server.

export const AUTH_VARIABLES = {
  databaseUrl: "ARMADA_AUTH_DATABASE_URL",
  databaseToken: "ARMADA_AUTH_DATABASE_TOKEN",
  secret: "ARMADA_AUTH_SECRET",
  url: "ARMADA_AUTH_URL",
  githubId: "ARMADA_AUTH_GITHUB_CLIENT_ID",
  githubSecret: "ARMADA_AUTH_GITHUB_CLIENT_SECRET",
  owners: "ARMADA_AUTH_OWNER_EMAILS",
  emailPassword: "ARMADA_AUTH_EMAIL_PASSWORD",
} as const;

/** Better Auth's own routes (sign-in, OAuth callback, email verification, sign-out). */
export const AUTH_API_PREFIX = "/api/auth";
/** Signed in, but in no organization yet: create one, or accept an invitation. */
export const WELCOME_PATH = "/welcome";
export const INVITATION_PATH = "/invitations";
export const ORGANIZATION_PATH = "/organization";
/** The organization's keys (THE-840): the vault, and a person's own Linear key. */
export const KEYS_PATH = "/organization/keys";
/** Where a person confirms the code `armada login` shows. */
export const DEVICE_PATH = "/device";
/** The routes the Armada CLI calls: sign-in from the terminal, whoami, sign-out. */
export const CLI_API_PREFIX = "/api/cli";
/** Whether a path is one of the CLI's routes, which check their own credential behind either gate. */
export const isCliApi = (pathname: string) => pathname === CLI_API_PREFIX || pathname.startsWith(`${CLI_API_PREFIX}/`);
/** The client id `armada login` sends; device codes for any other are refused. */
export const CLI_CLIENT_ID = "armada-cli";
/** Every organization API key starts with it, so a leaked one is recognisable. */
export const API_KEY_PREFIX = "armada_";
/** Cookie names start with it: `armada.session_token`, and so on. */
export const COOKIE_PREFIX = "armada";
/** A secret shorter than this is refused: it signs every session cookie. */
export const MIN_SECRET_LENGTH = 32;

export type Env = Readonly<Record<string, string | undefined>>;

export interface AuthSettings {
  database: { url: string; token: string | null };
  secret: string;
  /** The public address of the dashboard, e.g. https://armada.example.com: OAuth callbacks and email links. */
  baseUrl: string;
  github: { clientId: string; clientSecret: string } | null;
  /** Lower-cased addresses that may create an account without an invitation, and create organizations. */
  owners: string[];
  /**
   * Email and password sign-in (with address confirmation). Development only for
   * now: with no email provider the confirmation links go to the server log, and
   * whoever reads it could confirm an address someone else registered first.
   */
  emailPassword: boolean;
  production: boolean;
}

/**
 * Whether the deployment runs on accounts. `off`: no accounts variable is set,
 * so the shared-password gate applies (and fails closed without its password).
 * `incomplete`: some are set but not all; the dashboard fails closed and names
 * the missing ones, rather than fall back to a password that shows every
 * organization's projects.
 */
export type AccountsMode =
  | { kind: "accounts"; settings: AuthSettings }
  | { kind: "off" }
  | { kind: "incomplete"; missing: string[] };

// Trimmed: a newline pasted into the deployment's settings must not lock the owner out.
const read = (env: Env, name: string) => env[name]?.trim() || null;

/** "on" or "off", else the default. */
function flag(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  const v = value.toLowerCase();
  if (["on", "true", "1", "yes"].includes(v)) return true;
  if (["off", "false", "0", "no"].includes(v)) return false;
  return fallback;
}

function baseUrlOf(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export const ownersOf = (value: string | null | undefined): string[] =>
  (value ?? "")
    .split(/[\s,]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@"));

export function accountsModeOf(env: Env): AccountsMode {
  const V = AUTH_VARIABLES;
  const production = env.NODE_ENV === "production";
  const url = read(env, V.databaseUrl);
  const token = read(env, V.databaseToken);
  const secret = read(env, V.secret);
  const baseUrl = baseUrlOf(read(env, V.url));
  const githubId = read(env, V.githubId);
  const githubSecret = read(env, V.githubSecret);
  const emailPassword = !production && flag(read(env, V.emailPassword), true);
  const started = [V.databaseUrl, V.databaseToken, V.secret, V.url, V.githubId, V.githubSecret, V.owners].some((v) =>
    read(env, v),
  );
  if (!started) return { kind: "off" };

  const missing: string[] = [];
  if (!url) missing.push(V.databaseUrl);
  // A remote database needs its token; a local file (development, tests) does not.
  else if (!url.startsWith("file:") && !token) missing.push(V.databaseToken);
  if (!secret || secret.length < MIN_SECRET_LENGTH) missing.push(V.secret);
  if (!baseUrl) missing.push(V.url);
  if (Boolean(githubId) !== Boolean(githubSecret)) missing.push(githubId ? V.githubSecret : V.githubId);
  // No way to sign in at all is the same as no accounts.
  if (!githubId && !emailPassword) missing.push(V.githubId);
  if (missing.length || !url || !secret || !baseUrl) return { kind: "incomplete", missing };

  return {
    kind: "accounts",
    settings: {
      database: { url, token },
      secret,
      baseUrl,
      github: githubId && githubSecret ? { clientId: githubId, clientSecret: githubSecret } : null,
      owners: ownersOf(read(env, V.owners)),
      emailPassword,
      production,
    },
  };
}

/**
 * The name a request is signed with on the ticket: the person's name and
 * address, or the address alone when both do not fit core's limit.
 */
export function signatureOf(user: { name: string | null; email: string }, limit = 80): string {
  const name = (user.name ?? "").replace(/[\s<>]+/g, " ").trim();
  const full = name && name.toLowerCase() !== user.email.toLowerCase() ? `${name} <${user.email}>` : user.email;
  return full.length <= limit ? full : user.email.slice(0, limit);
}
