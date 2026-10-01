import { type NextRequest, NextResponse } from "next/server";
import { requireAccounts, requireMember, viewerGithubToken } from "@/lib/accounts-server";
import { accountsModeOf, GITHUB_PATH } from "@/lib/accounts-settings";
import { type GithubResult, githubPage, INSTALL_COOKIE, linkFromSetup, linkViewerOf } from "@/lib/github-install";
import { githubApp } from "@/lib/server";

// GitHub's return to the Setup URL (THE-852), handed over by the GitHub page:
// installation_id, setup_action and the state the Install button signed. The
// installation is linked here, the nonce cookie is cleared (used once), and
// the GitHub page shows the outcome with a clean address. A return without a
// state (the installation changed from GitHub's side) writes nothing.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (accountsModeOf(process.env).kind !== "accounts") return new Response(null, { status: 404 });
  const viewer = await requireMember();
  const { client, settings } = await requireAccounts();
  const q = request.nextUrl.searchParams;
  const state = q.get("state");
  const installation = q.get("installation_id");
  let result: GithubResult | null = null;
  if (state && installation)
    result = githubApp()
      ? await linkFromSetup(client, {
          secret: settings.secret,
          state,
          nonce: request.cookies.get(INSTALL_COOKIE)?.value ?? null,
          installation: Number(installation),
          viewer: linkViewerOf(viewer),
          githubToken: viewerGithubToken,
          fetch: globalThis.fetch,
          now: new Date(),
        })
      : { error: "off" };
  else if (q.get("setup_action") === "request") result = { done: "requested" };
  const res = NextResponse.redirect(new URL(result ? githubPage(result) : GITHUB_PATH, settings.baseUrl), 303);
  if (state) res.cookies.delete({ name: INSTALL_COOKIE, path: GITHUB_PATH });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
