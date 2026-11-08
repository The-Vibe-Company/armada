import { encryptSecret, githubAppFromEnv, toBytea } from "@armada/core";
import { type NextRequest, NextResponse } from "next/server";
import { requireViewer } from "@/lib/data/viewer";
import {
  completeGitHubConnection,
  GITHUB_CALLBACK_PATH,
  GITHUB_STATE_COOKIE,
  type GitHubConnectResult,
  githubCallbackUrl,
  sameState,
} from "@/lib/github";
import { originFromHeaders } from "@/lib/routes";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GitHub sends the person back here with a one-time code. The refresh token is sealed with
 * ARMADA_ENCRYPTION_KEY and stored by save_github_connection for the signed-in person: a user JWT
 * writes no column of github_connections directly and never reads the ciphertext back.
 */
export async function GET(request: NextRequest) {
  await requireViewer();
  const origin = originFromHeaders(request.headers, request.url);
  const { searchParams } = request.nextUrl;

  const finish = (result: GitHubConnectResult) => {
    const response = NextResponse.redirect(new URL(`/settings?github=${result}`, origin));
    response.cookies.delete({ name: GITHUB_STATE_COOKIE, path: GITHUB_CALLBACK_PATH });
    return response;
  };

  if (searchParams.get("error")) return finish("denied");
  if (!sameState(request.cookies.get(GITHUB_STATE_COOKIE)?.value, searchParams.get("state"))) return finish("state");
  const code = searchParams.get("code");
  if (!code) return finish("bad_code");
  const app = githubAppFromEnv(process.env);
  if (!app) return finish("not_configured");

  const supabase = await createClient();
  const result = await completeGitHubConnection(
    {
      app,
      encrypt: (plaintext) => encryptSecret(plaintext),
      async save({ user, refreshTokenEnc, refreshExpiresAt }) {
        const { error } = await supabase.rpc("save_github_connection", {
          github_user_id: user.id,
          github_login: user.login,
          github_name: user.name,
          token_enc: toBytea(refreshTokenEnc),
          token_expires_at: refreshExpiresAt?.toISOString() ?? null,
        });
        return !error;
      },
    },
    { code, redirectUri: githubCallbackUrl(origin) },
  );
  return finish(result);
}
