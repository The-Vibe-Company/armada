// The Armada GitHub App (THE-851): every GitHub read of the dashboard goes
// through it, so nobody sets a GitHub token by hand. The app is installed on a
// GitHub account with read-only rights (Contents, Metadata, Pull requests,
// Actions, Commit statuses, Checks); the dashboard signs a short JSON Web Token
// with the app's private key, finds the installation that covers a
// repository, and mints that installation's token, kept until a few minutes
// before it expires. An installation token holds Checks: read, which the
// fine-grained tokens lack, so the CI of private repositories shows.
//
// Which installations an organization reads through: the deployment's first
// organization, and every project under the shared-password gate, any of the
// app's (whoever runs the deployment holds the app's private key anyway, as
// with the environment's keys); any other organization only the installations
// an owner or admin linked to it, after GitHub showed the installation to
// them (`linkInstallation`). Otherwise an organization could register another
// one's repository and read it through the app.
//
// Linking in one click (THE-852): the Install button carries a signed,
// short-lived state naming the organization and the person; GitHub sends them
// back to the Setup URL (Organization > GitHub) with the new installation, and
// `linkFromSetup` links it under the same rule as the Link button.
//
// The same app signs people in (Better Auth's GitHub provider, fed with the
// app's client id and secret: `accounts-settings.ts`). Everything is
// injected: fetch, the clock, the database.
import { createHmac, createPrivateKey, createSign, type KeyObject, timingSafeEqual } from "node:crypto";
import { GITHUB_PATH } from "./accounts-settings";
import { type Database, type Queryable, transaction } from "./db";
import type { GithubError, GithubNotice } from "./i18n";
import { type Actor, recordEvent } from "./vault";

export const GITHUB_APP_VARIABLES = {
  id: "ARMADA_GITHUB_APP_ID",
  privateKey: "ARMADA_GITHUB_APP_PRIVATE_KEY",
} as const;

export const GITHUB_API = "https://api.github.com";
const TIMEOUT_MS = 10_000;
/** An installation token with less than this left is minted again. GitHub's last an hour. */
export const RENEW_BEFORE_MS = 5 * 60 * 1000;
/** How long the installation covering a repository is remembered: found, and not found. */
export const INSTALLATION_TTL_MS = 10 * 60 * 1000;
export const MISSING_TTL_MS = 60 * 1000;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type Env = Readonly<Record<string, string | undefined>>;

export interface GithubAppSettings {
  appId: string;
  privateKey: KeyObject;
}

/**
 * Whether the deployment reads GitHub through its app. `off`: neither
 * variable is set, and the dashboard reads with a stored GitHub token, as
 * before. `invalid`: one is missing or the key does not parse; the reason
 * names the variable, never its value.
 */
export type GithubAppMode =
  | { kind: "on"; settings: GithubAppSettings }
  | { kind: "off" }
  | { kind: "invalid"; reason: string };

export function githubAppModeOf(env: Env): GithubAppMode {
  const V = GITHUB_APP_VARIABLES;
  const appId = env[V.id]?.trim() ?? "";
  // A key pasted on one line keeps its line breaks as \n.
  const pem = (env[V.privateKey] ?? "").replace(/\\n/g, "\n").trim();
  if (!appId && !pem) return { kind: "off" };
  if (!/^\d+$/.test(appId)) return { kind: "invalid", reason: `${V.id} must be the app's numeric id` };
  if (!pem) return { kind: "invalid", reason: `${V.privateKey} is not set` };
  try {
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== "rsa") throw new Error("not RSA");
    return { kind: "on", settings: { appId, privateKey } };
  } catch {
    return {
      kind: "invalid",
      reason: `${V.privateKey} is not the app's private key (the .pem file GitHub gives, BEGIN RSA PRIVATE KEY)`,
    };
  }
}

const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** The app's JSON Web Token (RS256): valid ten minutes, issued a minute early for clock drift. */
export function appJwt(settings: GithubAppSettings, now: Date): string {
  const at = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: at - 60, exp: at + 9 * 60, iss: settings.appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(settings.privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

/** A GitHub refusal or an unreachable GitHub. Its message names the call, never a token. */
export class GithubAppError extends Error {
  override name = "GithubAppError";
}

async function call(
  fetch: Fetch,
  method: "GET" | "POST",
  path: string,
  bearer: string,
  what: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${bearer}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err: unknown) => {
    throw new GithubAppError(`GitHub is unreachable ${what} (${err instanceof Error ? err.name : "network error"})`);
  });
  const body = (await res.json().catch(() => null)) as unknown;
  return { status: res.status, body };
}

