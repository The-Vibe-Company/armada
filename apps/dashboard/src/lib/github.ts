import {
  EncryptionKeyError,
  exchangeGitHubCode,
  fetchGitHubInstallations,
  fetchGitHubUser,
  GITHUB_AUTHORIZE_URL,
  type GitHubApp,
  GitHubAuthError,
  type GitHubUser,
} from "@armada/core";
import type { NextResponse } from "next/server";

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

/** Where the person installs the App on their repositories, when its slug is configured. An
 * optional `state` is echoed back by GitHub on the installation return, the same way it is on
 * plain OAuth: it lets Armada tell its own redirect here apart from one it never issued. */
export function githubInstallUrl(slug: string | undefined, state?: string): string | null {
  const trimmed = slug?.trim();
  if (!trimmed || !/^[A-Za-z0-9-]+$/.test(trimmed)) return null;
  const url = new URL(`https://github.com/apps/${trimmed}/installations/new`);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

/** Sets the anti-forgery cookie before sending the browser to GitHub, for OAuth or for install. */
export function withGitHubStateCookie<T extends NextResponse>(response: T, origin: string, state: string): T {
  response.cookies.set(GITHUB_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: origin.startsWith("https://"),
    maxAge: 600,
    path: GITHUB_CALLBACK_PATH,
  });
  return response;
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
  | "not_saved"
  | "mismatch"
  | "install_mismatch"
  | "install_pending"
  | "install_requested";

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
  mismatch: {
    ok: false,
    text: "GitHub was not connected: this would switch the GitHub account already connected for you. Use Reconnect in Settings if that is what you want.",
  },
  install_mismatch: {
    ok: false,
    text: "GitHub was not connected: that installation does not belong to the Armada GitHub App for your account.",
  },
  install_pending: {
    ok: false,
    text: "The GitHub App was installed, but Armada could not verify it for your account yet. Click Connect GitHub to finish.",
  },
  install_requested: {
    ok: true,
    text: "A request to install the GitHub App was sent to the organization's owner. Once approved, click Connect GitHub to finish.",
  },
};

export function isGitHubResult(value: string | undefined): value is GitHubConnectResult {
  return value !== undefined && Object.hasOwn(GITHUB_RESULT_MESSAGES, value);
}

export interface ConnectDeps {
  app: GitHubApp;
  /** The configured App's slug, when known: the only reliable way to tell its installations apart
   * from any other app's in the person's `GET /user/installations`. */
  slug?: string;
  /** The installation_id an installation return claims. Trusted only once it is corroborated by
   * GitHub below: never from the query string alone. Undefined for a plain OAuth callback. */
  claimedInstallationId?: number | null;
  /** False on a round-trip without a matched CSRF state (an installation return with no cookie,
   * see docs/github-app.md): the connection may still be created, or refreshed for the same
   * GitHub account, but never switched to a different one. */
  allowAccountChange: boolean;
  /** The GitHub id already on file for the signed-in person, or null. Only read when
   * `allowAccountChange` is false. */
  getExistingGithubId(): Promise<number | null>;
  encrypt(plaintext: string): Promise<Uint8Array>;
  /** Stores the connection as the signed-in person. Returns false when the database refused it. */
  save(connection: {
    user: GitHubUser;
    refreshTokenEnc: Uint8Array;
    refreshExpiresAt: Date | null;
    installationId: number | null;
  }): Promise<boolean>;
  fetch?: typeof fetch;
}

export interface GitHubConnectOutcome {
  result: GitHubConnectResult;
  /** True only once the connection succeeded but no installation of the configured App was found
   * for this person: Connect GitHub should continue to the install page next. */
  needsInstall: boolean;
}

/**
 * Finishes "Connect GitHub": trades the callback's code for tokens, asks GitHub who the person is,
 * seals the refresh token and hands it to `save`. Only the refresh token is kept; the access token
 * is dropped here. Nothing in the result carries a token.
 *
 * When `slug` is known, this also looks up the person's installations of the configured App
 * (`GET /user/installations`, the only source of truth): an installation_id the caller claims is
 * accepted only once it appears there, and the outcome says whether the person still needs to
 * install the App anywhere at all.
 */
export async function completeGitHubConnection(
  deps: ConnectDeps,
  input: { code: string; redirectUri: string },
): Promise<GitHubConnectOutcome> {
  const request = deps.fetch ? { fetch: deps.fetch } : {};
  const fail = (result: GitHubConnectResult): GitHubConnectOutcome => ({ result, needsInstall: false });
  try {
    if (deps.claimedInstallationId != null && !deps.slug) return fail("install_mismatch");

    const tokens = await exchangeGitHubCode(deps.app, input, request);
    const user = await fetchGitHubUser(tokens.accessToken, request);

    let installationId: number | null = null;
    let needsInstall = false;
    if (deps.slug) {
      const installations = await fetchGitHubInstallations(tokens.accessToken, request);
      const match = installations.find((item) => item.appSlug === deps.slug);
      installationId = match?.id ?? null;
      needsInstall = installationId === null;
    }
    if (deps.claimedInstallationId != null && installationId !== deps.claimedInstallationId) {
      return fail("install_mismatch");
    }

    if (!deps.allowAccountChange) {
      const existing = await deps.getExistingGithubId();
      if (existing !== null && existing !== user.id) return fail("mismatch");
    }

    const refreshTokenEnc = await deps.encrypt(tokens.refreshToken);
    const saved = await deps.save({ user, refreshTokenEnc, refreshExpiresAt: tokens.refreshExpiresAt, installationId });
    return saved ? { result: "connected", needsInstall } : fail("not_saved");
  } catch (error) {
    if (error instanceof EncryptionKeyError) return fail("encryption");
    if (error instanceof GitHubAuthError) return fail(error.code === "revoked" ? "bad_code" : error.code);
    throw error;
  }
}

/** Logs only a fixed, known-safe shape: never a token, secret, code, cookie or raw GitHub response. */
export function logGitHubCallback(event: { result: GitHubConnectResult; installReturn: boolean }): void {
  console.warn(`github callback: ${event.result}${event.installReturn ? " (install return)" : ""}`);
}
