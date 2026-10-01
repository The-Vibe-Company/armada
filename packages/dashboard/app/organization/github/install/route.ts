import { NextResponse } from "next/server";
import { requireAccounts, requireMember } from "@/lib/accounts-server";
import { accountsModeOf, GITHUB_PATH } from "@/lib/accounts-settings";
import {
  githubPage,
  INSTALL_COOKIE,
  INSTALL_STATE_TTL_MS,
  installState,
  installUrl,
  managesOrganization,
  newNonce,
} from "@/lib/github-install";
import { githubApp } from "@/lib/server";

// The Install on GitHub button (THE-852): signs the state now, at the click,
// keeps its nonce in a cookie of this browser, and sends the owner or admin to
// GitHub's install page. GitHub sends them back to the Setup URL.
export const dynamic = "force-dynamic";

export async function GET() {
  if (accountsModeOf(process.env).kind !== "accounts") return new Response(null, { status: 404 });
  const viewer = await requireMember();
  const { settings } = await requireAccounts();
  const back = (path: string) => NextResponse.redirect(new URL(path, settings.baseUrl), 303);
  if (!managesOrganization(viewer.organization)) return back(githubPage({ error: "forbidden" }));
  const app = githubApp();
  if (!app) return back(githubPage({ error: "off" }));
  let appUrl: string;
  try {
    appUrl = (await app.info()).url;
  } catch (err) {
    console.error(`armada dashboard: GitHub App: ${err instanceof Error ? err.message : String(err)}`);
    return back(githubPage({ error: "failed" }));
  }
  const nonce = newNonce();
  const state = installState(
    settings.secret,
    { organization: viewer.organization.id, user: viewer.user.id, nonce },
    new Date(),
  );
  const res = NextResponse.redirect(installUrl(appUrl, state), 303);
  res.cookies.set(INSTALL_COOKIE, nonce, {
    path: GITHUB_PATH,
    maxAge: INSTALL_STATE_TTL_MS / 1000,
    // Lax: sent on GitHub's top-level redirect back to the Setup URL.
    sameSite: "lax",
    httpOnly: true,
    secure: new URL(settings.baseUrl).protocol === "https:",
  });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
