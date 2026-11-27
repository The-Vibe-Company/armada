import {
  EncryptionKeyError,
  exchangeGitHubCode,
  fetchGitHubInstallations,
  fetchGitHubUser,
  GITHUB_AUTHORIZE_URL,
  type GitHubApp,
  GitHubAuthError,
  type GitHubInstallation,
  type GitHubUser,
  type Json,
  redact,
} from "@armada/core";

export const GITHUB_STATE_COOKIE = "armada_github_state";
export const GITHUB_CALLBACK_PATH = "/github/callback";
const GITHUB_STATE_MAX_AGE = 600;
const GITHUB_SLUG_PATTERN = /^[A-Za-z0-9_-]+$/;

function isGitHubSlug(value: string) {
  return value.length > 0 && value.length <= 100 && GITHUB_SLUG_PATTERN.test(value);
}

/** The state cookie: httpOnly, short lived, and sent only back to the callback. */
export function githubStateCookieOptions(origin: string): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  maxAge: number;
  path: string;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: origin.startsWith("https://"),
    maxAge: GITHUB_STATE_MAX_AGE,
    path: GITHUB_CALLBACK_PATH,
  };
}

/** Where GitHub sends the person back. It must be one of the callback URLs of the GitHub App. */
export function githubCallbackUrl(origin: string): string {
  return `${origin}${GITHUB_CALLBACK_PATH}`;
}

/** The anti-forgery value that ties the callback to the browser that started the connection. */
export function newGitHubState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function githubAuthorizeUrl(app: GitHubApp, input: { redirectUri: string; state: string }): string {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

/**
 * Where the person installs the App on their repositories, when its slug is configured.
 * A state we issued is echoed by GitHub on the install return, so the callback can match the cookie.
 */
export function githubInstallUrl(slug: string | undefined, state?: string): string | null {
  const trimmed = slug?.trim();
  if (!trimmed || !isGitHubSlug(trimmed)) return null;
  const url = new URL(`https://github.com/apps/${trimmed}/installations/new`);
  if (state && /^[0-9a-f]{48}$/.test(state)) url.searchParams.set("state", state);
  return url.toString();
}

/** GitHub's page for one installation. The login is checked so the URL cannot leave github.com. */
export function githubInstallationManageUrl(installation: {
  id: number;
  account: string;
  accountType: "User" | "Organization";
}): string | null {
  if (!Number.isSafeInteger(installation.id) || installation.id <= 0) return null;
  if (!isGitHubSlug(installation.account)) return null;
  if (installation.accountType === "Organization") {
    return `https://github.com/organizations/${installation.account}/settings/installations/${installation.id}`;
  }
  return `https://github.com/settings/installations/${installation.id}`;
}

/** The App as Connect knows it: the slug builds the install URL, and the numeric id is optional. */
interface GitHubAppIdentity {
  slug?: string;
  appId?: number;
}

export function githubAppIdentityFromEnv(env: Record<string, string | undefined>): GitHubAppIdentity {
  const slug = env.GITHUB_APP_SLUG?.trim();
  const rawId = env.GITHUB_APP_ID?.trim();
  const identity: GitHubAppIdentity = {};
  if (slug && isGitHubSlug(slug)) identity.slug = slug;
  if (rawId && /^[1-9][0-9]{0,15}$/.test(rawId)) {
    const appId = Number(rawId);
    if (Number.isSafeInteger(appId)) identity.appId = appId;
  }
  return identity;
}

export function githubAppIdentityConfigured(identity: GitHubAppIdentity): boolean {
  return identity.slug !== undefined || identity.appId !== undefined;
}

/** Installations of this App. A slug and an id that are both set must both match. */
export function installationsForApp(
  installations: readonly GitHubInstallation[],
  identity: GitHubAppIdentity,
): GitHubInstallation[] {
  if (!githubAppIdentityConfigured(identity)) return [];
  return installations.filter((item) => {
    if (identity.slug && item.appSlug.toLowerCase() !== identity.slug.toLowerCase()) return false;
    if (identity.appId !== undefined && item.appId !== identity.appId) return false;
    return true;
  });
}

/** What Settings stores and shows. Not a secret. */
export interface GitHubInstallationRecord {
  id: number;
  account: string;
  account_type: "User" | "Organization";
  repository_selection: "all" | "selected";
}

function installationRecords(installations: readonly GitHubInstallation[]): GitHubInstallationRecord[] {
  return installations.map((item) => ({
    id: item.id,
    account: item.accountLogin,
    account_type: item.accountType,
    repository_selection: item.repositorySelection,
  }));
}

/** Reads the column back. Entries that are not a real installation are dropped. */
export function storedGitHubInstallations(value: unknown): GitHubInstallationRecord[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const records: GitHubInstallationRecord[] = [];
  for (const item of value) {
    const record = storedInstallation(item);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(record);
  }
  return records;
}

function storedInstallation(value: unknown): GitHubInstallationRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = item.id;
  const account = item.account;
  const accountType = item.account_type;
  const selection = item.repository_selection;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof account !== "string" || !isGitHubSlug(account)) return null;
  if (accountType !== "User" && accountType !== "Organization") return null;
  if (selection !== "all" && selection !== "selected") return null;
  return { id, account, account_type: accountType, repository_selection: selection };
}

