import {
  assertEmail,
  assertEmailCode,
  assertProvider,
  BodyTooLargeError,
  exchangeSupabaseCode,
  refreshSupabaseSession,
  type Session,
  sendEmailLink,
  supabaseAuthorizeUrl,
  verifyEmailCode,
} from "@armada/auth";
import { LaunchError, ProviderRoutingError, VaultError } from "@armada/core/server";
import type { ControlOptions } from "./control.ts";
import { readBody } from "./control-body.ts";
import { required } from "./control-input.ts";
import { fail } from "./control-response.ts";

type PublicAuthOptions = Pick<ControlOptions, "supabase" | "now" | "publicUrl" | "exchangeNative" | "refreshNative">;

/** Expose only supported sign-in methods, never upstream configuration. */
export async function authMethodsRoute(request: Request, options: PublicAuthOptions): Promise<Response> {
  if (request.method !== "GET") return fail(405, "invalid", "Use GET.");
  try {
    const response = await (options.supabase.fetch ?? fetch)(
      new URL("/auth/v1/settings", options.supabase.supabaseUrl),
      { headers: { apikey: options.supabase.anonKey }, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw new Error();
    const settings = (await response.json()) as { external?: Record<string, unknown> };
    if (!settings.external || typeof settings.external !== "object") throw new Error();
    const methods = ["email", "github", "google"].filter((method) => settings.external?.[method] === true);
    return Response.json({ methods }, { headers: { "cache-control": "no-store" } });
  } catch {
    return fail(503, "unavailable", "Sign-in methods are unavailable; try again later.");
  }
}

export async function emailVerifyRoute(request: Request, options: PublicAuthOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const body = await readBody(request);
    const email = assertEmail(required(body, "email"));
    const code = assertEmailCode(required(body, "code"));
    const session = await verifyEmailCode({
      fetch: options.supabase.fetch ?? fetch,
      supabaseUrl: options.supabase.supabaseUrl,
      anonKey: options.supabase.anonKey,
      email,
      code,
      now: options.now?.() ?? new Date(),
    });
    return Response.json(
      { accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.expiresAt },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, "invalid", error.message);
    return fail(401, "unauthorized", "Email code was refused.");
  }
}

export async function emailStartRoute(request: Request, options: PublicAuthOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const body = await readBody(request);
    const email = assertEmail(required(body, "email"));
    const redirectTo = required(body, "redirect_uri");
    const challenge = required(body, "code_challenge");
    const state = required(body, "state");
    const callback = new URL(redirectTo);
    if (body.cli_email_link !== undefined && typeof body.cli_email_link !== "boolean") throw new Error();
    const cliEmailLink = body.cli_email_link === true;
    if (
      callback.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(callback.hostname) ||
      !callback.port ||
      callback.username ||
      callback.password ||
      callback.hash ||
      (cliEmailLink && (callback.pathname !== "/callback" || callback.search)) ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(challenge) ||
      !/^[A-Za-z0-9._~-]{8,512}$/.test(state)
    )
      throw new Error();
    if (cliEmailLink) callback.searchParams.set("state", state);
    await sendEmailLink({
      fetch: options.supabase.fetch ?? fetch,
      supabaseUrl: options.supabase.supabaseUrl,
      anonKey: options.supabase.anonKey,
      email,
      // Existing clients (including iOS) remain numeric-code-only unless explicitly opted in.
      redirectTo: cliEmailLink
        ? callback.toString()
        : new URL("/login?flow=code", options.publicUrl ?? "https://armada.thevibecompany.co").toString(),
      challenge,
    });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, "invalid", error.message);
    const status = error instanceof Error && error.message.includes("Too many") ? 429 : 400;
    return fail(
      status,
      status === 429 ? "rate_limited" : "invalid",
      status === 429 ? "Try again later." : "Invalid email login request.",
    );
  }
}

export async function exchangeRoute(request: Request, options: PublicAuthOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const body = await readBody(request);
    const code = required(body, "code");
    const verifier = required(body, "verifier");
    if (code.length > 4096 || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
      throw new VaultError("invalid", "Invalid login exchange.");
    const result = options.exchangeNative
      ? await options.exchangeNative(code, verifier)
      : await nativeExchange(options, code, verifier);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, "invalid", error.message);
    if (error instanceof ProviderRoutingError) return fail(503, error.code, error.message);
    if (error instanceof LaunchError)
      return fail(
        400,
        error.code,
        error.message,
        error.reason ? { reason: error.reason, action: error.action } : undefined,
      );
    if (error instanceof VaultError) return fail(400, error.code, error.message);
    return fail(401, "unauthorized", "Login exchange was refused.");
  }
}

async function nativeExchange(options: PublicAuthOptions, code: string, verifier: string) {
  const session = await exchangeSupabaseCode({
    fetch: options.supabase.fetch ?? fetch,
    supabaseUrl: options.supabase.supabaseUrl,
    anonKey: options.supabase.anonKey,
    code,
    verifier,
    now: options.now?.() ?? new Date(),
  });
  return { accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.expiresAt };
}

export function authorizeRoute(request: Request, options: PublicAuthOptions): Response {
  if (request.method !== "GET") return fail(405, "invalid", "Use GET.");
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") ?? "";
  const redirectTo = url.searchParams.get("redirect_uri") ?? "";
  const challenge = url.searchParams.get("code_challenge") ?? "";
  const state = url.searchParams.get("state") ?? "";
  try {
    assertProvider(provider);
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(challenge) || !/^[A-Za-z0-9._~-]{8,512}$/.test(state)) throw new Error();
    const callback = new URL(redirectTo);
    if (
      callback.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(callback.hostname) ||
      !callback.port ||
      callback.username ||
      callback.password ||
      callback.hash
    )
      throw new Error();
    const location = supabaseAuthorizeUrl({
      supabaseUrl: options.supabase.supabaseUrl,
      anonKey: options.supabase.anonKey,
      provider: assertProvider(provider),
      redirectTo: callback.toString(),
      challenge,
    });
    return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
  } catch {
    return fail(400, "invalid", "Invalid browser login request.");
  }
}

export async function refreshRoute(request: Request, options: PublicAuthOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const body = await readBody(request);
    const token = required(body, "refreshToken");
    const refreshed = options.refreshNative ? await options.refreshNative(token) : await nativeRefresh(options, token);
    return Response.json(refreshed, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, "invalid", error.message);
    if (error instanceof ProviderRoutingError) return fail(503, error.code, error.message);
    if (error instanceof LaunchError)
      return fail(
        400,
        error.code,
        error.message,
        error.reason ? { reason: error.reason, action: error.action } : undefined,
      );
    if (error instanceof VaultError) return fail(400, error.code, error.message);
    return fail(401, "unauthorized", "Refresh token was refused.");
  }
}

async function nativeRefresh(options: PublicAuthOptions, refreshToken: string) {
  const session: Session = {
    supabaseUrl: options.supabase.supabaseUrl,
    anonKey: options.supabase.anonKey,
    accessToken: "expired",
    refreshToken,
    expiresAt: new Date(0).toISOString(),
    userId: "",
  };
  const next = await refreshSupabaseSession({
    fetch: options.supabase.fetch ?? fetch,
    anonKey: options.supabase.anonKey,
    session,
    now: options.now?.() ?? new Date(),
  });
  return { accessToken: next.accessToken, refreshToken: next.refreshToken, expiresAt: next.expiresAt };
}
