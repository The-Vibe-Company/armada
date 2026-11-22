import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv, dashboardOrigin } from "../src/config.ts";
import { readStartupConfiguration } from "../src/startup-configuration.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const ENV = {
  ARMADA_DATABASE_URL: "postgres://postgres:pw@db.example.com:5432/postgres",
  SUPABASE_URL: "https://project.supabase.co/",
  SUPABASE_ANON_KEY: "anon",
  ARMADA_AUTH_SECRET: "a-test-auth-secret-of-enough-length",
  ARMADA_PUBLIC_URL: "https://armada.example.com",
  ARMADA_ENCRYPTION_KEY: ENCRYPTION_KEY,
  ARMADA_MODAL_DIALOUT: "1",
  ARMADA_MODAL_RUNTIME_MANIFEST: "/opt/runtime.json",
};

describe("config", () => {
  test("Boat launch selection is one strict server setting, native by default and explicit for rollback", () => {
    expect(configFromEnv(ENV).boatAgentPath).toBe("native");
    for (const mode of ["native", "runtime"] as const)
      expect(configFromEnv({ ...ENV, ARMADA_BOAT_AGENT_PATH: mode }).boatAgentPath).toBe(mode);
    for (const mode of ["", "TRUE", " runtime ", "auto", "fallback"])
      expect(() => configFromEnv({ ...ENV, ARMADA_BOAT_AGENT_PATH: mode })).toThrow("ARMADA_BOAT_AGENT_PATH");
  });
  test("Modal startup requires dial-out and a manifest", () => {
    for (const missing of [
      { ARMADA_MODAL_DIALOUT: undefined },
      { ARMADA_MODAL_RUNTIME_MANIFEST: undefined },
      { ARMADA_MODAL_RUNTIME_MANIFEST: " " },
    ]) {
      expect(() => configFromEnv({ ...ENV, ...missing })).toThrow(
        /ARMADA_MODAL_DIALOUT=1.*ARMADA_MODAL_RUNTIME_MANIFEST/,
      );
    }
  });
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

test.each([
  ["SUPABASE_URL", "https://example.com/private-path"],
  ["ARMADA_DATABASE_URL", "https://example.com"],
])("rejects an invalid startup URL for %s without including its value", (name, value) => {
  try {
    configFromEnv({ ...ENV, [name]: value });
  } catch (error) {
    expect(String(error)).toContain(name);
    expect(String(error)).not.toContain(value);
    return;
  }
  throw new Error(`Expected startup to reject ${name}`);
});

test.each([
  ["ARMADA_BOAT_RUNTIME_MANIFEST", { ARMADA_BOAT_AGENT_PATH: "runtime" }],
  ["ARMADA_MODAL_RUNTIME_MANIFEST", { ARMADA_MODAL_DIALOUT: "1" }],
] as const)("rejects an unusable %s when startup needs it", async (name, settings) => {
  await expect(
    readStartupConfiguration({
      ...ENV,
      ...settings,
      [name]: "/nonexistent/manifest.json",
    }),
  ).rejects.toThrow(name);
});

describe("startup with a valid Modal manifest", () => {
  async function readWithManifest(overrides: Record<string, string>) {
    const dir = await mkdtemp(join(tmpdir(), "armada-config-"));
    try {
      const path = join(dir, "runtime.json");
      await Bun.write(
        path,
        JSON.stringify({
          protocol: 1,
          platform: "linux",
          libc: "glibc",
          architecture: "x64",
          runtime: { sha256: "a".repeat(64), bytes: 1 },
          harnesses: {},
        }),
      );
      return await readStartupConfiguration({
        ...ENV,
        ARMADA_RUNTIME_ARTIFACT_DIR: dir,
        ARMADA_MODAL_RUNTIME_MANIFEST: path,
        ...overrides,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("rejects an unusable Docker manifest when placement is enabled", async () => {
    await expect(
      readWithManifest({
        ARMADA_DOCKER_HOSTS: "1",
        ARMADA_DOCKER_PLACEMENT: "1",
        ARMADA_DOCKER_RUNTIME_MANIFEST: "/nonexistent/manifest.json",
      }),
    ).rejects.toThrow("ARMADA_DOCKER_RUNTIME_MANIFEST");
  });

  test("startup checks PostgreSQL client URL syntax without connecting", async () => {
    await expect(readWithManifest({ ARMADA_DATABASE_URL: "postgres://user:%zz@example.com/db" })).rejects.toThrow(
      "ARMADA_DATABASE_URL must be a valid PostgreSQL connection URL.",
    );
  });

  test("startup requires an explicit dashboard origin when invitation mail is enabled", async () => {
    await expect(readWithManifest({ ARMADA_INVITATION_MAIL: "supabase" })).rejects.toThrow("ARMADA_DASHBOARD_URL");
  });
});

test("validates the configured login providers before constructing the server", () => {
  expect(configFromEnv({ ...ENV, ARMADA_AUTH_PROVIDERS: " github, , google " }).loginProviders).toEqual([
    "github",
    "google",
  ]);
  expect(() => configFromEnv({ ...ENV, ARMADA_AUTH_PROVIDERS: "github,unsupported" })).toThrow("ARMADA_AUTH_PROVIDERS");
});