/** An installation of the app on a GitHub account (an organization or a person). */
export interface Installation {
  id: number;
  /** The account's login, e.g. acme. */
  account: string;
}

function installationOf(body: unknown): Installation | null {
  const b = body as { id?: unknown; account?: { login?: unknown } | null } | null;
  if (typeof b?.id !== "number") return null;
  return { id: b.id, account: typeof b.account?.login === "string" ? b.account.login : String(b.id) };
}

export interface AppInfo {
  name: string;
  /** https://github.com/apps/<slug>: its page, and where it is installed from. */
  url: string;
}

export interface GithubApp {
  /** The app's name and page. */
  info(): Promise<AppInfo>;
  /** The installation covering `owner/name`, or null when the app is not installed there. */
  installationFor(repository: string): Promise<Installation | null>;
  /** A token of the installation, minted server-side and kept until it nears expiry. */
  tokenFor(installation: number): Promise<string>;
}

export interface GithubAppDeps {
  settings: GithubAppSettings;
  fetch?: Fetch;
  now?: () => Date;
}

/** The app's client, with its caches. Keep one per server process: tokens and installations are shared. */
export function createGithubApp({
  settings,
  fetch = globalThis.fetch,
  now = () => new Date(),
}: GithubAppDeps): GithubApp {
  const tokens = new Map<number, { token: string; expiresAt: number }>();
  const minting = new Map<number, Promise<string>>();
  const repositories = new Map<string, { installation: Installation | null; until: number }>();
  let info: AppInfo | null = null;
  const jwt = () => appJwt(settings, now());

  async function mint(installation: number): Promise<string> {
    const what = `minting a token for installation ${installation}`;
    const { status, body } = await call(fetch, "POST", `/app/installations/${installation}/access_tokens`, jwt(), what);
    const b = body as { token?: unknown; expires_at?: unknown } | null;
    if (status !== 201 || typeof b?.token !== "string" || typeof b.expires_at !== "string")
      throw new GithubAppError(`GitHub answered HTTP ${status} ${what}`);
    tokens.set(installation, { token: b.token, expiresAt: Date.parse(b.expires_at) });
    return b.token;
  }

  return {
    async info() {
      if (info) return info;
      const { status, body } = await call(fetch, "GET", "/app", jwt(), "reading the app");
      const b = body as { name?: unknown; html_url?: unknown } | null;
      if (status !== 200 || typeof b?.html_url !== "string")
        throw new GithubAppError(`GitHub answered HTTP ${status} reading the app`);
      info = { name: typeof b.name === "string" ? b.name : "Armada", url: b.html_url };
      return info;
    },

    async installationFor(repository) {
      const key = repository.toLowerCase();
      const known = repositories.get(key);
      if (known && known.until > now().getTime()) return known.installation;
      const [owner, name] = repository.split("/");
      if (!owner || !name) return null;
      const what = `finding the app's installation on ${repository}`;
      const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`;
      const { status, body } = await call(fetch, "GET", path, jwt(), what);
      if (status !== 200 && status !== 404) throw new GithubAppError(`GitHub answered HTTP ${status} ${what}`);
      const installation = status === 200 ? installationOf(body) : null;
      repositories.set(key, {
        installation,
        until: now().getTime() + (installation ? INSTALLATION_TTL_MS : MISSING_TTL_MS),
      });
      return installation;
    },

    async tokenFor(installation) {
      const kept = tokens.get(installation);
      if (kept && kept.expiresAt - now().getTime() > RENEW_BEFORE_MS) return kept.token;
      // One mint at a time per installation: the Fleet view reads every project at once.
      let pending = minting.get(installation);
      if (!pending) {
        pending = mint(installation).finally(() => minting.delete(installation));
        minting.set(installation, pending);
      }
      return pending;
    },
  };
}

/**
 * The app's installations a person can reach on GitHub, with the token they
 * signed in with (a user token of this app: GitHub only lists this app's
 * installations, and only those the person has access to).
 */
export async function userInstallations(fetch: Fetch, userToken: string): Promise<Installation[]> {
  const what = "listing your installations of the app";
  const { status, body } = await call(fetch, "GET", "/user/installations?per_page=100", userToken, what);
  if (status !== 200) throw new GithubAppError(`GitHub answered HTTP ${status} ${what}`);
  const list = (body as { installations?: unknown[] } | null)?.installations ?? [];
  return list.flatMap((i) => {
    const one = installationOf(i);
    return one ? [one] : [];
  });
}

// ------------------------------------------------------------ who reads through what

/** The installations an organization reads through: any of the app's, or only those linked to it. */
export type InstallationAccess = { kind: "any" } | { kind: "linked"; installations: ReadonlySet<number> };

/** A GitHub token for one repository, or why there is none (shown on the Fleet view). */
export type RepositoryToken = { token: string; reason?: undefined } | { token: null; reason: string };

/**
 * The token a repository is read with: its installation's, when the
 * organization may read through it; else the stored GitHub token (the vault's
 * or the environment's), for deployments without the app.
 */
export async function repositoryToken(
  app: GithubApp | null,
  access: InstallationAccess,
  stored: string | null,
  repository: string,
): Promise<RepositoryToken> {
  let reason: string;
  if (!app) reason = `no GitHub App is configured (${GITHUB_APP_VARIABLES.id}) and no GitHub token is set`;
  else
    try {
      const installation = await app.installationFor(repository);
      if (!installation) reason = `the Armada GitHub App is not installed on ${repository}`;
      else if (access.kind === "linked" && !access.installations.has(installation.id))
        reason = `the Armada GitHub App's installation on ${installation.account} is not linked to this organization (Organization > GitHub)`;
      else return { token: await app.tokenFor(installation.id) };
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
  return stored ? { token: stored } : { token: null, reason };
}

// ------------------------------------------------------------ linked installations

export interface LinkedInstallation extends Installation {
  linkedBy: string;
  linkedAt: string;
}

export async function linkedInstallations(client: Queryable, organization: string): Promise<LinkedInstallation[]> {
  const rs = await client.query(
    `SELECT "installationId", "account", "linkedByLabel", "linkedAt" FROM "armada_github_installation"
     WHERE "organizationId" = $1 ORDER BY "account", "installationId"`,
    [organization],
  );
  return rs.rows.map((r) => ({
    id: Number(r.installationId),
    account: String(r.account),
    linkedBy: String(r.linkedByLabel),
    linkedAt: new Date(r.linkedAt as string | Date).toISOString(),
  }));
}

/** `already`: the organization had it linked; only the account's name is refreshed. */
export type LinkOutcome = "linked" | "already" | "unreachable";

/**
 * Links an installation to an organization, only when GitHub lists it among
 * the installations the person can reach (`reachable`, from `userInstallations`).
 */
export async function linkInstallation(
  client: Queryable,
  link: {
    organization: string;
    installation: number;
    reachable: Installation[];
    by: { id: string; label: string };
    now: Date;
  },
): Promise<LinkOutcome> {
  const found = link.reachable.find((i) => i.id === link.installation);
  if (!found) return "unreachable";
  const rs = await client.query(
    `INSERT INTO "armada_github_installation" ("organizationId", "installationId", "account", "linkedById", "linkedByLabel", "linkedAt")
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT ("organizationId", "installationId") DO NOTHING RETURNING 1`,
    [link.organization, found.id, found.account, link.by.id, link.by.label, link.now],
  );
  if (rs.rows.length > 0) return "linked";
  await client.query(
    `UPDATE "armada_github_installation" SET "account" = $3 WHERE "organizationId" = $1 AND "installationId" = $2`,
    [link.organization, found.id, found.account],
  );
  return "already";
}

/** `linkInstallation` and, for a new link, its line in the audit list, in one transaction. */
export async function linkAndRecord(
  db: Database,
  link: { organization: string; installation: number; reachable: Installation[]; by: Actor; now: Date },
): Promise<LinkOutcome> {
  return transaction(db, async (tx) => {
    const outcome = await linkInstallation(tx, link);
    if (outcome !== "linked") return outcome;
    const account = link.reachable.find((i) => i.id === link.installation)?.account ?? String(link.installation);
    await recordEvent(tx, link.organization, {
      at: link.now.toISOString(),
      action: "link",
      keys: ["github-app"],
      actor: link.by,
      detail: `installation ${link.installation} on ${account}`,
    });
    return outcome;
  });
}

export async function unlinkInstallation(
  client: Queryable,
  organization: string,
  installation: number,
): Promise<boolean> {
  const rs = await client.query(
    `DELETE FROM "armada_github_installation" WHERE "organizationId" = $1 AND "installationId" = $2 RETURNING 1`,
    [organization, installation],
  );
  return rs.rows.length > 0;
}

// ------------------------------------------------------------ one-click install (THE-852)

/** How long the Install button's state is accepted back: picking the account and repositories on GitHub. */
export const INSTALL_STATE_TTL_MS = 15 * 60 * 1000;

/** Who clicked Install, for which organization. */
export interface InstallState {
  organization: string;
  user: string;
}

// A key of its own, derived from the accounts secret, so the state's signature never doubles as a session's.
const stateSignature = (secret: string, payload: string) =>
  createHmac("sha256", createHmac("sha256", secret).update("armada:github-app-install-state").digest())
    .update(payload)
    .digest("base64url");

/** The state the Install button carries: who and for which organization, until when, signed. Not a secret. */
export function installState(secret: string, who: InstallState, now: Date): string {
  const payload = base64url(
    JSON.stringify({ o: who.organization, u: who.user, exp: now.getTime() + INSTALL_STATE_TTL_MS }),
  );
  return `${payload}.${stateSignature(secret, payload)}`;
}

/** The state GitHub sent back, or null when it is forged, altered or expired. */
export function readInstallState(secret: string, state: string, now: Date): InstallState | null {
  const [payload, signature, ...rest] = state.split(".");
  if (!payload || !signature || rest.length > 0) return null;
  const expected = Buffer.from(stateSignature(secret, payload));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString()) as { o?: unknown; u?: unknown; exp?: unknown };
    if (typeof p.o !== "string" || typeof p.u !== "string" || typeof p.exp !== "number") return null;
    return p.exp > now.getTime() ? { organization: p.o, user: p.u } : null;
  } catch {
    return null;
  }
}

