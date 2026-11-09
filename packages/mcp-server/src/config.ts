import { resourceUrl } from "@armada/auth";
import { type OrchestratorPair, orchestratorPairsFromEnv } from "./orchestrator-activation.ts";

export interface ServerConfig {
  port: number;
  orchestratorPairs: readonly OrchestratorPair[];
  supabaseUrl: string;
  anonKey: string;
  authSecret: string;
  /** Origin only. The MCP resource is this plus `/mcp`. */
  publicUrl: string;
  /** Separately configured dashboard origin; never taken from an HTTP return target. */
  dashboardUrl: string;
  /** Explicit local development; never inferred by a downstream helper from process globals. */
  development: boolean;
  encryptionKey: string;
  /** Privileged Postgres connection (the Supabase `postgres` role), shared with the control API. */
  databaseUrl: string;
}

export const DEFAULT_DASHBOARD_URL = "https://armada.thevibecompany.co";

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
    throw new Error("ARMADA_DASHBOARD_URL must be an HTTPS origin without credentials, path, query or fragment.");
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
export function checkEncryptionKey(base64Key: string): void {
  let length: number;
  try {
    length = Uint8Array.from(atob(base64Key.trim()), (char) => char.charCodeAt(0)).length;
  } catch {
    throw new Error("ARMADA_ENCRYPTION_KEY is not valid base64.");
  }
  if (length !== KEY_BYTES) throw new Error(`ARMADA_ENCRYPTION_KEY must be ${KEY_BYTES} bytes in base64.`);
}

/** Reads and checks the server's environment. Messages name a variable, never its value. */
export function configFromEnv(env: Record<string, string | undefined>): ServerConfig {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new Error(`Set ${missing.join(", ")}.`);
  const value = (name: (typeof REQUIRED)[number]) => (env[name] ?? "").trim();

  const port = env.PORT?.trim() ? Number(env.PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a TCP port number.");
  if (value("ARMADA_AUTH_SECRET").length < 16) throw new Error("ARMADA_AUTH_SECRET must be at least 16 characters.");
  checkEncryptionKey(value("ARMADA_ENCRYPTION_KEY"));
  const publicUrl = new URL(resourceUrl(value("ARMADA_PUBLIC_URL"))).origin;
  const development = env.NODE_ENV === "development";

  return {
    port,
    orchestratorPairs: orchestratorPairsFromEnv(env.ARMADA_ORCHESTRATOR_PAIRS),
    supabaseUrl: value("SUPABASE_URL").replace(/\/+$/, ""),
    anonKey: value("SUPABASE_ANON_KEY"),
    authSecret: value("ARMADA_AUTH_SECRET"),
    publicUrl,
    dashboardUrl: dashboardOrigin(env.ARMADA_DASHBOARD_URL?.trim() || undefined, development),
    development,
    encryptionKey: value("ARMADA_ENCRYPTION_KEY"),
    databaseUrl: value("ARMADA_DATABASE_URL"),
  };
}
