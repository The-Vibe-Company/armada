import type { Fetch } from "./index.ts";
import { apiUrl, jsonPost, requestApi } from "./request.ts";

/** Internal sign-in endpoints. The CLI owns the browser, callback and session storage. */
export function authClient(origin: string, fetch: Fetch) {
  return {
    methods() {
      return fetch(new URL("/api/v1/auth/methods", origin), {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      });
    },
    authorize(params: { provider: string; redirect_uri: string; code_challenge: string; state: string }) {
      const url = new URL("/api/v1/auth/authorize", origin);
      url.search = new URLSearchParams(params).toString();
      return url.toString();
    },
    exchange(body: { code: string; verifier: string }) {
      return fetch(new URL("/api/v1/auth/exchange", origin), {
        ...jsonPost(body),
        headers: { "content-type": "application/json", accept: "application/json" },
      });
    },
    email(operation: "exchange" | "email/start" | "email/verify", body: unknown, signal: AbortSignal) {
      return fetch(new URL(`/api/v1/auth/${operation}`, origin), {
        ...jsonPost(body),
        signal,
        redirect: "error",
      });
    },
    refresh(refreshToken: string, timeoutMs: number, signal?: AbortSignal) {
      return requestApi(apiUrl(origin, "/api/v1/auth/refresh"), jsonPost({ refreshToken }), {
        fetch,
        timeoutMs,
        signal,
        combineSignal: true,
      });
    },
  };
}