/** GitHub's page that installs the app (`appUrl`: https://github.com/apps/<slug>), carrying the state back. */
export const installUrl = (appUrl: string, state: string) =>
  `${appUrl}/installations/new?state=${encodeURIComponent(state)}`;

/** What a link or unlink did, as the GitHub page's query shows it. */
export type GithubResult = { done: GithubNotice } | { error: GithubError };

export const githubPage = (result: GithubResult) =>
  "done" in result ? `${GITHUB_PATH}?done=${result.done}` : `${GITHUB_PATH}?error=${result.error}`;

/**
 * GitHub sent the person back to the Setup URL with a new (or changed)
 * installation and the Install button's state. The installation is linked to
 * the state's organization only when the state is genuine and unexpired, was
 * made for this person in the organization they are in now, they still own or
 * administer it, and GitHub lists the installation among those they can reach
 * (asked with their own GitHub sign-in): the Link button's rule, without the
 * click. Linking again keeps the link.
 */
export async function linkFromSetup(
  db: Database,
  setup: {
    secret: string;
    state: string;
    installation: number;
    viewer: { user: string; label: string; organization: string; role: string };
    githubToken: () => Promise<string | null>;
    fetch: Fetch;
    now: Date;
  },
): Promise<GithubResult> {
  const { viewer } = setup;
  const state = readInstallState(setup.secret, setup.state, setup.now);
  if (!state) return { error: "state" };
  if (state.user !== viewer.user || state.organization !== viewer.organization) return { error: "state" };
  if (viewer.role !== "owner" && viewer.role !== "admin") return { error: "forbidden" };
  if (!Number.isSafeInteger(setup.installation) || setup.installation <= 0) return { error: "unreachable" };
  const token = await setup.githubToken();
  if (!token) return { error: "no-github" };
  const outcome = await linkAndRecord(db, {
    organization: viewer.organization,
    installation: setup.installation,
    reachable: await userInstallations(setup.fetch, token),
    by: { kind: "person", id: viewer.user, label: viewer.label },
    now: setup.now,
  });
  return outcome === "unreachable" ? { error: "unreachable" } : { done: "linked" };
}
