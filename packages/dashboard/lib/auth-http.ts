// The password gate over HTTP: `guard` is the proxy in front of every route,
// `login` and `logout` are the two routes a viewer without a session may call.
// Each takes the environment, the clock and the limiter as arguments so tests
// drive them without a server.
import { type NextRequest, NextResponse } from "next/server";
import { isCliApi, isWebhook } from "./accounts-settings";
import {
  clearedSessionCookie,
  clientAddress,
  type Env,
  type FailureLimiter,
  type Gate,
  gateOf,
  issueSession,
  LOGIN_PATH,
  LOGIN_ROUTE,
  LOGOUT_ROUTE,
  PASSWORD_VARIABLE,
  passwordMatches,
  SESSION_COOKIE,
  safeNext,
  secureCookie,
  sessionCookie,
  validSession,
} from "./auth";
import { isLanguage, LANGUAGE_COOKIE, type Language, STRINGS } from "./i18n";

export type GateDeps = { env: Env; now: number };
export type LoginDeps = GateDeps & { limiter: FailureLimiter };

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
 * The proxy's decision for one request: pass it on, send the viewer to the
 * login page, answer 401, or fail closed with 503 when no password is configured.
 */
export function guard(request: NextRequest, { env, now }: GateDeps): NextResponse {
  const gate = gateOf(env);
  const { pathname, search } = request.nextUrl;
  if (gate.kind === "unconfigured") return unconfigured(gate, wantsData(request), languageOf(request, env));
  const signedIn = gate.kind === "off" || validSession(request.cookies.get(SESSION_COOKIE)?.value, gate.password, now);
  if (pathname === LOGIN_PATH)
    return signedIn ? NextResponse.redirect(new URL("/", request.url), 303) : NextResponse.next();
  // The two routes a viewer without a session must reach, the CLI's routes, which
  // refuse the terminal with the next step while the dashboard has no accounts,
  // and the webhooks, which check their own signature.
  if (signedIn || pathname === LOGIN_ROUTE || pathname === LOGOUT_ROUTE || isCliApi(pathname) || isWebhook(pathname))
    return NextResponse.next();
  if (wantsData(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const login = new URL(LOGIN_PATH, request.url);
  const next = `${pathname}${search}`;
  if (next !== "/") login.searchParams.set("next", next);
  return NextResponse.redirect(login, 307);
}

/**
 * The login form's target. A wrong password counts against the viewer's
 * address; past the limit even the right one is refused until the window ends.
 */
export async function login(request: Request, { env, now, limiter }: LoginDeps): Promise<Response> {
  const url = new URL(request.url);
  const gate = gateOf(env);
  if (gate.kind === "unconfigured") return unconfigured(gate, true, "en");
  if (gate.kind === "off") return see(url, "/");
  if (!sameOrigin(request)) return Response.json({ error: "cross-origin login refused" }, { status: 403 });

  const form = await request.formData().catch(() => null);
  const password = form?.get("password");
  const next = safeNext(form?.get("next"), url);
  const address = clientAddress(request.headers);
  const back = (error: "wrong" | "limited") => {
    const target = new URL(LOGIN_PATH, url);
    target.searchParams.set("error", error);
    if (next !== "/") target.searchParams.set("next", next);
    return see(url, `${target.pathname}${target.search}`);
  };

  if (limiter.blocked(address, now)) return back("limited");
  if (typeof password !== "string" || !passwordMatches(password, gate.password))
    return back(limiter.fail(address, now) ? "limited" : "wrong");
  limiter.reset(address);
  const response = see(url, next);
  response.headers.append("Set-Cookie", sessionCookie(issueSession(gate.password, now), secureCookie(url, env)));
  return response;
}

export function logout(request: Request, { env }: { env: Env }): Response {
  const url = new URL(request.url);
  if (!sameOrigin(request)) return Response.json({ error: "cross-origin logout refused" }, { status: 403 });
  const response = see(url, LOGIN_PATH);
  response.headers.append("Set-Cookie", clearedSessionCookie(secureCookie(url, env)));
  return response;
}

/** 303 See Other: after a form post the browser follows with a GET. */
function see(base: URL, path: string): Response {
  return new Response(null, { status: 303, headers: { Location: new URL(path, base).toString(), ...NO_STORE } });
}

/**
 * Same check as Next.js applies to server actions: a form posted from another
 * site carries an Origin whose host is not this one.
 */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  try {
    return new URL(origin).host === host.split(",")[0]?.trim();
  } catch {
    return false;
  }
}

function languageOf(request: NextRequest, env: Env): Language {
  const pick = (v: string | undefined) => {
    const tag = v?.trim().toLowerCase().slice(0, 2);
    return isLanguage(tag) ? tag : null;
  };
  return pick(request.cookies.get(LANGUAGE_COOKIE)?.value) ?? pick(env.ARMADA_DASHBOARD_LANGUAGE) ?? "en";
}

/** Fails closed: nothing from Linear, GitHub or the fleet's live data, only the variable to set. */
function unconfigured(gate: Extract<Gate, { kind: "unconfigured" }>, data: boolean, lang: Language): NextResponse {
  const t = STRINGS[lang].gate;
  const message = gate.reason === "missing" ? t.unconfigured(PASSWORD_VARIABLE) : t.offInProduction(PASSWORD_VARIABLE);
  if (data)
    return NextResponse.json({ error: message, variable: PASSWORD_VARIABLE }, { status: 503, headers: NO_STORE });
  return new NextResponse(lockedPage(lang, t.unconfiguredTitle, message), {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE },
  });
}

const html = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** A standalone page: the app, its fonts and its styles are not served while the gate is shut. */
function lockedPage(lang: Language, title: string, message: string): string {
  const code = html(PASSWORD_VARIABLE);
  const body = html(message).replace(code, `<code>${code}</code>`);
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Armada — ${html(title)}</title>
<style>
:root{color-scheme:dark light;--bg:#0a0b0d;--panel:#111317;--line:#22272e;--text:#ebe8e1;--muted:#9b9ea5;--accent:#ff8a4c}
@media (prefers-color-scheme:light){:root{--bg:#f3f1ea;--panel:#fffdf8;--line:#e2ded2;--text:#16171a;--muted:#5f6168;--accent:#c4541a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,sans-serif}
main{max-width:460px;padding:32px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}
.k{font:11px/1 ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
h1{font:400 34px/1.1 "Instrument Serif",Georgia,serif;margin:12px 0}p{margin:0;color:var(--muted)}
code{font:13px ui-monospace,monospace;color:var(--text);background:rgba(127,127,127,.14);padding:1px 5px;border-radius:4px}
</style></head>
<body><main><div class="k">Armada · 503</div><h1>${html(title)}</h1><p>${body}</p></main></body></html>`;
}
