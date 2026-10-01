import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { FailureLimiter, issueSession, SESSION_COOKIE, SESSION_MAX_AGE_S, safeNext } from "../lib/auth.ts";
import { guard, login, logout } from "../lib/auth-http.ts";

// A synthetic password, used by these tests only.
const PASSWORD = "correct horse battery staple";
const PROD = { NODE_ENV: "production", ARMADA_DASHBOARD_PASSWORD: PASSWORD };
const T0 = Date.parse("2026-03-04T10:00:00Z");
const BASE = "https://fleet.example.test";

function request(path: string, init: { method?: string; headers?: Record<string, string>; session?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.session) headers.set("cookie", `${SESSION_COOKIE}=${init.session}`);
  return new NextRequest(`${BASE}${path}`, { method: init.method ?? "GET", headers });
}

function loginPost(password: string, opts: { next?: string; ip?: string; origin?: string } = {}) {
  const body = new URLSearchParams({ password, next: opts.next ?? "/" });
  return new Request(`${BASE}/api/auth/login`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": opts.ip ?? "203.0.113.7",
      origin: opts.origin ?? BASE,
      host: new URL(BASE).host,
    },
  });
}

const passed = (res: Response) => res.headers.get("x-middleware-next") === "1";
const rewrittenTo = (res: Response) => new URL(res.headers.get("x-middleware-rewrite") ?? "", BASE).pathname;
const sessionFrom = (res: Response) => /armada-session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1];

