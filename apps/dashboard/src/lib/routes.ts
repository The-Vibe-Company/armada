import { CLIENT_CONFIG_PATH } from "@armada/core";

/** Paths a signed-out visitor may open. Everything else needs a session. */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === CLIENT_CONFIG_PATH ||
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname.startsWith("/auth/") ||
    // The GitHub App can send the person here before this browser has an Armada session.
    pathname === "/github/callback" ||
    // Where the CLI's GitHub sign-in ends; the CLI user may have no dashboard session in this browser.
    pathname === "/github/cli"
  );
}

/** The public landing (#564, from armada-v1-final): the proxy shows it on `/` to a viewer without a session. */
export const LANDING_PATH = "/landing";

type PageRequest = { method: string; nextUrl: { pathname: string } };
const isRead = (request: PageRequest) => ["GET", "HEAD"].includes(request.method);

/** A read of the landing or one of its files: they need no session, so no session is looked up. */
export const isLanding = (request: PageRequest) =>
  isRead(request) &&
  (request.nextUrl.pathname === LANDING_PATH || request.nextUrl.pathname.startsWith(`${LANDING_PATH}/`));

/**
 * A read of `/`, whatever its query (a shared link's `?utm_source=`, `?msclkid=`…): where a viewer without a session
 * sees the landing. No query turns `/` into an app page: a member's `/` only redirects to the sandboxes.
 */
export const isFront = (request: PageRequest) => isRead(request) && request.nextUrl.pathname === "/";

/** Supabase's session cookie (`sb-<project>-auth-token`, or its `.0`, `.1`… chunks), not the PKCE code verifier. */
const SESSION_COOKIE = /^sb-.+-auth-token(\.\d+)?$/;

/** Whether a request carries a Supabase session cookie, valid or not: without one, nobody is signed in. */
export const hasSessionCookie = (request: { cookies: { getAll(): { name: string }[] } }) =>
  request.cookies.getAll().some((cookie) => SESSION_COOKIE.test(cookie.name));

/**
 * Only same-site paths are valid redirect targets after login: a `next` pointing at another
 * origin (or protocol-relative) would turn the login into an open redirect.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/sandboxes"): string {
  if (!next) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if ([...next].some((char) => char.charCodeAt(0) < 32)) return fallback;
  try {
    const url = new URL(next, "http://armada.invalid");
    if (url.origin !== "http://armada.invalid") return fallback;
    if (isPublicPath(url.pathname) || url.pathname === "/") return fallback;
    return `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}

/** The origin the visitor used, behind a proxy (Vercel) or not: for the redirect URLs Supabase calls back. */
export function originFromHeaders(headers: { get(name: string): string | null }, fallbackUrl?: string): string {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) {
    if (fallbackUrl) return new URL(fallbackUrl).origin;
    throw new Error("request has no host header");
  }
  const forwarded = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = forwarded || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}