export type LiveGitHubStatus = {
  status: "connected" | "not_connected" | "needs_reconnect" | "unavailable";
  installations: GitHubInstallationRecord[];
  installUrl: string | null;
};

type GitHubStatusClient = { post<T>(route: string, body: Record<string, unknown>): Promise<T> };

function parseGitHubInstallUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.origin !== "https://github.com" || url.username || url.password || url.hash || url.search) return null;
    return /^\/apps\/[A-Za-z0-9_-]{1,100}\/installations\/new$/.test(url.pathname) ? url.href : null;
  } catch {
    return null;
  }
}

export function parseGitHubStatusResponse(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const conn = (value as Record<string, unknown>).connection;
  if (typeof conn !== "object" || conn === null || Array.isArray(conn)) return null;
  const row = conn as Record<string, unknown>;
  const status = row.status;
  if (status !== "connected" && status !== "not_connected" && status !== "needs_reconnect" && status !== "unavailable")
    return null;
  return {
    status,
    installations: storedGitHubInstallations(row.installations),
    installUrl: parseGitHubInstallUrl(row.installUrl),
  } satisfies LiveGitHubStatus;
}

export async function syncGitHubStatus(control: GitHubStatusClient) {
  try {
    return parseGitHubStatusResponse(await control.post<unknown>("github/status", {}));
  } catch {
    return null;
  }
}

export type SettingsGitHubView = {
  state: "connected" | "revoked" | "not-connected";
  installations: GitHubInstallationRecord[];
  installUrl: string | null;
  liveSync: "live" | "fallback" | "unconfigured";
};

export function resolveSettingsGitHubView(input: {
  dbConnection: { revoked_at: string | null; installations: unknown } | null;
  liveStatus: LiveGitHubStatus | null;
  serverConfigured: boolean;
  envInstallUrl: string | null;
}) {
  const installUrl = input.envInstallUrl ?? input.liveStatus?.installUrl ?? null;
  let liveSync: SettingsGitHubView["liveSync"] = "unconfigured";
  if (input.serverConfigured)
    liveSync = input.liveStatus && input.liveStatus.status !== "unavailable" ? "live" : "fallback";
  if (!input.dbConnection || input.dbConnection.revoked_at !== null) {
    return {
      state: input.dbConnection ? "revoked" : "not-connected",
      installations: [],
      installUrl,
      liveSync,
    } satisfies SettingsGitHubView;
  }
  const status = input.liveStatus?.status;
  if (status === "connected") {
    return {
      state: "connected",
      installations: input.liveStatus?.installations ?? [],
      installUrl,
      liveSync: "live",
    } satisfies SettingsGitHubView;
  }
  if (status === "needs_reconnect" || status === "not_connected") {
    return {
      state: status === "needs_reconnect" ? "revoked" : "not-connected",
      installations: [],
      installUrl,
      liveSync: "live",
    } satisfies SettingsGitHubView;
  }
  return {
    state: "connected",
    installations: storedGitHubInstallations(input.dbConnection.installations),
    installUrl,
    liveSync,
  } satisfies SettingsGitHubView;
}

