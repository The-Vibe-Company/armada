import { resourceUrl } from "@armada/auth";

export interface ServerConfig {
  port: number;
  supabaseUrl: string;
  anonKey: string;
  authSecret: string;
  /** Origin only. The MCP resource is this plus `/mcp`. */
  publicUrl: string;
  encryptionKey: string;
  /** Privileged Postgres connection (the Supabase `postgres` role), shared with the control API. */
  databaseUrl: string;
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

  return {
    port,
    supabaseUrl: value("SUPABASE_URL").replace(/\/+$/, ""),
    anonKey: value("SUPABASE_ANON_KEY"),
    authSecret: value("ARMADA_AUTH_SECRET"),
    publicUrl,
    encryptionKey: value("ARMADA_ENCRYPTION_KEY"),
    databaseUrl: value("ARMADA_DATABASE_URL"),
  };
}
