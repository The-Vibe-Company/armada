import type { Fetch } from "./index.ts";
import { apiUrl, jsonPost, requestApi } from "./request.ts";

/** Internal session refresh endpoint. */
export function authClient(origin: string, fetch: Fetch) {
  return {
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
