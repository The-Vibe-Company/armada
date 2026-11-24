import { assertProvider, assertSupabaseUrl, type Provider, resourceUrl } from "@armada/auth";
import { DEFAULT_SANDBOX_EXTENSION_HEADROOM_SECONDS, SANDBOX_STOP_MARGIN_SECONDS } from "@armada/core";
import { capabilities } from "@armada/core/machine-capabilities";
import { ServerConfigError } from "./server-config-error.ts";

export interface ServerConfig {
  sandboxExtensionHeadroomSeconds: number;
  port: number;
  supabaseUrl: string;
  anonKey: string;
  authSecret: string;
  loginProviders: Provider[];
  /** Origin only. The MCP resource is this plus `/mcp`. */
  publicUrl: string;
  /** Separately configured dashboard origin; never taken from an HTTP return target. */
  dashboardUrl: string;
  /** Explicit local development; never inferred by a downstream helper from process globals. */
  development: boolean;
  encryptionKey: string;
  /** Privileged Postgres connection (the Supabase `postgres` role), shared with the control API. */
  databaseUrl: string;
  databasePoolMax: number;
}

export function boatDeploymentId(override: string | undefined, publicUrl: string) {
  return override?.trim() || new URL(resourceUrl(publicUrl)).origin;
}

const DEFAULT_DASHBOARD_URL = "https://armada.thevibecompany.co";

/** Fixed deployment configuration, never taken from a request or OAuth return URL. */
export function dashboardOrigin(value: string = DEFAULT_DASHBOARD_URL, development = false): string {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      !(url.protocol === "https:" || (development && loopback && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      /[?#]/.test(value)
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new ServerConfigError(
      "ARMADA_DASHBOARD_URL must be an HTTPS origin without credentials, path, query or fragment.",
    );
  }
}

const REQUIRED = [
  "ARMADA_DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "ARMADA_AUTH_SECRET",
  "ARMADA_PUBLIC_URL",
  "ARMADA_ENCRYPTION_KEY",
] as const;

export const DEFAULT_PORT = 8080;

const KEY_BYTES = 32;

/** Throws when the key is not 32 bytes of base64. The message never holds the key. */
function checkEncryptionKey(base64Key: string): void {
  let length: number;
  try {
    length = Uint8Array.from(atob(base64Key.trim()), (char) => char.charCodeAt(0)).length;
  } catch {
    throw new ServerConfigError("ARMADA_ENCRYPTION_KEY is not valid base64.");
  }
  if (length !== KEY_BYTES) throw new ServerConfigError(`ARMADA_ENCRYPTION_KEY must be ${KEY_BYTES} bytes in base64.`);
}

/** Main pool only; one additional autonomous connection is budgeted separately. */
export function databasePoolMax(value: string | undefined): number {
  if (value === undefined) return 3;
  if (!/^[0-9]+$/.test(value.trim())) throw new ServerConfigError("ARMADA_DATABASE_POOL_MAX must be an integer >= 2.");
  const max = Number(value);
  if (!Number.isSafeInteger(max) || max < 2)
    throw new ServerConfigError("ARMADA_DATABASE_POOL_MAX must be an integer >= 2.");
  return max;
}

/** Reads and checks the server's environment. Messages name a variable, never its value. */
export function configFromEnv(env: Record<string, string | undefined>): ServerConfig {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new ServerConfigError(`Set ${missing.join(", ")}.`);
  const value = (name: (typeof REQUIRED)[number]) => (env[name] ?? "").trim();

  const port = env.PORT?.trim() ? Number(env.PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new ServerConfigError("PORT must be a TCP port number.");
  if (value("ARMADA_AUTH_SECRET").length < 16)
    throw new ServerConfigError("ARMADA_AUTH_SECRET must be at least 16 characters.");
  checkEncryptionKey(value("ARMADA_ENCRYPTION_KEY"));
  let publicUrl: string;
  let supabaseUrl: string;
  const databaseUrl = value("ARMADA_DATABASE_URL");
  try {
    publicUrl = new URL(resourceUrl(value("ARMADA_PUBLIC_URL"))).origin;
  } catch {
    throw new ServerConfigError("ARMADA_PUBLIC_URL must be an origin.");
  }
  try {
    supabaseUrl = assertSupabaseUrl(value("SUPABASE_URL"));
  } catch {
    throw new ServerConfigError("SUPABASE_URL must be an HTTPS origin.");
  }
  try {
    const database = new URL(databaseUrl);
    if (!["postgres:", "postgresql:"].includes(database.protocol)) throw new Error();
  } catch {
    throw new ServerConfigError("ARMADA_DATABASE_URL must be a PostgreSQL URL.");
  }
  const sandboxExtensionHeadroomSeconds = env.ARMADA_SANDBOX_EXTENSION_HEADROOM_SECONDS?.trim()
    ? Number(env.ARMADA_SANDBOX_EXTENSION_HEADROOM_SECONDS)
    : DEFAULT_SANDBOX_EXTENSION_HEADROOM_SECONDS;
  if (
    !Number.isSafeInteger(sandboxExtensionHeadroomSeconds) ||
    sandboxExtensionHeadroomSeconds < 0 ||
    sandboxExtensionHeadroomSeconds > capabilities("modal").maxTtlSeconds - SANDBOX_STOP_MARGIN_SECONDS
  )
    throw new ServerConfigError(
      "ARMADA_SANDBOX_EXTENSION_HEADROOM_SECONDS must be a non-negative whole number within the Modal lifetime limit minus stop margin.",
    );

  if (env.ARMADA_MODAL_DIALOUT !== "1" || !env.ARMADA_MODAL_RUNTIME_MANIFEST?.trim())
    throw new ServerConfigError("Modal requires ARMADA_MODAL_DIALOUT=1 and ARMADA_MODAL_RUNTIME_MANIFEST.");

  const providers = (env.ARMADA_AUTH_PROVIDERS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  let loginProviders: Provider[];
  try {
    loginProviders = providers.map(assertProvider);
  } catch {
    throw new ServerConfigError("ARMADA_AUTH_PROVIDERS must list supported login providers.");
  }
  const development = env.NODE_ENV === "development";

  return {
    sandboxExtensionHeadroomSeconds,
    port,
    supabaseUrl,
    anonKey: value("SUPABASE_ANON_KEY"),
    authSecret: value("ARMADA_AUTH_SECRET"),
    loginProviders,
    publicUrl,
    dashboardUrl: dashboardOrigin(env.ARMADA_DASHBOARD_URL?.trim() || undefined, development),
    development,
    encryptionKey: value("ARMADA_ENCRYPTION_KEY"),
    databaseUrl,
    databasePoolMax: databasePoolMax(env.ARMADA_DATABASE_POOL_MAX),
  };
}
