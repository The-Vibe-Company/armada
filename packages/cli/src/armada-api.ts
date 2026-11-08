import { AuthError, type SessionStore } from "@armada/auth";

export const DEFAULT_ARMADA_API_URL = "https://armada.thevibecompany.co";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ArmadaApiIo {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  session: SessionStore;
  timeoutMs?: number;
}

export interface ArmadaApiOptions {
  /** The CLI --url value. It takes precedence over ARMADA_URL and a saved session origin. */
  url?: string;
}

/** A deliberately small client for Armada's HTTP API. It never contacts an auth/database provider. */
export interface ArmadaApiClient {
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

/**
 * Create an authenticated client for Armada's own API.
 *
 * ARMADA_TOKEN is intentionally checked before the saved session, allowing automation with a
 * clean HOME. A saved login is the fallback. The token is never retained in thrown errors.
 */
export async function createArmadaApiClient(io: ArmadaApiIo, options: ArmadaApiOptions = {}): Promise<ArmadaApiClient> {
  const origin = armadaApiUrl(options.url ?? io.env.ARMADA_URL ?? (await io.session.read())?.armadaUrl);
  const token = io.env.ARMADA_TOKEN || (await io.session.read())?.accessToken;
  if (!token) throw new AuthError("Set ARMADA_TOKEN or run armada login.", "unauthorized");
  const timeoutMs = io.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async request<T>(path: string, init: RequestInit = {}): Promise<T> {
      const url = apiUrl(origin, path);
      let response: Response;
      try {
        response = await io.fetch(url, {
          ...init,
          headers: {
            ...headers(init.headers),
            authorization: `Bearer ${token}`,
            accept: "application/json",
          },
          redirect: "error",
          signal: init.signal ?? AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new AuthError("Armada could not reach the server.", "unavailable");
      }

      const payload: unknown = await response.json().catch(() => null);
      if (response.ok) return payload as T;
      if (response.status === 401) throw new AuthError("Run armada login or update ARMADA_TOKEN.", "unauthorized");
      if (response.status === 403) throw new AuthError("Armada refused this request.", "conflict");
      throw new AuthError(`Armada server request failed (${response.status}).`, "unavailable");
    },
  };
}

/** Accept only an HTTP(S) origin; this prevents provider URLs from becoming API targets. */
export function armadaApiUrl(value: string | undefined): string {
  const address = value || DEFAULT_ARMADA_API_URL;
  try {
    const url = new URL(address.includes("://") ? address : `https://${address}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    return url.origin;
  } catch {
    throw new AuthError("Use an HTTP(S) Armada API URL.", "usage");
  }
}

function apiUrl(origin: string, path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//")) throw new AuthError("API paths must start with '/'.", "usage");
  return new URL(path, origin);
}

function headers(value: RequestInit["headers"]): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(new Headers(value).entries());
}