export function githubInstallationsSummary(installations: readonly GitHubInstallationRecord[]) {
  if (installations.length === 0) return "No GitHub organizations or accounts connected yet.";
  const orgs = installations.filter((item) => item.account_type === "Organization").length;
  const users = installations.length - orgs;
  const orgLabel = `${orgs} GitHub ${orgs === 1 ? "organization" : "organizations"}`;
  const userLabel = `${users} personal ${users === 1 ? "account" : "accounts"}`;
  if (orgs > 0 && users > 0) return `Connected to ${orgLabel} and ${userLabel}.`;
  return `Connected to ${orgs > 0 ? orgLabel : userLabel}.`;
}

export type GitHubCallbackDecision =
  | { kind: "result"; result: GitHubConnectResult }
  | { kind: "sync"; installationId: number | null }
  | { kind: "exchange"; mode: "oauth" | "install"; installationId: number | null };

/**
 * What the callback should do.
 *
 * A plain OAuth return requires the state cookie. `setup_action=request` reports pending org-admin approval.
 * An install/update return without `code` syncs live installations via `github/status` without modifying
 * credentials. An install/update return with `installation_id` and `code` continues only when this browser has
 * an Armada session and we can verify the installation belongs to the App.
 */
export function decideGitHubCallback(input: {
  error: string | null;
  stateCookie: string | undefined;
  stateParam: string | null;
  code: string | null;
  setupAction: string | null;
  installationId: string | null;
  hasSession: boolean;
  canVerifyInstallation: boolean;
}): GitHubCallbackDecision {
  const error = input.error?.trim();
  if (error) return { kind: "result", result: error === "access_denied" ? "denied" : "misconfigured" };

  if (input.setupAction === "request") {
    return { kind: "result", result: input.hasSession ? "requested" : "sign_in" };
  }

  const installationId = parseInstallationId(input.installationId);
  const isInstallAction = input.setupAction === "install" || input.setupAction === "update";
  if (isInstallAction && !input.code) {
    if (!input.hasSession) return { kind: "result", result: "sign_in" };
    return { kind: "sync", installationId };
  }

  const installReturn =
    input.canVerifyInstallation && isInstallAction && installationId !== null && Boolean(input.code);
  if (installReturn) {
    if (!input.hasSession) return { kind: "result", result: "sign_in" };
    return { kind: "exchange", mode: "install", installationId };
  }

  if (!sameState(input.stateCookie, input.stateParam)) return { kind: "result", result: "state" };
  if (!input.code) return { kind: "result", result: "bad_code" };
  return { kind: "exchange", mode: "oauth", installationId: null };
}

