import { organizationOperations } from "@armada/core/contract";
import { publicAuthOperations } from "@armada/core/contract/public-auth";
import type { Fetch } from "./index.ts";
import { apiUrl, jsonPost, requestApi } from "./request.ts";

/** Internal transport for CLI authentication and organization selection. */
export function authClient(origin: string, fetch: Fetch) {
  const { authDeviceStart, authDevicePoll } = publicAuthOperations;
  const { listOrganizations } = organizationOperations;
  function post(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal, token?: string) {
    return requestApi(apiUrl(origin, path), jsonPost(body), {
      fetch,
      timeoutMs,
      signal,
      combineSignal: true,
      ...(token !== undefined ? { token } : {}),
    });
  }

  return {
    startDevice(hostname: string, timeoutMs: number) {
      return post(authDeviceStart.route.path, { hostname }, timeoutMs);
    },
    pollDevice(deviceCode: string, timeoutMs: number) {
      return post(authDevicePoll.route.path, { device_code: deviceCode }, timeoutMs);
    },
    listOrganizations(accessToken: string, timeoutMs: number) {
      return post(listOrganizations.route.path, {}, timeoutMs, undefined, accessToken);
    },
    refresh(refreshToken: string, timeoutMs: number, signal?: AbortSignal) {
      return post("/api/v1/auth/refresh", { refreshToken }, timeoutMs, signal);
    },
  };
}
