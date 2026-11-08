import { encryptSecret, githubAppFromEnv, toBytea } from "@armada/core";
import { type NextRequest, NextResponse } from "next/server";
import { getGitHubConnection } from "@/lib/data/github";
import { requireViewer } from "@/lib/data/viewer";
import {
  completeGitHubConnection,
  GITHUB_CALLBACK_PATH,
  GITHUB_STATE_COOKIE,
  type GitHubConnectResult,
  githubCallbackUrl,
  githubInstallUrl,
  logGitHubCallback,
  newGitHubState,
  sameState,
  withGitHubStateCookie,
} from "@/lib/github";
import { originFromHeaders } from "@/lib/routes";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GitHub sends the person back here two ways: a plain OAuth callback (`code`, `state`), and an App
 * installation return (`setup_action`, `installation_id`, and `code` when "Request user
 * authorization during installation" is on). The refresh token is sealed with
 * ARMADA_ENCRYPTION_KEY and stored by save_github_connection for the signed-in person: a user JWT
 * writes no column of github_connections directly and never reads the ciphertext back.
 *
 * Plain OAuth always requires the state cookie to match: that CSRF protection is never weakened.
 * An installation return may legitimately arrive without it (the install step on GitHub's side can
 * outlive the cookie's ten minutes, or start from GitHub's own UI rather than Armada's install
 * link); when the cookie is missing, the code is still required and is exchanged and corroborated
 * against GitHub's own `GET /user/installations` before anything is trusted, and the connection
 * may only be created or refreshed for the same GitHub account, never switched to a different one.
 * See docs/github-app.md for the full trust boundary and its tradeoff.
 */
export async function GET(request: NextRequest) {
  await requireViewer();
  const origin = originFromHeaders(request.headers, request.url);
  const { searchParams } = request.nextUrl;
  const stateCookie = request.cookies.get(GITHUB_STATE_COOKIE)?.value;

  const finish = (result: GitHubConnectResult, installReturn: boolean) => {
    logGitHubCallback({ result, installReturn });
    const response = NextResponse.redirect(new URL(`/settings?github=${result}`, origin));
    response.cookies.delete({ name: GITHUB_STATE_COOKIE, path: GITHUB_CALLBACK_PATH });
    return response;
  };

  const setupAction = searchParams.get("setup_action");
  const isInstallReturn = setupAction !== null;

  if (searchParams.get("error")) return finish("denied", isInstallReturn);

  // Plain OAuth always needs a matching state. An installation return earns trust the narrower
  // way below only when the cookie truly is not there; if it is, it still must match.
  if (!isInstallReturn || stateCookie !== undefined) {
    if (!sameState(stateCookie, searchParams.get("state"))) return finish("state", isInstallReturn);
  }

  if (setupAction === "request") return finish("install_requested", true);
  if (isInstallReturn && setupAction !== "install" && setupAction !== "update") {
    return finish("bad_code", true);
  }

  const code = searchParams.get("code");
  if (!code) return finish(isInstallReturn ? "install_pending" : "bad_code", isInstallReturn);

  const app = githubAppFromEnv(process.env);
  if (!app) return finish("not_configured", isInstallReturn);

  const installationId = isInstallReturn ? parsePositiveId(searchParams.get("installation_id")) : null;
  if (isInstallReturn && installationId === null) return finish("bad_code", true);

  const slug = process.env.GITHUB_APP_SLUG?.trim() || undefined;
  const supabase = await createClient();

  const outcome = await completeGitHubConnection(
    {
      app,
      ...(slug ? { slug } : {}),
      claimedInstallationId: installationId,
      allowAccountChange: !isInstallReturn || stateCookie !== undefined,
      async getExistingGithubId() {
        return (await getGitHubConnection(supabase))?.github_id ?? null;
      },
      encrypt: (plaintext) => encryptSecret(plaintext),
      async save({ user, refreshTokenEnc, refreshExpiresAt, installationId: savedInstallationId }) {
        const { error } = await supabase.rpc("save_github_connection", {
          github_user_id: user.id,
          github_login: user.login,
          github_name: user.name,
          token_enc: toBytea(refreshTokenEnc),
          token_expires_at: refreshExpiresAt?.toISOString() ?? null,
          installation_id: savedInstallationId,
        });
        return !error;
      },
    },
    { code, redirectUri: githubCallbackUrl(origin) },
  );

  if (outcome.result === "connected" && outcome.needsInstall && slug) {
    const state = newGitHubState();
    const installUrl = githubInstallUrl(slug, state);
    if (installUrl) {
      logGitHubCallback({ result: outcome.result, installReturn: isInstallReturn });
      return withGitHubStateCookie(NextResponse.redirect(installUrl), origin, state);
    }
  }
  return finish(outcome.result, isInstallReturn);
}

function parsePositiveId(value: string | null): number | null {
  if (!value || !/^[0-9]+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
