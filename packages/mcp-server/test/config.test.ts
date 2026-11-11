import { describe, expect, test } from "bun:test";
import { decryptSecret, encryptSecret } from "@armada/core";
import { configFromEnv, dashboardOrigin } from "../src/config.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const ENV = {
  ARMADA_DATABASE_URL: "postgres://postgres:pw@db.example.com:5432/postgres",
  SUPABASE_URL: "https://project.supabase.co/",
  SUPABASE_ANON_KEY: "anon",
  ARMADA_AUTH_SECRET: "a-test-auth-secret-of-enough-length",
  ARMADA_PUBLIC_URL: "https://armada.example.com",
  ARMADA_ENCRYPTION_KEY: ENCRYPTION_KEY,
};

describe("config", () => {
  test("database pool budget defaults to three main sessions and accepts only safe integers >= 2", () => {
    expect(configFromEnv(ENV).databasePoolMax).toBe(3);
    for (const max of [2, 3, 6, 12])
      expect(configFromEnv({ ...ENV, ARMADA_DATABASE_POOL_MAX: String(max) }).databasePoolMax).toBe(max);
    for (const value of ["", " ", "1", "0", "-2", "3.5", "NaN", "Infinity", "9007199254740992", "3e0"])
      expect(() => configFromEnv({ ...ENV, ARMADA_DATABASE_POOL_MAX: value })).toThrow("ARMADA_DATABASE_POOL_MAX");
  });
  test("GitHub runtime and automatic legacy preparation each require an exact explicit opt-in", () => {
    for (const value of [undefined, "", "false", "1", "TRUE", " true "])
      expect(configFromEnv({ ...ENV, ARMADA_GITHUB_RUNTIME_ENABLED: value }).githubRuntimeEnabled).toBe(false);
    expect(configFromEnv({ ...ENV, ARMADA_GITHUB_RUNTIME_ENABLED: "true" }).githubRuntimeEnabled).toBe(true);
    for (const value of [undefined, "", "false", "1", "TRUE", " true "])
      expect(
        configFromEnv({ ...ENV, ARMADA_GITHUB_LEGACY_AUTO_PREPARE_ENABLED: value }).githubLegacyAutoPrepareEnabled,
      ).toBe(false);
    expect(
      configFromEnv({ ...ENV, ARMADA_GITHUB_LEGACY_AUTO_PREPARE_ENABLED: "true" }).githubLegacyAutoPrepareEnabled,
    ).toBe(true);
  });

  test("server Modal extension headroom is bounded, configurable and defaults to one hour", () => {
    expect(configFromEnv(ENV).sandboxExtensionHeadroomSeconds).toBe(3600);
    for (const seconds of [0, 1800, 86100])
      expect(
        configFromEnv({ ...ENV, ARMADA_SANDBOX_EXTENSION_HEADROOM_SECONDS: String(seconds) })
          .sandboxExtensionHeadroomSeconds,
      ).toBe(seconds);
    for (const invalid of ["-1", "1.5", "Infinity", "86101", "invalid-policy"])
      expect(() => configFromEnv({ ...ENV, ARMADA_SANDBOX_EXTENSION_HEADROOM_SECONDS: invalid })).toThrow(
        "ARMADA_SANDBOX_EXTENSION_HEADROOM_SECONDS must be",
      );
  });

  test("reads the environment, with PORT defaulting to 8080", () => {
    expect(configFromEnv(ENV)).toMatchObject({ port: 8080, supabaseUrl: "https://project.supabase.co" });
    expect(configFromEnv({ ...ENV, PORT: "3000" }).port).toBe(3000);
  });

  test("sandbox access is default-off, ignores retired env and only enables supported pairs", () => {
    expect(configFromEnv(ENV).sandboxAccessPairs).toEqual([]);
    expect(
      configFromEnv({ ...ENV, ARMADA_ORCHESTRATOR_PAIRS: "modal:codex", ARMADA_ORCHESTRATOR_SKILL_REVISION: "ignored" })
        .sandboxAccessPairs,
    ).toEqual([]);
    expect(
      configFromEnv({ ...ENV, ARMADA_SANDBOX_ACCESS_PAIRS: "boat:codex,modal:codex,boat:codex" }).sandboxAccessPairs,
    ).toEqual(["boat:codex", "modal:codex"]);
    for (const pair of ["true", "boat:claude", "modal:claude", "secret-invalid-pair"])
      expect(() => configFromEnv({ ...ENV, ARMADA_SANDBOX_ACCESS_PAIRS: pair })).toThrow(
        "ARMADA_SANDBOX_ACCESS_PAIRS must list boat:codex or modal:codex.",
      );
  });

  test("dashboard OAuth origin is independently configured and only permits loopback HTTP in development", () => {
    expect(configFromEnv(ENV).dashboardUrl).toBe("https://armada.thevibecompany.co");
    expect(configFromEnv({ ...ENV, ARMADA_DASHBOARD_URL: "https://dashboard.example.com:8443/" }).dashboardUrl).toBe(
      "https://dashboard.example.com:8443",
    );
    expect(
      configFromEnv({ ...ENV, ARMADA_DASHBOARD_URL: "http://localhost:3000", NODE_ENV: "development" }).dashboardUrl,
    ).toBe("http://localhost:3000");
    for (const input of [
      "http://dashboard.example.com",
      "http://localhost:3000",
      "https://user:password@dashboard.example.com",
      "https://dashboard.example.com/return",
      "https://dashboard.example.com?return=elsewhere",
      "https://dashboard.example.com/#fragment",
      "//dashboard.example.com",
      "not a URL",
    ]) {
      try {
        dashboardOrigin(input);
        throw new Error("Unexpected acceptance");
      } catch (error) {
        expect(String(error)).toContain("ARMADA_DASHBOARD_URL must be an HTTPS origin");
        expect(String(error)).not.toContain(input);
      }
    }
    expect(() => dashboardOrigin("http://dashboard.example.com", true)).toThrow();
  });

  test("HTTP dashboard origins require explicit development and an exact loopback host", () => {
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      expect(dashboardOrigin(origin, true)).toBe(origin);
      expect(() => dashboardOrigin(origin)).toThrow("ARMADA_DASHBOARD_URL");
      const config = configFromEnv({ ...ENV, NODE_ENV: "development", ARMADA_DASHBOARD_URL: origin });
      expect(config.development).toBe(true);
      expect(config.dashboardUrl).toBe(origin);
      for (const mode of ["production", "test", "Development"])
        expect(() => configFromEnv({ ...ENV, NODE_ENV: mode, ARMADA_DASHBOARD_URL: origin })).toThrow(
          "ARMADA_DASHBOARD_URL",
        );
    }
    for (const invalid of [
      "http://dashboard.example",
      "http://localhost.evil",
      "http://10.0.0.1:3000",
      "http://localhost:3000/callback",
      "http://user:password@localhost:3000",
      "http://localhost:3000?return=elsewhere",
    ])
      expect(() => dashboardOrigin(invalid, true)).toThrow("ARMADA_DASHBOARD_URL");
  });

  test("names every missing variable and never echoes a value", () => {
    expect(() => configFromEnv({ SUPABASE_ANON_KEY: "anon" })).toThrow(
      "Set ARMADA_DATABASE_URL, SUPABASE_URL, ARMADA_AUTH_SECRET, ARMADA_PUBLIC_URL, ARMADA_ENCRYPTION_KEY.",
    );
    expect(() => configFromEnv({ ...ENV, ARMADA_ENCRYPTION_KEY: "c2hvcnQ=" })).toThrow(/must be 32 bytes/);
    expect(() => configFromEnv({ ...ENV, ARMADA_PUBLIC_URL: "http://armada.example.com/x" })).toThrow(/origin/);
    expect(() => configFromEnv({ ...ENV, PORT: "http" })).toThrow(/PORT/);
  });
});

test("a secret sealed with the key opens with it, and not with another key", async () => {
  const sealed = await encryptSecret("sk-ant-oat01-example", ENCRYPTION_KEY);
  expect(await decryptSecret(sealed, ENCRYPTION_KEY)).toBe("sk-ant-oat01-example");
  await expect(decryptSecret(sealed, btoa("x".repeat(32)))).rejects.toThrow();
});
