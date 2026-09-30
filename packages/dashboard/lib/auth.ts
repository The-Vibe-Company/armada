// The dashboard's password gate, as pure functions over an injected environment
// and clock: which mode the deployment is in, the signed session cookie, the
// password check and the per-address limit on wrong passwords. `proxy.ts`, the
// login routes and `requireSession` share them. The password never leaves the server.
import { createHash, createHmac, scryptSync, timingSafeEqual } from "node:crypto";

export const PASSWORD_VARIABLE = "ARMADA_DASHBOARD_PASSWORD";
export const SESSION_COOKIE = "armada-session";
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
export const LOGIN_PATH = "/login";
export const LOGIN_ROUTE = "/api/auth/login";
export const LOGOUT_ROUTE = "/api/auth/logout";

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * What the deployment asks of a viewer. `unconfigured` fails closed: the
 * dashboard serves nothing and names the variable to set.
 */
export type Gate =
  | { kind: "password"; password: string }
  | { kind: "off" }
  | { kind: "unconfigured"; reason: "missing" | "off-in-production" };

export function gateOf(env: Env): Gate {
  const value = env[PASSWORD_VARIABLE];
  if (!value?.trim()) return { kind: "unconfigured", reason: "missing" };
  if (value.trim().toLowerCase() === "off")
    // The opt-out is for local development only: production never runs open.
    return env.NODE_ENV === "production" ? { kind: "unconfigured", reason: "off-in-production" } : { kind: "off" };
  return { kind: "password", password: value };
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest();

/** Constant-time: both sides are hashed to the same length before the comparison. */
export function passwordMatches(input: string, password: string): boolean {
  return timingSafeEqual(sha256(input), sha256(password));
}

// The signing key is derived from the password, so a new password invalidates
// every session. scrypt makes a stolen cookie expensive to brute-force offline;
// it runs once per password per process.
let derived: { password: string; key: Buffer } | null = null;
function sessionKey(password: string): Buffer {
  if (derived?.password !== password)
    derived = { password, key: scryptSync(password, "armada-dashboard/session/v1", 32) };
  return derived.key;
}

const sign = (password: string, payload: string) =>
  createHmac("sha256", sessionKey(password)).update(payload).digest("base64url");

/** A session cookie value: `v1.<expiry ms>.<HMAC-SHA256 of "v1.<expiry ms>">`. */
export function issueSession(password: string, now: number): string {
  const payload = `v1.${now + SESSION_MAX_AGE_S * 1000}`;
  return `${payload}.${sign(password, payload)}`;
}

const SESSION_SHAPE = /^v1\.(\d{1,15})\.([A-Za-z0-9_-]{43})$/;

export function validSession(value: string | undefined, password: string, now: number): boolean {
  const match = value ? SESSION_SHAPE.exec(value) : null;
  if (!match) return false;
  const [, expires = "", mac = ""] = match;
  if (Number(expires) <= now) return false;
  const expected = sign(password, `v1.${expires}`);
  return timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
}

/** Secure everywhere but plain-http local development, where the browser would drop the cookie. */
export function secureCookie(url: URL, env: Env): boolean {
  return env.NODE_ENV === "production" || url.protocol === "https:";
}

export function sessionCookie(value: string, secure: boolean): string {
  return cookie(value, SESSION_MAX_AGE_S, secure);
}

export function clearedSessionCookie(secure: boolean): string {
  return cookie("", 0, secure);
}

const cookie = (value: string, maxAge: number, secure: boolean) =>
  `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;

/** A local path to return to after the login; anything else (another origin, the login itself) is "/". */
export function safeNext(next: unknown, base: URL): string {
  // "//host", "/\\host" and tab or newline tricks all parse to another origin below.
  if (typeof next !== "string" || !next.startsWith("/")) return "/";
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return "/";
  }
  if (url.origin !== base.origin || url.pathname === LOGIN_PATH || url.pathname.startsWith("/api/")) return "/";
  return `${url.pathname}${url.search}`;
}

/** The viewer's address as the platform reports it (Vercel sets x-forwarded-for itself). */
export function clientAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Wrong passwords per address in a fixed window. In memory: each server
 * instance counts on its own, which is enough to slow a guesser down.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, { count: number; until: number }>();

  constructor(
    readonly max = 5,
    readonly windowMs = 15 * 60_000,
    private readonly capacity = 10_000,
  ) {}

  blocked(address: string, now: number): boolean {
    const entry = this.failures.get(address);
    if (!entry) return false;
    if (entry.until <= now) {
      this.failures.delete(address);
      return false;
    }
    return entry.count >= this.max;
  }

  /** Records a wrong password; true when the address is now blocked. */
  fail(address: string, now: number): boolean {
    const entry = this.failures.get(address);
    if (entry && entry.until > now) entry.count += 1;
    else {
      this.makeRoom(now);
      this.failures.set(address, { count: 1, until: now + this.windowMs });
    }
    return this.blocked(address, now);
  }

  reset(address: string): void {
    this.failures.delete(address);
  }

  private makeRoom(now: number) {
    if (this.failures.size < this.capacity) return;
    for (const [address, entry] of this.failures) if (entry.until <= now) this.failures.delete(address);
    // Still full: forget the oldest window (a Map iterates in insertion order).
    while (this.failures.size >= this.capacity) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }
}
