import { encryptSecret, githubAppFromEnv, toBytea } from "@armada/core";
import { type NextRequest, NextResponse } from "next/server";
import { readViewer } from "@/lib/data/viewer";
import {
  type ConnectDeps,
  completeGitHubConnection,
  decideGitHubCallback,
  GITHUB_CALLBACK_PATH,
  GITHUB_STATE_COOKIE,
  type GitHubConnectResult,
  githubAppIdentityConfigured,
  githubAppIdentityFromEnv,
  githubCallbackUrl,
  githubInstallUrl,
  githubOAuthErrorLog,
  githubStateCookieOptions,
  installationJson,
} from "@/lib/github";
import { originFromHeaders } from "@/lib/routes";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GitHub sends the person back here with a one-time code, or after they install the App
 * (`setup_action`, `installation_id` and `code`). The refresh token is sealed with
 * ARMADA_ENCRYPTION_KEY and stored by save_github_connection for the signed-in person: a user JWT
 * writes no column of github_connections directly and never reads the ciphertext back.
 *
 * OAuth failures are logged as `error` and `error_description` only.
 */
export async function GET(request: NextRequest) {
  const origin = originFromHeaders(request.headers, request.url);
  const { searchParams } = request.nextUrl;
  const logged = githubOAuthErrorLog({
    error: searchParams.get("error"),
    error_description: searchParams.get("error_description"),
  });
  if (logged) console.error("GitHub OAuth callback refused the authorization.", logged);

  const viewer = await readViewer();
  const identity = githubAppIdentityFromEnv(process.env);
  const decision = decideGitHubCallback({
    error: searchParams.get("error"),
    stateCookie: request.cookies.get(GITHUB_STATE_COOKIE)?.value,
    stateParam: searchParams.get("state"),
    code: searchParams.get("code"),
    setupAction: searchParams.get("setup_action"),
    installationId: searchParams.get("installation_id"),
    hasSession: viewer !== null,
    canVerifyInstallation: githubAppIdentityConfigured(identity),
  });

  if (!viewer) {
    const path = decision.kind === "result" && decision.result === "sign_in" ? "/login?error=github_install" : "/login";
    return clearState(NextResponse.redirect(new URL(path, origin)));
  }
  if (decision.kind === "result") return finish(decision.result, origin);

  const code = searchParams.get("code");
  const app = githubAppFromEnv(process.env);
  if (!code || !app) return finish(app ? "bad_code" : "not_configured", origin);

  const supabase = await createClient();
  const deps: ConnectDeps = {
    app,
    encrypt: (plaintext) => encryptSecret(plaintext),
    log(fields) {
      console.error("GitHub OAuth token request was refused.", fields);
    },
    async save({ user, refreshTokenEnc, refreshExpiresAt, installations }) {
      const { error } = await supabase.rpc("save_github_connection", {
        github_user_id: user.id,
        github_login: user.login,
        github_name: user.name,
        token_enc: toBytea(refreshTokenEnc),
        token_expires_at: refreshExpiresAt?.toISOString() ?? null,
        installation_list: installationJson(installations),
      });
      return !error;
    },
  };
  const result = await completeGitHubConnection(deps, {
    code,
    redirectUri: githubCallbackUrl(origin),
    appIdentity: identity,
    installationId: decision.installationId,
  });
  if (result !== "needs_install") return finish(result, origin);

  const state = request.cookies.get(GITHUB_STATE_COOKIE)?.value;
  const install = githubInstallUrl(identity.slug, state);
  if (!install || !state) return finish("not_installed", origin);
  const response = NextResponse.redirect(install);
  response.cookies.set(GITHUB_STATE_COOKIE, state, githubStateCookieOptions(origin));
  return response;
}

function finish(result: GitHubConnectResult, origin: string): NextResponse {
  return clearState(NextResponse.redirect(new URL(`/settings?github=${result}`, origin)));
}

function clearState(response: NextResponse): NextResponse {
  response.cookies.delete({ name: GITHUB_STATE_COOKIE, path: GITHUB_CALLBACK_PATH });
  return response;
}
