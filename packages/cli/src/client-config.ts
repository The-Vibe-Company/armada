import { AuthError, assertSupabaseUrl } from "@armada/auth";
import { CLIENT_CONFIG_PATH, type ClientConfig } from "@armada/core";
import type { AuthIo } from "./auth-commands.ts";

export const DEFAULT_ARMADA_URL = "https://armada.thevibecompany.co";

/** HTTPS in production; plain HTTP is useful only for a local development server. */
export function serverUrl(value: string): string {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (url.username || url.password || url.search || url.hash) throw new Error();
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new AuthError("Use an HTTPS Armada URL (HTTP is allowed for localhost).", "usage");
  }
}

export async function discoverClientConfig(io: AuthIo, address: string): Promise<ClientConfig> {
  const origin = serverUrl(address);
  let response: Response;
  try {
    response = await io.fetch(new URL(CLIENT_CONFIG_PATH, origin), {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AuthError(
      `Could not discover login settings at ${origin}. Check the URL and server deployment.`,
      "unavailable",
    );
  }
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok || !isConfig(value)) {
    throw new AuthError(
      `The server at ${origin} does not provide valid Armada login settings. Update the server.`,
      "unavailable",
    );
  }
  return { ...value, supabaseUrl: assertSupabaseUrl(value.supabaseUrl), controlUrl: serverUrl(value.controlUrl) };
}

function isConfig(value: unknown): value is ClientConfig {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Record<string, unknown>;
  return (
    config.version === 1 &&
    typeof config.supabaseUrl === "string" &&
    typeof config.anonKey === "string" &&
    config.anonKey.length > 0 &&
    typeof config.controlUrl === "string" &&
    Array.isArray(config.providers) &&
    config.providers.every((provider) => provider === "github" || provider === "google")
  );
}
