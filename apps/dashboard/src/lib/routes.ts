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