function parseInstallationId(value: string | null): number | null {
  if (!value || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * `error` and `error_description` only. A code, a state or a token that arrived beside them is not copied,
 * and token-shaped text inside the description is masked.
 */
export function githubOAuthErrorLog(input: {
  error: string | null;
  error_description: string | null;
}): { error: string | null; error_description: string | null } | null {
  const error = oauthLogText(input.error);
  const errorDescription = oauthLogText(input.error_description);
  if (!error && !errorDescription) return null;
  return { error, error_description: errorDescription };
}

function oauthLogText(value: string | null): string | null {
  if (!value) return null;
  const cleaned = redact(value, [])
    .replaceAll(/\p{Cc}/gu, " ")
    .trim()
    .slice(0, 300);
  return cleaned || null;
}

export function sameState(expected: string | undefined, actual: string | null): boolean {
  if (!expected || !actual || expected.length !== actual.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index++) diff |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  return diff === 0;
}

/** What the settings page says after the callback. `needs_install` is not one of these: the callback redirects. */
export type GitHubConnectResult =
  | "connected"
  | "synced"
  | "requested"
  | "reconnect_required"
  | "denied"
  | "state"
  | "sign_in"
  | "not_configured"
  | "bad_code"
  | "misconfigured"
  | "not_installed"
  | "unavailable"
  | "encryption"
  | "not_saved";

/** The callback redirects to GitHub's install page instead of finishing. */
type GitHubConnectFinish = GitHubConnectResult | "needs_install";

export const GITHUB_RESULT_MESSAGES: Record<GitHubConnectResult, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "GitHub connected. Sandboxes you launch now run git and gh as you." },
  synced: {
    ok: true,
    text: "GitHub organizations synced. Running sandboxes keep their existing GitHub session.",
  },
  requested: {
    ok: true,
    text: "Organization approval requested. An organization admin needs to approve the Armada GitHub App on GitHub before its repositories appear here.",
  },
  reconnect_required: {
    ok: false,
    text: "The GitHub App installation was updated, but your GitHub account is not connected to Armada. Choose Connect GitHub below.",
  },
  denied: { ok: false, text: "GitHub was not connected: the authorization was declined." },
  state: { ok: false, text: "GitHub was not connected: the sign-in expired or came from another browser. Try again." },
  sign_in: {
    ok: false,
    text: "The GitHub App was installed, but this browser is not signed in to Armada, so the connection was not saved. Sign in, then choose Connect GitHub in Settings.",
  },
  not_configured: {
    ok: false,
    text: "GitHub is not set up on this Armada deployment (GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET).",
  },
  bad_code: { ok: false, text: "GitHub was not connected: the authorization code was refused. Try again." },
  misconfigured: {
    ok: false,
    text: "GitHub was not connected: the GitHub App is set up wrong. Ask the Armada owner to check its callback URL, client secret and 'Expire user authorization tokens'.",
  },
  not_installed: {
    ok: false,
    text: "GitHub was not connected: the Armada GitHub App is not installed on an account you can access.",
  },
  unavailable: { ok: false, text: "GitHub could not be reached. Try again in a moment." },
  encryption: {
    ok: false,
    text: "GitHub was not connected: credential encryption is not configured (ARMADA_ENCRYPTION_KEY).",
  },
  not_saved: { ok: false, text: "GitHub answered, but the connection could not be saved. Try again." },
};

export function isGitHubResult(value: string | undefined): value is GitHubConnectResult {
  return value !== undefined && Object.hasOwn(GITHUB_RESULT_MESSAGES, value);
}

export interface ConnectDeps {
  ownerId: string;
  app: GitHubApp;
  encrypt(plaintext: string): Promise<Uint8Array>;
  /** Stores the connection as the signed-in person. Returns false when the database refused it. */
  save(connection: {
    user: GitHubUser;
    refreshTokenEnc: Uint8Array;
    refreshExpiresAt: Date | null;
    installations: GitHubInstallationRecord[] | null;
  }): Promise<boolean>;
  existingConnection?: { githubId: number; revoked: boolean } | null;
  syncInstallations?: () => Promise<LiveGitHubStatus | null>;
  /** OAuth `error` and `error_description` only, already safe to print. */
  log?(fields: { error: string | null; error_description: string | null }): void;
  fetch?: typeof fetch;
}

export async function completeGitHubSync(syncInstallations: (() => Promise<LiveGitHubStatus | null>) | undefined) {
  if (!syncInstallations) return "unavailable" satisfies GitHubConnectResult;
  const live = await syncInstallations();
  if (!live || live.status === "unavailable") return "unavailable" satisfies GitHubConnectResult;
  return (live.status === "connected" ? "synced" : "reconnect_required") satisfies GitHubConnectResult;
}

