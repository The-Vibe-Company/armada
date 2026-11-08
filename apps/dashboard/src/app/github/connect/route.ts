import { githubAppFromEnv } from "@armada/core";
import { type NextRequest, NextResponse } from "next/server";
import { requireViewer } from "@/lib/data/viewer";
import {
  GITHUB_STATE_COOKIE,
  githubAuthorizeUrl,
  githubCallbackUrl,
  githubStateCookieOptions,
  newGitHubState,
} from "@/lib/github";
import { originFromHeaders } from "@/lib/routes";

export const dynamic = "force-dynamic";

/** Starts "Connect GitHub": a state cookie, then GitHub's user authorization page for the Armada GitHub App. */
export async function GET(request: NextRequest) {
  await requireViewer();
  const origin = originFromHeaders(request.headers, request.url);
  const app = githubAppFromEnv(process.env);
  if (!app) return NextResponse.redirect(new URL("/settings?github=not_configured", origin));

  const state = newGitHubState();
  const response = NextResponse.redirect(githubAuthorizeUrl(app, { redirectUri: githubCallbackUrl(origin), state }));
  response.cookies.set(GITHUB_STATE_COOKIE, state, githubStateCookieOptions(origin));
  return response;
}
