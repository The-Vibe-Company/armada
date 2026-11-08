import { UUID_PATTERN } from "./codec.ts";
import { AuthError } from "./errors.ts";
import type { Session } from "./session.ts";
import type { AuthFetch } from "./types.ts";

export type Provider = "github" | "google";

export function assertProvider(value: string): Provider {
  if (value === "github" || value === "google") return value;
  throw new AuthError("The provider is github or google.", "usage");
}

/** Supabase project origin. Local http is allowed for `supabase start`. */
export function assertSupabaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AuthError("SUPABASE_URL must be https.", "usage");
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  const allowed = parsed.protocol === "https:" || (parsed.protocol === "http:" && local);
  if (!allowed || (parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search !== "" || parsed.hash !== "") {
    throw new AuthError("SUPABASE_URL must be https.", "usage");
  }
  return parsed.origin;
}

export function supabaseAuthorizeUrl(options: {
  supabaseUrl: string;
  anonKey: string;
  provider: Provider;
  redirectTo: string;
  challenge: string;
}): string {
  const url = new URL("/auth/v1/authorize", options.supabaseUrl);
  url.searchParams.set("provider", options.provider);
  url.searchParams.set("redirect_to", options.redirectTo);
  url.searchParams.set("code_challenge", options.challenge);
  url.searchParams.set("code_challenge_method", "s256");
  url.searchParams.set("apikey", options.anonKey);
  return url.toString();
}

export async function exchangeSupabaseCode(options: {
  fetch: AuthFetch;
  supabaseUrl: string;
  anonKey: string;
  code: string;
  verifier: string;
  now: Date;
}): Promise<Session> {
  return requestSession(
    options,
    { auth_code: options.code, code_verifier: options.verifier },
    "/auth/v1/token?grant_type=pkce",
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_CODE = /^\d{6,10}$/;

export function assertEmail(value: string): string {
  const email = value.trim();
  if (email.length > 254 || !EMAIL.test(email)) throw new AuthError("Give a valid email address.", "usage");
  return email;
}

/** The digits of the code in the sign-in email, without the spaces some clients add. */
export function assertEmailCode(value: string): string {
  const code = value.replace(/\s+/g, "");
  if (!EMAIL_CODE.test(code)) throw new AuthError("The code is the 6 to 10 digits in the email.", "usage");
  return code;
}

/**
 * Asks Supabase to email a sign-in link (and a one-time code, when the template carries one). The link
 * comes back to `redirectTo` with a PKCE code. An address that has not signed in yet gets an account,
 * as on the dashboard.
 */
export async function sendEmailLink(options: {
  fetch: AuthFetch;
  supabaseUrl: string;
  anonKey: string;
  email: string;
  redirectTo: string;
  challenge: string;
}): Promise<void> {
  let response: Response;
  try {
    response = await options.fetch(
      `${options.supabaseUrl}/auth/v1/otp?redirect_to=${encodeURIComponent(options.redirectTo)}`,
      {
        method: "POST",
        headers: { apikey: options.anonKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          email: options.email,
          create_user: true,
          code_challenge: options.challenge,
          code_challenge_method: "s256",
        }),
      },
    );
  } catch (error) {
    throw new AuthError("Armada could not reach Supabase.", "unavailable", error);
  }
  if (response.status === 429)
    throw new AuthError("Too many sign-in emails. Wait a minute and try again.", "unavailable");
  if (!response.ok) {
    throw new AuthError(
      "Supabase could not send the sign-in email.",
      "unavailable",
      new Error(`HTTP ${response.status}`),
    );
  }
}

/** Trades the one-time code of a sign-in email for a session. */
export async function verifyEmailCode(options: {
  fetch: AuthFetch;
  supabaseUrl: string;
  anonKey: string;
  email: string;
  code: string;
  now: Date;
}): Promise<Session> {
  return requestSession(options, { type: "email", email: options.email, token: options.code }, "/auth/v1/verify");
}

export async function refreshSupabaseSession(options: {
  fetch: AuthFetch;
  anonKey: string;
  session: Session;
  now: Date;
}): Promise<Session> {
  return requestSession(
    {
      fetch: options.fetch,
      supabaseUrl: options.session.supabaseUrl,
      anonKey: options.anonKey,
      now: options.now,
    },
    { refresh_token: options.session.refreshToken },
    "/auth/v1/token?grant_type=refresh_token",
  );
}

async function requestSession(
  options: { fetch: AuthFetch; supabaseUrl: string; anonKey: string; now: Date },
  body: Record<string, string>,
  path: string,
): Promise<Session> {
  let response: Response;
  try {
    response = await options.fetch(`${options.supabaseUrl}${path}`, {
      method: "POST",
      headers: { apikey: options.anonKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthError("Armada could not reach Supabase.", "unavailable");
  }
  if (!response.ok) throw new AuthError("Login failed.", "unauthorized");
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AuthError("Login failed.", "unauthorized");
  }
  return sessionFrom(payload, options.supabaseUrl, options.now);
}

function sessionFrom(payload: unknown, supabaseUrl: string, now: Date): Session {
  if (!isRecord(payload) || !isRecord(payload.user)) throw new AuthError("Login failed.", "unauthorized");
  const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } = payload;
  const userId = payload.user.id;
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof refreshToken !== "string" ||
    refreshToken.length === 0 ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    typeof userId !== "string" ||
    !UUID_PATTERN.test(userId)
  ) {
    throw new AuthError("Login failed.", "unauthorized");
  }
  return {
    supabaseUrl,
    accessToken,
    refreshToken,
    expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    userId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
