import { resourceUrl } from "@armada/auth";
import { DEFAULT_SANDBOX_EXTENSION_HEADROOM_SECONDS, PROVIDER_LIMITS, SANDBOX_STOP_MARGIN_SECONDS } from "@armada/core";
import { type OrchestratorPair, orchestratorPairsFromEnv } from "./orchestrator-activation.ts";

export interface ServerConfig {
  sandboxExtensionHeadroomSeconds: number;
  port: number;
  orchestratorPairs: readonly OrchestratorPair[];
  orchestratorSkillRevision: string | undefined;
  /** Managed GitHub wrappers/broker are opt-in while the runtime is under repair. */
  githubRuntimeEnabled: boolean;
  /** Experimental legacy Boat hydration at prompt boundaries; explicit repair is independent. */
  githubLegacyAutoPrepareEnabled: boolean;
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
  const sandboxExtensionHeadroomSeconds = env.ARMADA_SANDBOX_EXTENSION_HEADROOM_SECONDS?.trim()
    ? Number(env.ARMADA_SANDBOX_EXTENSION_HEADROOM_SECONDS)
    : DEFAULT_SANDBOX_EXTENSION_HEADROOM_SECONDS;
  if (
    !Number.isSafeInteger(sandboxExtensionHeadroomSeconds) ||
    sandboxExtensionHeadroomSeconds < 0 ||
    sandboxExtensionHeadroomSeconds > PROVIDER_LIMITS.modal.maxTtlSeconds - SANDBOX_STOP_MARGIN_SECONDS
  )
    throw new Error(
      "ARMADA_SANDBOX_EXTENSION_HEADROOM_SECONDS must be a non-negative whole number within the Modal lifetime limit minus stop margin.",
    );
  const development = env.NODE_ENV === "development";

  const orchestratorPairs = orchestratorPairsFromEnv(env.ARMADA_ORCHESTRATOR_PAIRS);
  const orchestratorSkillRevision = env.ARMADA_ORCHESTRATOR_SKILL_REVISION?.trim() || undefined;

  if (orchestratorSkillRevision && !/^[a-f0-9]{40}$/.test(orchestratorSkillRevision))
    throw new Error("ARMADA_ORCHESTRATOR_SKILL_REVISION must be a reviewed public 40-character commit.");
  return {
    sandboxExtensionHeadroomSeconds,
    port,
    orchestratorPairs,
    orchestratorSkillRevision,
    githubRuntimeEnabled: env.ARMADA_GITHUB_RUNTIME_ENABLED === "true",
    githubLegacyAutoPrepareEnabled: env.ARMADA_GITHUB_LEGACY_AUTO_PREPARE_ENABLED === "true",
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
