import {
  AuthError,
  assertEmail,
  assertEmailCode,
  BodyTooLargeError,
  exchangeSupabaseCode,
  refreshSupabaseSession,
  type Session,
  sendEmailLink,
  supabaseAuthorizeUrl,
  verifyEmailCode,
} from "@armada/auth";
import { controlRouteKey, publicAuthOperations, signInMethod } from "@armada/core/contract";
import { LaunchError, ProviderRoutingError, VaultError } from "@armada/core/server";
import type { ControlOptions } from "./control.ts";
import { readBody } from "./control-body.ts";
import { required } from "./control-input.ts";
import { fail } from "./control-response.ts";
import { defineRoutes } from "./routes.ts";

type PublicAuthOptions = Pick<ControlOptions, "supabase" | "now" | "publicUrl" | "exchangeNative" | "refreshNative">;

/** Expose only supported sign-in methods, never upstream configuration. */
async function authMethodsRoute(_request: Request, options: PublicAuthOptions): Promise<Response> {
  try {
    const response = await (options.supabase.fetch ?? fetch)(
      new URL("/auth/v1/settings", options.supabase.supabaseUrl),
      { headers: { apikey: options.supabase.anonKey }, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw new Error();
    const settings = (await response.json()) as { external?: Record<string, unknown> };
    if (!settings.external || typeof settings.external !== "object") throw new Error();
    const methods = signInMethod.options.filter((method) => settings.external?.[method] === true);
    return Response.json({ methods }, { headers: { "cache-control": "no-store" } });
  } catch {
    return fail(503, "unavailable", "Sign-in methods are unavailable; try again later.");
  }
}

async function emailVerifyRoute(request: Request, options: PublicAuthOptions): Promise<Response> {
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
    if (error instanceof AuthError)
      return fail(error.code === "unavailable" ? 503 : error.code === "usage" ? 400 : 401, error.code, error.message);
    return fail(401, "unauthorized", "Email code was refused.");
  }
}

async function emailStartRoute(request: Request, options: PublicAuthOptions): Promise<Response> {
  try {
    const body = await readBody(request);
    const email = assertEmail(required(body, "email"));
    const parsed = publicAuthOperations.authEmailStart.input.body.parse(body);
    const { code_challenge: challenge, state, cli_email_link: cliEmailLink } = parsed;
    const callback = new URL(parsed.redirect_uri);
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
    if (error instanceof AuthError)
      return fail(
        error.code === "rate_limited" ? 429 : error.code === "unavailable" ? 503 : error.code === "usage" ? 400 : 401,
        error.code,
        error.message,
      );
    return fail(400, "invalid", "Invalid email login request.");
  }
}

async function exchangeRoute(request: Request, options: PublicAuthOptions): Promise<Response> {
  try {
    const body = await readBody(request);
    const code = required(body, "code");
    const verifier = required(body, "verifier");
    if (!publicAuthOperations.authExchange.input.body.safeParse({ code, verifier }).success)
      throw new VaultError("invalid", "Invalid login exchange.");
    const result = options.exchangeNative
      ? await options.exchangeNative(code, verifier)
      : await nativeExchange(options, code, verifier);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, "invalid", error.message);
    if (error instanceof AuthError)
      return fail(error.code === "unavailable" ? 503 : error.code === "usage" ? 400 : 401, error.code, error.message);
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

function authorizeRoute(request: Request, options: PublicAuthOptions): Response {
  const url = new URL(request.url);
  try {
    const {
      provider,
      redirect_uri,
      code_challenge: challenge,
    } = publicAuthOperations.authAuthorize.input.query.parse({
      provider: url.searchParams.get("provider"),
      redirect_uri: url.searchParams.get("redirect_uri"),
      code_challenge: url.searchParams.get("code_challenge"),
      state: url.searchParams.get("state"),
    });
    const callback = new URL(redirect_uri);
    const location = supabaseAuthorizeUrl({
      supabaseUrl: options.supabase.supabaseUrl,
      anonKey: options.supabase.anonKey,
      provider,
      redirectTo: callback.toString(),
      challenge,
    });
    return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
  } catch {
    return fail(400, "invalid", "Invalid browser login request.");
  }
}

async function refreshRoute(request: Request, options: PublicAuthOptions): Promise<Response> {
  try {
    const body = await readBody(request);
    const token = required(body, "refreshToken");
    const refreshed = options.refreshNative ? await options.refreshNative(token) : await nativeRefresh(options, token);
    return Response.json(refreshed, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, "invalid", error.message);
    if (error instanceof AuthError)
      return fail(error.code === "unavailable" ? 503 : error.code === "usage" ? 400 : 401, error.code, error.message);
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

const { authMethods, authAuthorize, authExchange, authEmailStart, authEmailVerify, authRefresh } = publicAuthOperations;

export const publicAuthRoutes = defineRoutes("public-auth", {
  [controlRouteKey(authMethods.route)]: { methods: [authMethods.route.method], respond: authMethodsRoute },
  [controlRouteKey(authAuthorize.route)]: { methods: [authAuthorize.route.method], respond: authorizeRoute },
  [controlRouteKey(authExchange.route)]: { methods: [authExchange.route.method], respond: exchangeRoute },
  [controlRouteKey(authEmailStart.route)]: { methods: [authEmailStart.route.method], respond: emailStartRoute },
  [controlRouteKey(authEmailVerify.route)]: { methods: [authEmailVerify.route.method], respond: emailVerifyRoute },
  [controlRouteKey(authRefresh.route)]: { methods: [authRefresh.route.method], respond: refreshRoute },
});
