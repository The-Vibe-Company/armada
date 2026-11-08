import {
  EncryptionKeyError,
  exchangeGitHubCode,
  fetchGitHubUser,
  GITHUB_AUTHORIZE_URL,
  type GitHubApp,
  GitHubAuthError,
  type GitHubUser,
} from "@armada/core";

export const GITHUB_STATE_COOKIE = "armada_github_state";
export const GITHUB_CALLBACK_PATH = "/github/callback";

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

/** Where the person installs the App on their repositories, when its slug is configured. */
export function githubInstallUrl(slug: string | undefined): string | null {
  const trimmed = slug?.trim();
  return trimmed && /^[A-Za-z0-9-]+$/.test(trimmed) ? `https://github.com/apps/${trimmed}/installations/new` : null;
}

export function sameState(expected: string | undefined, actual: string | null): boolean {
  if (!expected || !actual || expected.length !== actual.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index++) diff |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  return diff === 0;
}

/** What the settings page says after the callback. */
export type GitHubConnectResult =
  | "connected"
  | "denied"
  | "state"
  | "not_configured"
  | "bad_code"
  | "misconfigured"
  | "unavailable"
  | "encryption"
  | "not_saved";

export const GITHUB_RESULT_MESSAGES: Record<GitHubConnectResult, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "GitHub connected. Sandboxes you launch now run git and gh as you." },
  denied: { ok: false, text: "GitHub was not connected: the authorization was declined." },
  state: { ok: false, text: "GitHub was not connected: the sign-in expired or came from another browser. Try again." },
  not_configured: {
    ok: false,
    text: "GitHub is not set up on this Armada deployment (GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET).",
  },
  bad_code: { ok: false, text: "GitHub was not connected: the authorization code was refused. Try again." },
  misconfigured: {
    ok: false,
    text: "GitHub was not connected: the GitHub App is set up wrong. Ask the Armada owner to check its callback URL, client secret and 'Expire user authorization tokens'.",
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
  app: GitHubApp;
  encrypt(plaintext: string): Promise<Uint8Array>;
  /** Stores the connection as the signed-in person. Returns false when the database refused it. */
  save(connection: { user: GitHubUser; refreshTokenEnc: Uint8Array; refreshExpiresAt: Date | null }): Promise<boolean>;
  fetch?: typeof fetch;
}

/**
 * Finishes "Connect GitHub": trades the callback's code for tokens, asks GitHub who the person is,
 * seals the refresh token and hands it to `save`. Only the refresh token is kept; the access token
 * is dropped here. Nothing in the result carries a token.
 */
export async function completeGitHubConnection(
  deps: ConnectDeps,
  input: { code: string; redirectUri: string },
): Promise<GitHubConnectResult> {
  const request = deps.fetch ? { fetch: deps.fetch } : {};
  try {
    const tokens = await exchangeGitHubCode(deps.app, input, request);
    const user = await fetchGitHubUser(tokens.accessToken, request);
    const refreshTokenEnc = await deps.encrypt(tokens.refreshToken);
    const saved = await deps.save({ user, refreshTokenEnc, refreshExpiresAt: tokens.refreshExpiresAt });
    return saved ? "connected" : "not_saved";
  } catch (error) {
    if (error instanceof EncryptionKeyError) return "encryption";
    if (error instanceof GitHubAuthError) {
      return error.code === "revoked" ? "bad_code" : error.code;
    }
    throw error;
  }
}
