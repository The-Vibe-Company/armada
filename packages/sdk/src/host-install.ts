import { DOCKER_HOST_PROTOCOL, DOCKER_HOST_PROTOCOL_HEADER } from "@armada/core";

/** Internal installer API. Keep artifact inspection and machine changes with the caller. */
export function hostInstallClient(server: string, fetch: (input: string, init?: RequestInit) => Promise<Response>) {
  async function request(path: string, init?: RequestInit) {
    const url = `${server}${path}`;
    const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
    return { response, valid: response.ok && !response.redirected && (!response.url || response.url === url) };
  }

  return {
    manifest: () => request("/api/docker-host/install.json"),
    artifact: (digest: string) => request(`/api/runtime/artifacts/${digest}`),
    reuseRegistration: (token: string, hostId: string) =>
      request("/api/docker-host/reuse-registration", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [DOCKER_HOST_PROTOCOL_HEADER]: String(DOCKER_HOST_PROTOCOL),
        },
        body: JSON.stringify({ hostId }),
      }),
  };
}