/** Finishes "Connect GitHub", preserving `connection_epoch` via live sync when already connected on an install return. */
export async function completeGitHubConnection(
  deps: ConnectDeps,
  input: {
    code: string;
    redirectUri: string;
    mode?: "oauth" | "install";
    stateVerified?: boolean;
    appIdentity?: GitHubAppIdentity;
    installationId?: number | null;
  },
): Promise<GitHubConnectFinish> {
  const syncInstallations = deps.syncInstallations;
  const existingConnection = deps.existingConnection;
  const canPreserveEpoch =
    input.mode === "install" && existingConnection != null && !existingConnection.revoked && syncInstallations != null;
  let preservedSyncConnected = false;
  if (canPreserveEpoch) {
    const live = await syncInstallations();
    if (!live || live.status === "unavailable") return "unavailable";
    if (live.status === "connected") {
      if (input.installationId == null || live.installations.some((item) => item.id === input.installationId)) {
        return "synced";
      }
      preservedSyncConnected = true;
    }
  }

  const request = deps.fetch ? { fetch: deps.fetch } : {};
  try {
    const tokens = await exchangeGitHubCode(deps.app, input, request);
    const user = await fetchGitHubUser(tokens.accessToken, request);
    const installations = await installationsToSave(deps, tokens.accessToken, input.appIdentity, input.installationId);
    if (typeof installations === "string") return installations;
    if (canPreserveEpoch && preservedSyncConnected && existingConnection.githubId === user.id) {
      const retried = await syncInstallations();
      return retried?.status === "connected" ? "synced" : "unavailable";
    }
    const crossIdentity =
      input.mode === "install" &&
      existingConnection &&
      !existingConnection.revoked &&
      existingConnection.githubId !== user.id;
    if (crossIdentity && !input.stateVerified) return "state";
    const refreshTokenEnc = await deps.encrypt(tokens.refreshToken);
    const saved = await deps.save({
      user,
      refreshTokenEnc,
      refreshExpiresAt: tokens.refreshExpiresAt,
      installations,
    });
    if (saved)
      console.error(
        JSON.stringify({
          event: "github_connection_replaced",
          caller: "dashboard_callback",
          ownerId: deps.ownerId,
          reason: "oauth_connect",
          githubId: user.id,
          accessExpiresAt: tokens.accessExpiresAt.toISOString(),
          observedRemainingLifetimeMs: tokens.accessExpiresAt.getTime() - Date.now(),
          accessTokenCached: false,
        }),
      );
    return saved ? "connected" : "not_saved";
  } catch (error) {
    if (error instanceof EncryptionKeyError) return "encryption";
    if (error instanceof GitHubAuthError) {
      const fields = githubOAuthErrorLog({
        error: error.oauthError ?? null,
        error_description: error.oauthErrorDescription
          ? redact(error.oauthErrorDescription, [deps.app.clientSecret])
          : null,
      });
      if (fields) deps.log?.(fields);
      return error.code === "revoked" ? "bad_code" : error.code;
    }
    throw error;
  }
}

/** The records to store, or a finish code when the App is not installed for this person. */
async function installationsToSave(
  deps: ConnectDeps,
  accessToken: string,
  identity: GitHubAppIdentity | undefined,
  installationId: number | null | undefined,
): Promise<GitHubInstallationRecord[] | null | "needs_install" | "not_installed"> {
  if (!identity || !githubAppIdentityConfigured(identity)) return null;
  const request = deps.fetch ? { fetch: deps.fetch } : {};
  const found = installationsForApp(await fetchGitHubInstallations(accessToken, request), identity);
  if (installationId != null) {
    return found.some((item) => item.id === installationId) ? installationRecords(found) : "not_installed";
  }
  if (found.length === 0) return identity.slug ? "needs_install" : "not_installed";
  return installationRecords(found);
}

/** The `installations` argument of `save_github_connection`. */
export function installationJson(records: GitHubInstallationRecord[] | null): Json | null {
  if (!records) return null;
  const rows: Json[] = records.map((record) => ({
    id: record.id,
    account: record.account,
    account_type: record.account_type,
    repository_selection: record.repository_selection,
  }));
  return rows;
}
