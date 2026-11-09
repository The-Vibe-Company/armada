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
  test("reads the environment, with PORT defaulting to 8080", () => {
    expect(configFromEnv(ENV)).toMatchObject({ port: 8080, supabaseUrl: "https://project.supabase.co" });
    expect(configFromEnv({ ...ENV, PORT: "3000" }).port).toBe(3000);
  });

  test("orchestrator deployment intent defaults off and refuses unknown pairs without echoing input", () => {
    expect(configFromEnv(ENV).orchestratorPairs).toEqual([]);
    for (const revision of [undefined, "main", "secret-invalid-revision"]) {
      expect(() =>
        configFromEnv({
          ...ENV,
          ARMADA_ORCHESTRATOR_PAIRS: "modal:codex",
          ARMADA_ORCHESTRATOR_SKILL_REVISION: revision,
        }),
      ).toThrow("ARMADA_ORCHESTRATOR_SKILL_REVISION must be a reviewed public 40-character commit.");
    }
    expect(
      configFromEnv({
        ...ENV,
        ARMADA_ORCHESTRATOR_PAIRS: "modal:codex",
        ARMADA_ORCHESTRATOR_SKILL_REVISION: "a".repeat(40),
      }).orchestratorSkillRevision,
    ).toBe("a".repeat(40));
    for (const pairs of ["true", "boat:claud", "boat:claude,", "secret-invalid-pair"]) {
      try {
        configFromEnv({ ...ENV, ARMADA_ORCHESTRATOR_PAIRS: pairs });
        throw new Error("Unexpected acceptance");
      } catch (error) {
        expect(String(error)).toContain("ARMADA_ORCHESTRATOR_PAIRS must list");
        expect(String(error)).not.toContain(pairs);
      }
    }
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
