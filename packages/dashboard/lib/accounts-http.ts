// The accounts gate over HTTP: `accountsGuard` is the proxy in front of every
// route once accounts are configured (the shared-password gate in
// `auth-http.ts` applies before). It takes the environment and the session
// lookup as arguments so tests drive it without a server or a database.
import { type NextRequest, NextResponse } from "next/server";
import {
  AUTH_API_PREFIX,
  COOKIE_PREFIX,
  isCliApi,
  isFront,
  isLanding,
  isWebhook,
  LANDING_PATH,
} from "./accounts-settings";
import { type Env, LOGIN_PATH } from "./auth";
import { isLanguage, LANGUAGE_COOKIE, type Language, STRINGS } from "./i18n";

/** What the proxy knows of a request's session. */
export type SessionState = "signed-in" | "none" | "unavailable";

export type AccountsGateDeps = { env: Env; session: (request: NextRequest) => Promise<SessionState> };

const NO_STORE = { "Cache-Control": "no-store" };

/** Requests that expect data rather than a page: routes under /api, server actions and every write. */
function wantsData(request: NextRequest): boolean {
  const { pathname } = request.nextUrl;
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    request.headers.has("next-action") ||
    !["GET", "HEAD"].includes(request.method)
  );
}

/**
 * Whether the request carries a Better Auth session cookie at all (`armada.session_token`,
 * `__Secure-` prefixed over HTTPS). Without one there is no session to look up.
 */
export function hasSessionCookie(request: NextRequest): boolean {
  const name = `${COOKIE_PREFIX}.session_token`;
  return request.cookies.getAll().some((c) => c.name === name || c.name === `__Secure-${name}`);
}

/**
 * The landing, shown on the viewer's own URL (`/`). `Vary: Cookie`, so no
 * shared cache in front of the app serves it to a member, whose `/` is the overview.
 */
export function landing(request: NextRequest): NextResponse {
  const response = NextResponse.rewrite(new URL(LANDING_PATH, request.url));
  response.headers.set("Vary", "Cookie");
  return response;
}

const isAuthApi = (pathname: string) => pathname === AUTH_API_PREFIX || pathname.startsWith(`${AUTH_API_PREFIX}/`);

/**
 * The proxy's decision for one request: pass it on, send the viewer to the
 * sign-in page, answer 401, or fail closed with 503 when the accounts
 * database cannot be read.
 */
export async function accountsGuard(request: NextRequest, { env, session }: AccountsGateDeps): Promise<NextResponse> {
  if (request.method === "GET" && request.nextUrl.pathname === "/api/cron/owner") return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  // The CLI's routes carry a token or an API key, the webhooks a signature, never a cookie; each checks its own.
  if (isCliApi(pathname) || isWebhook(pathname)) return NextResponse.next();
  // The landing reads no fleet data. A visitor without a session cookie gets it
  // on `/` without a session lookup, so it shows even while the database is down.
  if (isLanding(request)) return NextResponse.next();
  if (isFront(request) && !hasSessionCookie(request)) return landing(request);
  const state = await session(request);
  if (state === "unavailable") return unavailable(wantsData(request), languageOf(request, env));
  // Better Auth's own routes (sign-in, OAuth callback, email verification) check what they need themselves.
  if (isAuthApi(pathname)) return NextResponse.next();
  const signedIn = state === "signed-in";
  if (pathname === LOGIN_PATH)
    return signedIn && !request.headers.has("next-action")
      ? NextResponse.redirect(new URL("/", request.url), 303)
      : NextResponse.next();
  if (signedIn) return NextResponse.next();
  if (isFront(request)) return landing(request);
  if (wantsData(request))
    return NextResponse.json(
      { error: "unauthorized" },
      { status: pathname.startsWith("/api/attachments/") ? 403 : 401, headers: NO_STORE },
    );
  const login = new URL(LOGIN_PATH, request.url);
  const next = `${pathname}${search}`;
  if (next !== "/") login.searchParams.set("next", next);
  return NextResponse.redirect(login, 307);
}

function languageOf(request: NextRequest, env: Env): Language {
  const pick = (v: string | undefined) => {
    const tag = v?.trim().toLowerCase().slice(0, 2);
    return isLanguage(tag) ? tag : null;
  };
  return pick(request.cookies.get(LANGUAGE_COOKIE)?.value) ?? pick(env.ARMADA_DASHBOARD_LANGUAGE) ?? "en";
}

/** Fails closed: nothing from Linear, GitHub or the fleet's live data while sessions cannot be checked. */
function unavailable(data: boolean, lang: Language): NextResponse {
  const t = STRINGS[lang].auth;
  return locked(data, lang, t.unavailableTitle, t.unavailable);
}

/**
 * Some accounts variables are set, not all: every route answers 503 and names
 * the missing ones. Neither accounts nor the shared password serve anything.
 */
export function incompleteAccounts(request: NextRequest, { env, missing }: { env: Env; missing: string[] }) {
  const lang = languageOf(request, env);
  const t = STRINGS[lang].auth;
  return locked(wantsData(request), lang, t.incompleteTitle, t.incomplete(missing.join(", ")), missing);
}

function locked(data: boolean, lang: Language, title: string, message: string, variables: string[] = []) {
  if (data) return NextResponse.json({ error: message, variables }, { status: 503, headers: NO_STORE });
  return new NextResponse(lockedPage(lang, title, message), {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE },
  });
}

const html = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** A standalone page: the app, its fonts and its styles are not served while the gate is shut. */
function lockedPage(lang: Language, title: string, message: string): string {
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Armada — ${html(title)}</title>
<style>
:root{color-scheme:dark light;--bg:#0a0b0d;--panel:#111317;--line:#22272e;--text:#ebe8e1;--muted:#9b9ea5;--accent:#ff8a4c}
@media (prefers-color-scheme:light){:root{--bg:#f3f1ea;--panel:#fffdf8;--line:#e2ded2;--text:#16171a;--muted:#5f6168;--accent:#c4541a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,sans-serif}
main{max-width:460px;padding:32px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}
.k{font:11px/1 ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
h1{font:600 28px/1.15 ui-sans-serif,system-ui,sans-serif;letter-spacing:-.02em;margin:12px 0}p{margin:0;color:var(--muted)}
</style></head>
<body><main><div class="k">Armada · 503</div><h1>${html(title)}</h1><p>${html(message)}</p></main></body></html>`;
}
