// The dashboard's accounts, as pure rules over an injected environment: which
// variables turn accounts on, who may create an account, and how a request is
// signed. Accounts replace the shared-password gate (`auth.ts`, THE-834) only
// once every required variable is set; until then the password gate keeps
// working exactly as before, and with neither the dashboard fails closed.
// `proxy.ts`, the Better Auth instance (`accounts.ts`) and the server checks
// share these rules. No secret leaves the server. Accounts live in the app's
// one database (`db.ts`, ARMADA_DATABASE_URL), with the fleet's data.
import { DATABASE_VARIABLE, databaseUrlOf } from "./db";

export const AUTH_VARIABLES = {
  database: DATABASE_VARIABLE,
  secret: "ARMADA_AUTH_SECRET",
  url: "ARMADA_AUTH_URL",
  githubId: "ARMADA_AUTH_GITHUB_CLIENT_ID",
  githubSecret: "ARMADA_AUTH_GITHUB_CLIENT_SECRET",
  owners: "ARMADA_AUTH_OWNER_EMAILS",
  emailPassword: "ARMADA_AUTH_EMAIL_PASSWORD",
} as const;

/**
 * The accounts database of THE-838 to THE-842 (libSQL), replaced by the app's
 * database. Still set, they count as accounts being set up: a deployment that
 * has not moved yet fails closed and names ARMADA_DATABASE_URL.
 */
const RETIRED_VARIABLES = ["ARMADA_AUTH_DATABASE_URL", "ARMADA_AUTH_DATABASE_TOKEN"];

/** Better Auth's own routes (sign-in, OAuth callback, email verification, sign-out). */
export const AUTH_API_PREFIX = "/api/auth";
/** Signed in, but in no organization yet: create one, or accept an invitation. */
export const WELCOME_PATH = "/welcome";
export const INVITATION_PATH = "/invitations";
export const ORGANIZATION_PATH = "/organization";
/** The organization's keys (THE-840): the vault, and a person's own Linear key. */
export const KEYS_PATH = "/organization/keys";
/** The workers launched with a launch token (THE-841): who launched them, their sessions, Revoke. */
export const WORKERS_PATH = "/organization/workers";
/** The Armada GitHub App (THE-851): the installations this organization reads GitHub through. */
export const GITHUB_PATH = "/organization/github";
/** Where the Install on GitHub button leads (THE-852): it signs the state, then sends the person to GitHub. */
export const GITHUB_INSTALL_PATH = "/organization/github/install";
/** Where GitHub's return to the Setup URL (GITHUB_PATH) is handled: the installation is linked, then the GitHub page shows. */
export const GITHUB_SETUP_PATH = "/organization/github/setup";
/**
 * The public landing (THE-887): static, it reads no fleet data. The proxy shows
 * it on `/` to a viewer without a session, and lets it and its assets through.
 */
export const LANDING_PATH = "/landing";
type PageRequest = { method: string; nextUrl: { pathname: string; searchParams: URLSearchParams } };
const isRead = (request: PageRequest) => ["GET", "HEAD"].includes(request.method);
/** A read of the landing or one of its files: anything else under it goes through the gate. */
export const isLanding = (request: PageRequest) =>
  isRead(request) &&
  (request.nextUrl.pathname === LANDING_PATH || request.nextUrl.pathname.startsWith(`${LANDING_PATH}/`));
/** Query parameters a shared link carries (`?utm_source=`, `?ref=`): they do not turn `/` into an app page. */
const SHARED_LINK = /^(utm_[a-z]+|ref|source|fbclid|gclid)$/;
/**
 * A read of `/`, where a viewer without a session is shown the landing: bare,
 * or with a shared link's parameters only. `/?project=…` is the app's.
 */
export const isFront = (request: PageRequest) =>
  isRead(request) &&
  request.nextUrl.pathname === "/" &&
  [...request.nextUrl.searchParams.keys()].every((k) => SHARED_LINK.test(k));
/** Where a person confirms the code `armada login` shows. */
export const DEVICE_PATH = "/device";
/** The routes the Armada CLI calls: sign-in from the terminal, whoami, sign-out. */
export const CLI_API_PREFIX = "/api/cli";
/** Whether a path is one of the CLI's routes, which check their own credential behind either gate. */
export const isCliApi = (pathname: string) => pathname === CLI_API_PREFIX || pathname.startsWith(`${CLI_API_PREFIX}/`);
/** Linear's and the GitHub App's webhooks (THE-853): they carry a signature, never a cookie, and check it themselves. */
export const WEBHOOKS_PREFIX = "/api/webhooks";
export const isWebhook = (pathname: string) => pathname.startsWith(`${WEBHOOKS_PREFIX}/`);
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
  /** The app's database URL (`db.ts`); `pglite:` outside production. */
  database: string;
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
  const database = databaseUrlOf(env);
  const secret = read(env, V.secret);
  const baseUrl = baseUrlOf(read(env, V.url));
  const githubId = read(env, V.githubId);
  const githubSecret = read(env, V.githubSecret);
  const emailPassword = !production && flag(read(env, V.emailPassword), true);
  // The database alone does not start accounts: the shared-password gate reads the fleet from it too.
  const started = [V.secret, V.url, V.githubId, V.githubSecret, V.owners, ...RETIRED_VARIABLES].some((v) =>
    read(env, v),
  );
  if (!started) return { kind: "off" };

  const missing: string[] = [];
  if (!database) missing.push(V.database);
  if (!secret || secret.length < MIN_SECRET_LENGTH) missing.push(V.secret);
  if (!baseUrl) missing.push(V.url);
  if (Boolean(githubId) !== Boolean(githubSecret)) missing.push(githubId ? V.githubSecret : V.githubId);
  // No way to sign in at all is the same as no accounts.
  if (!githubId && !emailPassword) missing.push(V.githubId);
  if (missing.length || !database || !secret || !baseUrl) return { kind: "incomplete", missing };

  return {
    kind: "accounts",
    settings: {
      database,
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
