import { CLIENT_CONFIG_PATH } from "@armada/core";
import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { supabaseEnv } from "@/lib/env";
import {
  encodeEmailLink,
  INVITATION_ACCEPT_PATH,
  INVITATION_COOKIE,
  INVITATION_LINK_COOKIE,
  INVITATION_LINK_MAX_AGE,
  INVITATION_LINK_SESSION_COOKIE,
  invitationCookieOptions,
  isInvitationToken,
} from "@/lib/invitations";
import { hasSessionCookie, isFront, isLanding, isPublicPath, LANDING_PATH } from "@/lib/routes";
import type { Database } from "@/lib/supabase/types";

/** The landing on the visitor's own URL (`/`); `Vary: Cookie`, as a member's `/` is the dashboard. */
function landing(request: NextRequest, carry?: NextResponse): NextResponse {
  const target = request.nextUrl.clone();
  target.pathname = LANDING_PATH;
  target.search = "";
  const rewritten = NextResponse.rewrite(target);
  for (const cookie of carry?.cookies.getAll() ?? []) rewritten.cookies.set(cookie);
  rewritten.headers.set("Vary", "Cookie");
  return rewritten;
}

/**
 * The emailed invitation link carries its token in the query. It moves into a short-lived HTTP-only cookie (path `/`,
 * see `invitationCookieOptions`) and the visitor lands on the same page without the query, so the token never reaches a login
 * `next`, a Referer, the history, analytics or the rendered page. A malformed token is dropped. Nothing is accepted
 * and nobody is signed in here. A URL fragment (GoTrue's default email session) survives this redirect for the page's
 * bridge; a `token_hash` moves into its own cookie.
 */
function stashInvitation(request: NextRequest): NextResponse {
  const token = request.nextUrl.searchParams.get("token");
  const target = request.nextUrl.clone();
  target.search = "";
  const response = NextResponse.redirect(target, 303);
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Cache-Control", "no-store");
  if (!isInvitationToken(token)) return response;
  const secure = request.nextUrl.protocol === "https:";
  response.cookies.set(INVITATION_COOKIE, token, invitationCookieOptions(secure));
  // A template that confirms server-side sends `token_hash`: kept for the explicit "continue", never verified here.
  const link = encodeEmailLink(
    request.nextUrl.searchParams.get("type"),
    request.nextUrl.searchParams.get("token_hash"),
  );
  // A newer invitation link replaces any earlier one's sign-in: an old `token_hash` never outlives its invitation.
  if (link)
    response.cookies.set(INVITATION_LINK_COOKIE, link, {
      ...invitationCookieOptions(secure),
      maxAge: INVITATION_LINK_MAX_AGE,
    });
  else response.cookies.delete(INVITATION_LINK_COOKIE);
  response.cookies.delete({ name: INVITATION_LINK_SESSION_COOKIE, path: INVITATION_ACCEPT_PATH });
  return response;
}

/**
 * Refreshes the session cookie on every request, shows the landing on `/` to a signed-out visitor and sends
 * one anywhere else to the login page.
 */
export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === CLIENT_CONFIG_PATH || request.nextUrl.pathname.startsWith("/api/v1/"))
    return NextResponse.next();
  if (request.nextUrl.pathname === INVITATION_ACCEPT_PATH && request.nextUrl.search !== "")
    return stashInvitation(request);
  // Stats authenticates its own bearer; only this exact read endpoint bypasses the session gate.
  if (request.nextUrl.pathname === "/api/stats" && ["GET", "HEAD"].includes(request.method)) return NextResponse.next();
  // The landing reads no session and no data: it shows without a session lookup. A visitor with no
  // session cookie is signed out, so their `/` is the landing without reading Supabase's settings either.
  if (isLanding(request)) return NextResponse.next();
  if (isFront(request) && !hasSessionCookie(request)) return landing(request);
  const { url, anonKey } = supabaseEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(list) {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  const { pathname, search } = request.nextUrl;

  const redirect = (target: URL) => {
    const redirected = NextResponse.redirect(target);
    for (const cookie of response.cookies.getAll()) redirected.cookies.set(cookie);
    return redirected;
  };

  // A stale or invalid session cookie: signed out, with the cookies Supabase cleared.
  if (!signedIn && isFront(request)) return landing(request, response);
  if (!signedIn && pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  }
  if (!signedIn && !isPublicPath(pathname)) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
    return redirect(login);
  }
  if (signedIn && pathname === "/login") {
    const home = request.nextUrl.clone();
    home.pathname = "/";
    home.search = "";
    return redirect(home);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
