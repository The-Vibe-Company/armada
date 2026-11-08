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
 * ARMADA_ENCRYPTION_KEY and stored as the signed-in person, so row level security keeps it theirs.
 */
export async function GET(request: NextRequest) {
  const viewer = await requireViewer();
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
        const row = {
          github_id: user.id,
          login: user.login,
          name: user.name,
          refresh_token_enc: toBytea(refreshTokenEnc),
          refresh_expires_at: refreshExpiresAt?.toISOString() ?? null,
          revoked_at: null,
          updated_at: new Date().toISOString(),
        };
        const existing = await supabase.from("github_connections").select("user_id").maybeSingle();
        if (existing.error) return false;
        if (existing.data) {
          const updated = await supabase
            .from("github_connections")
            .update(row)
            .eq("user_id", viewer.id)
            .select("user_id");
          return !updated.error && updated.data.length > 0;
        }
        const inserted = await supabase.from("github_connections").insert({ user_id: viewer.id, ...row });
        return !inserted.error;
      },
    },
    { code, redirectUri: githubCallbackUrl(origin) },
  );
  return finish(result);
}
