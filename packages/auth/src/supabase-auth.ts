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
  return requestSession(options, { auth_code: options.code, code_verifier: options.verifier }, "pkce");
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
    "refresh_token",
  );
}

async function requestSession(
  options: { fetch: AuthFetch; supabaseUrl: string; anonKey: string; now: Date },
  body: Record<string, string>,
  grant: "pkce" | "refresh_token",
): Promise<Session> {
  let response: Response;
  try {
    response = await options.fetch(`${options.supabaseUrl}/auth/v1/token?grant_type=${grant}`, {
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
