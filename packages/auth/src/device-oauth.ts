import { createHmac } from "node:crypto";
import { AuthError } from "./errors.ts";
import { s256 } from "./pkce.ts";
import type { AuthFetch } from "./types.ts";

export const DEVICE_REFRESH_PREFIX = "cli-oauth.";

export function createDeviceOAuth(clientId: string, clientSecret: string, redirectUri: string) {
  const verifier = (id: string) =>
    createHmac("sha256", clientSecret).update(`armada-cli-pkce:${id}`).digest("base64url");

  return (upstream: { fetch?: AuthFetch; supabaseUrl: string; anonKey: string }, now: Date) => {
    async function request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set("apikey", upstream.anonKey);
      headers.set("accept", "application/json");
      return (upstream.fetch ?? fetch)(new URL(`/auth/v1${path}`, upstream.supabaseUrl).href, {
        ...init,
        headers,
        redirect: init.redirect ?? "error",
        signal: AbortSignal.timeout(10_000),
      });
    }

    async function token(params: Record<string, string>) {
      let response: Response;
      try {
        response = await request("/oauth/token", {
          method: "POST",
          body: new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret }),
        });
      } catch {
        throw unavailable();
      }
      if (!response.ok) {
        if (response.status === 400 || response.status === 401) {
          throw new AuthError("The CLI session was refused. Sign in again.", "unauthorized");
        }
        throw unavailable();
      }
      const value = await json(response);
      const { access_token, refresh_token, expires_in } = value;
      if (
        typeof access_token !== "string" ||
        !access_token ||
        typeof refresh_token !== "string" ||
        !refresh_token ||
        typeof expires_in !== "number" ||
        !Number.isFinite(expires_in) ||
        expires_in <= 0
      )
        throw unavailable();
      return {
        accessToken: access_token,
        refreshToken: DEVICE_REFRESH_PREFIX + refresh_token,
        expiresAt: new Date(now.getTime() + expires_in * 1000).toISOString(),
      };
    }

    return {
      async approve(id: string, userId: string, authorization: string) {
        const state = crypto.randomUUID();
        const query = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "openid",
          state,
          code_challenge: await s256(verifier(id)),
          code_challenge_method: "S256",
        });
        const start = await request(`/oauth/authorize?${query}`, { redirect: "manual" });
        const location = start.headers.get("location");
        if (start.status !== 302 || !location) throw unavailable();
        const authorizationId = new URL(location).searchParams.get("authorization_id");
        if (!authorizationId) throw unavailable();
        const path = `/oauth/authorizations/${encodeURIComponent(authorizationId)}`;
        const headers = { authorization };
        let result = await json(await request(path, { headers }));
        if (typeof result.redirect_url !== "string") {
          if (
            record(result.user).id !== userId ||
            record(result.client).id !== clientId ||
            result.redirect_uri !== redirectUri
          )
            throw unavailable();
          result = await json(
            await request(`${path}/consent`, {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({ action: "approve" }),
            }),
          );
        }
        if (typeof result.redirect_url !== "string") throw unavailable();
        const callback = new URL(result.redirect_url);
        const { searchParams } = callback;
        const code = searchParams.get("code");
        const returnedState = searchParams.get("state");
        const denied = searchParams.has("error");
        callback.search = "";
        if (callback.href !== redirectUri || returnedState !== state || !code || denied) throw unavailable();
        return code;
      },

      async exchange(id: string, code: string, userId: string) {
        const session = await token({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier(id),
        });
        const user = await json(
          await request("/user", { headers: { authorization: `Bearer ${session.accessToken}` } }),
        );
        if (user.id !== userId || typeof user.email !== "string" || !user.email) throw unavailable();
        return { ...session, email: user.email };
      },

      refresh(refreshToken: string) {
        return token({
          grant_type: "refresh_token",
          refresh_token: refreshToken.slice(DEVICE_REFRESH_PREFIX.length),
        });
      },
    };
  };
}

function unavailable() {
  return new AuthError("The CLI session could not be established with the sign-in service.", "unavailable");
}

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}

async function json(response: Response) {
  if (!response.ok) throw unavailable();
  try {
    return record(await response.json());
  } catch {
    throw unavailable();
  }
}
