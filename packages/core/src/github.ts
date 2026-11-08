import { decryptSecret, EncryptionKeyError, encryptSecret } from "./crypto.ts";

/**
 * GitHub user-to-server access for a launch. The person authorizes the Armada GitHub App once (the
 * dashboard's "Connect GitHub"); Armada keeps the expiring refresh token as ciphertext. At launch the
 * refresh token is exchanged for a fresh user access token (8 hours), which goes into the sandbox as
 * `GH_TOKEN` and `GITHUB_TOKEN`, so `git` and `gh` there act as that person. No personal access tokens.
 */

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_INSTALLATIONS_URL = "https://api.github.com/user/installations";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const INSTALLATIONS_PER_PAGE = 100;
const MAX_INSTALLATION_PAGES = 10;

export const GITHUB_CLIENT_ID_ENV = "GITHUB_APP_CLIENT_ID";
export const GITHUB_CLIENT_SECRET_ENV = "GITHUB_APP_CLIENT_SECRET";

export interface GitHubApp {
  clientId: string;
  clientSecret: string;
}

/** The App's OAuth credentials from the environment, or null when either is missing. */
export function githubAppFromEnv(env: Record<string, string | undefined>): GitHubApp | null {
  const clientId = env[GITHUB_CLIENT_ID_ENV]?.trim();
  const clientSecret = env[GITHUB_CLIENT_SECRET_ENV]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export type GitHubAuthErrorCode =
  /** The authorization code is wrong, used or expired. */
  | "bad_code"
  /** GitHub refused the refresh token: the grant was revoked or expired. The person reconnects. */
  | "revoked"
  /** The App is set up wrong: bad client credentials, a callback URL that does not match, or non-expiring tokens. */
  | "misconfigured"
  /** GitHub could not be reached or answered something unexpected. */
  | "unavailable";

export class GitHubAuthError extends Error {
  override readonly name = "GitHubAuthError";
  readonly code: GitHubAuthErrorCode;

  constructor(code: GitHubAuthErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
  }
}

export interface GitHubTokenSet {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date | null;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
}

/** What git needs to attribute a commit to the person. The email is GitHub's noreply address, so it links to the account and exposes nothing. */
export interface GitIdentity {
  login: string;
  id: number;
  name: string;
  email: string;
}

export function gitIdentity(user: GitHubUser): GitIdentity {
  return {
    login: user.login,
    id: user.id,
    name: user.name?.replaceAll(/\p{Cc}/gu, " ").trim() || user.login,
    email: `${user.id}+${user.login}@users.noreply.github.com`,
  };
}

interface TokenRequestOptions {
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Trades the one-time code of the authorization callback for the person's tokens. */
export async function exchangeGitHubCode(
  app: GitHubApp,
  input: { code: string; redirectUri: string },
  options: TokenRequestOptions = {},
): Promise<GitHubTokenSet> {
  return requestTokens(
    app,
    { code: input.code, redirect_uri: input.redirectUri },
    { bad_verification_code: "bad_code" },
    options,
  );
}

/** Trades a refresh token for a fresh access token. GitHub rotates the refresh token: the old one stops working. */
export async function refreshGitHubToken(
  app: GitHubApp,
  refreshToken: string,
  options: TokenRequestOptions = {},
): Promise<GitHubTokenSet> {
  return requestTokens(
    app,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    { bad_refresh_token: "revoked" },
    options,
  );
}

async function requestTokens(
  app: GitHubApp,
  params: Record<string, string>,
  errors: Record<string, GitHubAuthErrorCode>,
  options: TokenRequestOptions,
): Promise<GitHubTokenSet> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "armada" },
      body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, ...params }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new GitHubAuthError("unavailable", "GitHub could not be reached.", { cause: error });
  }
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body)) {
    throw new GitHubAuthError("unavailable", `GitHub answered ${response.status} without a token.`);
  }
  if (typeof body.error === "string") {
    const code = errors[body.error];
    if (code) throw new GitHubAuthError(code, `GitHub refused the authorization (${body.error}).`);
    if (body.error === "incorrect_client_credentials" || body.error === "redirect_uri_mismatch") {
      throw new GitHubAuthError("misconfigured", `The GitHub App is set up wrong (${body.error}).`);
    }
    throw new GitHubAuthError("unavailable", `GitHub refused the request (${body.error}).`);
  }
  const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } = body;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new GitHubAuthError("unavailable", "GitHub answered without an access token.");
  }
  if (typeof refreshToken !== "string" || refreshToken === "" || typeof expiresIn !== "number") {
    throw new GitHubAuthError(
      "misconfigured",
      "GitHub issued a token that does not expire. Turn on 'Expire user authorization tokens' in the GitHub App settings.",
    );
  }
  const now = (options.now ?? (() => new Date()))();
  const refreshIn = body.refresh_token_expires_in;
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: new Date(now.getTime() + expiresIn * 1000),
    refreshExpiresAt: typeof refreshIn === "number" ? new Date(now.getTime() + refreshIn * 1000) : null,
  };
}