describe("the proxy without a session", () => {
  const deps = { env: PROD, now: T0 };

  test("sends a page to the login page, keeping where the viewer was going", () => {
    const res = guard(request("/?project=widgets"), deps);
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/?project=widgets");
  });

  test("shows the landing on / and lets the landing and its assets through", () => {
    for (const method of ["GET", "HEAD"]) expect(rewrittenTo(guard(request("/", { method }), deps))).toBe("/landing");
    expect(passed(guard(request("/landing"), deps))).toBe(true);
    expect(passed(guard(request("/landing/opengraph-image"), deps))).toBe(true);
    // Only the bare /: every other page still asks for the password.
    expect(guard(request("/agents"), deps).status).toBe(307);
    expect(guard(request("/landingx"), deps).status).toBe(307);
  });

  test("answers 401 to the polling route and to a server action, with no data", async () => {
    for (const res of [
      guard(request("/api/fleet"), deps),
      guard(request("/", { method: "POST", headers: { "next-action": "7f00aa" } }), deps),
    ]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("lets the login page, the login and logout routes and the webhooks (signed, not signed in) through", () => {
    expect(passed(guard(request("/api/webhooks/linear", { method: "POST" }), deps))).toBe(true);
    expect(passed(guard(request("/api/webhooks/github", { method: "POST" }), deps))).toBe(true);
    expect(passed(guard(request("/login"), deps))).toBe(true);
    expect(passed(guard(request("/api/auth/login", { method: "POST" }), deps))).toBe(true);
    expect(passed(guard(request("/api/auth/logout", { method: "POST" }), deps))).toBe(true);
  });

  test("refuses an expired, forged or old-password session", () => {
    const expired = issueSession(PASSWORD, T0 - SESSION_MAX_AGE_S * 1000 - 1);
    const forged = `v1.${T0 + 60_000}.${"A".repeat(43)}`;
    const oldPassword = issueSession("an earlier password", T0);
    for (const session of [expired, forged, oldPassword, "garbage"])
      expect(guard(request("/api/fleet", { session }), deps).status).toBe(401);
  });
});

describe("the proxy with a session", () => {
  test("passes pages, the polling route and server actions, and skips the login page", () => {
    const session = issueSession(PASSWORD, T0);
    const deps = { env: PROD, now: T0 + 60_000 };
    expect(passed(guard(request("/", { session }), deps))).toBe(true);
    expect(passed(guard(request("/api/fleet", { session }), deps))).toBe(true);
    expect(passed(guard(request("/", { method: "POST", headers: { "next-action": "7f00aa" }, session }), deps))).toBe(
      true,
    );
    const res = guard(request("/login", { session }), deps);
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/");
  });
});

describe("fail closed", () => {
  test("a production server with no password serves nothing and names the variable", async () => {
    for (const env of [{ NODE_ENV: "production" }, { NODE_ENV: "production", ARMADA_DASHBOARD_PASSWORD: " " }]) {
      const page = guard(request("/"), { env, now: T0 });
      expect(page.status).toBe(503);
      expect(await page.text()).toContain("ARMADA_DASHBOARD_PASSWORD");
      const data = guard(request("/api/fleet"), { env, now: T0 });
      expect(data.status).toBe(503);
      expect((await data.json()).variable).toBe("ARMADA_DASHBOARD_PASSWORD");
      expect(guard(request("/login"), { env, now: T0 }).status).toBe(503);
    }
  });

  test("the off switch opens the dashboard in development only", () => {
    const off = { ARMADA_DASHBOARD_PASSWORD: "off" };
    expect(passed(guard(request("/api/fleet"), { env: { ...off, NODE_ENV: "development" }, now: T0 }))).toBe(true);
    expect(guard(request("/api/fleet"), { env: { ...off, NODE_ENV: "production" }, now: T0 }).status).toBe(503);
  });
});

describe("login", () => {
  const deps = () => ({ env: PROD, now: T0, limiter: new FailureLimiter() });

  test("the right password sets a signed HttpOnly, Secure, SameSite=Lax cookie the proxy accepts", async () => {
    const res = await login(loginPost(PASSWORD, { next: "/?project=widgets" }), deps());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${BASE}/?project=widgets`);
    const cookie = res.headers.get("set-cookie") ?? "";
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(cookie).toContain(attribute);
    const session = sessionFrom(res);
    expect(passed(guard(request("/api/fleet", { session }), { env: PROD, now: T0 + 1000 }))).toBe(true);
    // A new password logs everyone out.
    const rotated = { NODE_ENV: "production", ARMADA_DASHBOARD_PASSWORD: "a new synthetic password" };
    expect(guard(request("/api/fleet", { session }), { env: rotated, now: T0 + 1000 }).status).toBe(401);
  });

  test("a wrong password is rejected without a cookie", async () => {
    const res = await login(loginPost("not the password"), deps());
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("error")).toBe("wrong");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("after five wrong passwords, the address is refused even the right one until the window ends", async () => {
    const d = deps();
    for (let i = 0; i < 5; i++) await login(loginPost("guess"), d);
    const blocked = await login(loginPost(PASSWORD), d);
    expect(new URL(blocked.headers.get("location") ?? "").searchParams.get("error")).toBe("limited");
    expect(blocked.headers.get("set-cookie")).toBeNull();
    // Another address is not affected, and the window ends.
    expect(sessionFrom(await login(loginPost(PASSWORD, { ip: "198.51.100.4" }), d))).toBeTruthy();
    const later = { ...d, now: T0 + d.limiter.windowMs };
    expect(sessionFrom(await login(loginPost(PASSWORD), later))).toBeTruthy();
  });

  test("a form posted from another site is refused", async () => {
    const res = await login(loginPost(PASSWORD, { origin: "https://elsewhere.example" }), deps());
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("returns only to a local path", () => {
    const base = new URL(BASE);
    expect(safeNext("/?project=a", base)).toBe("/?project=a");
    for (const next of [
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "/.//evil.example",
      "/%2e//evil.example",
      "https://evil.example",
      "/login",
    ])
      expect(safeNext(next, base)).toBe("/");
  });

  test("logout clears the cookie, from this site only", () => {
    const post = (origin: string) =>
      new Request(`${BASE}/api/auth/logout`, { method: "POST", headers: { origin, host: new URL(BASE).host } });
    const res = logout(post(BASE), { env: PROD });
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(logout(post("https://elsewhere.example"), { env: PROD }).status).toBe(403);
  });
});