/** Who a user access token belongs to. */
export async function fetchGitHubUser(
  accessToken: string,
  options: { fetch?: typeof fetch } = {},
): Promise<GitHubUser> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(GITHUB_USER_URL, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "armada",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new GitHubAuthError("unavailable", "GitHub could not be reached.", { cause: error });
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(body)) {
    throw new GitHubAuthError("unavailable", `GitHub did not say who the token belongs to (${response.status}).`);
  }
  const { id, login, name } = body;
  if (typeof id !== "number" || typeof login !== "string" || login === "") {
    throw new GitHubAuthError("unavailable", "GitHub answered with an account Armada cannot read.");
  }
  return { id, login, name: typeof name === "string" && name.trim() !== "" ? name : null };
}

/** One GitHub App installation a person can reach, as GitHub reports it: never trusted from a query string. */
export interface GitHubInstallation {
  id: number;
  appSlug: string | null;
  account: { login: string; type: string } | null;
}

/**
 * Every App installation the token's owner can reach, across every account. The only reliable way
 * to tell whether the Armada GitHub App is installed anywhere for this person, and the only way to
 * corroborate an installation_id a callback claims: GitHub is the source of truth, never the query string.
 */
export async function fetchGitHubInstallations(
  accessToken: string,
  options: { fetch?: typeof fetch } = {},
): Promise<GitHubInstallation[]> {
  const installations: GitHubInstallation[] = [];
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(
        `${GITHUB_INSTALLATIONS_URL}?per_page=${INSTALLATIONS_PER_PAGE}&page=${page}`,
        {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${accessToken}`,
            "user-agent": "armada",
            "x-github-api-version": "2022-11-28",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch (error) {
      throw new GitHubAuthError("unavailable", "GitHub could not be reached.", { cause: error });
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(body) || !Array.isArray(body.installations)) {
      throw new GitHubAuthError("unavailable", `GitHub did not list installations (${response.status}).`);
    }
    for (const item of body.installations) {
      if (!isRecord(item) || typeof item.id !== "number") continue;
      const account =
        isRecord(item.account) && typeof item.account.login === "string"
          ? { login: item.account.login, type: typeof item.account.type === "string" ? item.account.type : "User" }
          : null;
      installations.push({ id: item.id, appSlug: typeof item.app_slug === "string" ? item.app_slug : null, account });
    }
    if (body.installations.length < INSTALLATIONS_PER_PAGE) break;
  }
  return installations;
}

/** The stored connection of one person, with the refresh token still sealed. */
export interface StoredGitHubConnection {
  userId: string;
  githubId: number;
  login: string;
  name: string | null;
  refreshTokenEnc: Uint8Array;
  refreshExpiresAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Connections as the server reads and rotates them: service role, because only it reads the
 * ciphertext. The dashboard writes the first token as the person, under row level security.
 */
export interface GitHubConnectionStore {
  getGitHubConnection(userId: string): Promise<StoredGitHubConnection | null>;
  /**
   * Replaces the refresh token only while it still is `expected`, so two launches that refresh at once
   * cannot overwrite each other's rotated token. False when it changed, or the connection is gone.
   */
  rotateGitHubToken(
    userId: string,
    expected: Uint8Array,
    next: { refreshTokenEnc: Uint8Array; refreshExpiresAt: Date | null },
  ): Promise<boolean>;
  /** Marks the connection revoked, only while the refresh token still is `expected`. */
  markGitHubRevoked(userId: string, expected: Uint8Array): Promise<boolean>;
  updateGitHubProfile(userId: string, profile: GitHubUser): Promise<void>;
}

export type GitHubStatus = "connected" | "not_connected" | "revoked" | "unavailable";

/** The answer of {@link resolveGitHubAccess}: a token for the sandbox, or why there is none. Launch never fails for lack of GitHub. */
export type GitHubAccess =
  | { status: "connected"; token: string; identity: GitIdentity }
  | { status: Exclude<GitHubStatus, "connected">; message: string };

export const GITHUB_NOT_CONNECTED =
  "GitHub is not connected for you, so git push and gh in this sandbox are not signed in as you. Connect it in the dashboard under Settings.";
export const GITHUB_REVOKED =
  "Your GitHub connection was revoked or has expired, so git push and gh in this sandbox are not signed in as you. Reconnect GitHub in the dashboard under Settings.";

export interface GitHubResolveDeps {
  store: GitHubConnectionStore;
  encryptionKey: string | undefined;
  /** Null when the server has no GitHub App configured. */
  app: GitHubApp | null;
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * Turns the person's stored refresh token into a fresh user access token for one launch.
 *
 * The user's connection is the only source: no connection is `not_connected`, a refused refresh token
 * marks the connection revoked, and a GitHub outage is `unavailable`. Rotation is safe: the new refresh
 * token is stored before anything else uses the access token, and a compare-and-swap keeps a second
 * launch that refreshes at the same moment from clobbering it (it retries with whatever the first stored).
 * Throws only for a missing or malformed encryption key and for a database failure.
 */
export async function resolveGitHubAccess(deps: GitHubResolveDeps, userId: string): Promise<GitHubAccess> {
  const request = { ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.now ? { now: deps.now } : {}) };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const connection = await deps.store.getGitHubConnection(userId);
    if (!connection) return { status: "not_connected", message: GITHUB_NOT_CONNECTED };
    if (connection.revokedAt) return { status: "revoked", message: GITHUB_REVOKED };
    if (!deps.app) {
      return {
        status: "unavailable",
        message: `The server has no GitHub App configured (${GITHUB_CLIENT_ID_ENV} and ${GITHUB_CLIENT_SECRET_ENV}), so GitHub was not set up in this sandbox.`,
      };
    }

    let refreshToken: string;
    try {
      refreshToken = await decryptSecret(new Uint8Array(connection.refreshTokenEnc), deps.encryptionKey);
    } catch (error) {
      if (error instanceof EncryptionKeyError) throw error;
      return {
        status: "unavailable",
        message:
          "The stored GitHub connection could not be decrypted. Reconnect GitHub in the dashboard under Settings.",
      };
    }

    let tokens: GitHubTokenSet;
    try {
      tokens = await refreshGitHubToken(deps.app, refreshToken, request);
    } catch (error) {
      if (!(error instanceof GitHubAuthError)) throw error;
      if (error.code !== "revoked")
        return { status: "unavailable", message: `${error.message} GitHub was not set up in this sandbox.` };
      const current = await deps.store.getGitHubConnection(userId);
      if (current && !current.revokedAt && !sameBytes(current.refreshTokenEnc, connection.refreshTokenEnc)) continue;
      await deps.store.markGitHubRevoked(userId, connection.refreshTokenEnc);
      return { status: "revoked", message: GITHUB_REVOKED };
    }

    const sealed = await encryptSecret(tokens.refreshToken, deps.encryptionKey);
    const next = { refreshTokenEnc: sealed, refreshExpiresAt: tokens.refreshExpiresAt };
    try {
      await deps.store.rotateGitHubToken(userId, connection.refreshTokenEnc, next);
    } catch {
      // GitHub already retired the old refresh token: one more try, and if the database still refuses, say so.
      await deps.store.rotateGitHubToken(userId, connection.refreshTokenEnc, next);
    }

    let user: GitHubUser;
    try {
      user = await fetchGitHubUser(tokens.accessToken, request);
    } catch (error) {
      if (!(error instanceof GitHubAuthError)) throw error;
      return { status: "unavailable", message: `${error.message} GitHub was not set up in this sandbox.` };
    }
    if (user.id !== connection.githubId || user.login !== connection.login || user.name !== connection.name) {
      await deps.store.updateGitHubProfile(userId, user).catch(() => {});
    }
    return { status: "connected", token: tokens.accessToken, identity: gitIdentity(user) };
  }
  return {
    status: "unavailable",
    message: "GitHub could not be refreshed because another launch was refreshing it. Try again.",
  };
}

/** The environment variables `gh` and most tools read. */
export function githubEnv(token: string): Record<string, string> {
  return { GH_TOKEN: token, GITHUB_TOKEN: token };
}

/** What `gitSetupCommand` prints last, so launch can tell whether `gh` exists in the golden. */
export const GH_PRESENT_MARKER = "armada-gh:present";

/**
 * The shell that makes git in the sandbox act as the person. Identity is global git config. HTTPS pushes
 * to github.com take their password from `GH_TOKEN` at the moment git asks, so no token is written to
 * disk, and GitHub SSH remotes are rewritten to HTTPS so they use it too. Nothing in it is a secret.
 */
export function gitSetupCommand(identity: GitIdentity): string {
  const helper = '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';
  return [
    "set -e",
    `git config --global user.name ${shQuote(identity.name)}`,
    `git config --global user.email ${shQuote(identity.email)}`,
    "git config --global --replace-all credential.https://github.com.helper ''",
    `git config --global --add credential.https://github.com.helper ${shQuote(helper)}`,
    "git config --global --replace-all url.https://github.com/.insteadOf 'git@github.com:'",
    "git config --global --add url.https://github.com/.insteadOf 'ssh://git@github.com/'",
    `if command -v gh >/dev/null 2>&1; then echo ${GH_PRESENT_MARKER}; fi`,
  ].join("\n");
}

export const GH_MISSING_NOTE =
  "gh is not installed in this golden: git push works as you, but the gh command does not. Add an init command that installs the GitHub CLI.";

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
