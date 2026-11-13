import { expect, test } from "bun:test";
import {
  CODEX_AUTH_ENV,
  CODEX_ENDPOINT_ENV,
  type GoldenActor,
  type HarnessCredentials,
  type SandboxRecord,
} from "@armada/core";
import { boatRuntimeConfiguration } from "../src/boat-runtime-configuration.ts";

function fixture() {
  const actor: GoldenActor = { userId: crypto.randomUUID(), orgId: crypto.randomUUID(), role: "member" as const };
  const binding = { credentialId: crypto.randomUUID(), credentialVersion: 3 };
  const sandbox: SandboxRecord = {
    id: crypto.randomUUID(),
    provider: "boat",
    providerSandboxId: "physical",
    goldenId: crypto.randomUUID(),
    ownerId: actor.userId,
    orgId: actor.orgId,
    harness: "codex",
    status: "starting",
    conversationIds: [],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    stoppedAt: null,
    deletedAt: null,
    statusReason: null,
    repositoryDir: "project",
    model: "gpt-5.4",
    reasoningEffort: "high",
    ...binding,
  };
  // Trusted build descriptor fixture, not a harness-install fixture. That owner
  // validates archive inventory/bytes; this boundary pins target and delivery digest.
  const manifest = {
    protocol: 1,
    platform: "linux",
    architecture: "x64",
    libc: "glibc",
    version: "test",
    runtime: { sha256: "a".repeat(64), bytes: 10 },
    harnesses: { codex: { files: [{ path: "bin/codex" }] } },
  };
  const key = `fixture-${crypto.randomUUID()}`;
  const credentials: HarnessCredentials = {
    env: { OPENAI_API_KEY: key },
    codexAuthJson: false,
    secrets: [key],
    binding,
  };
  return { actor, sandbox, manifest, credentials, key, architecture: "x64" as const };
}

test.each(["key", "endpoint", "native", "native-fresh", "shared"] as const)(
  "private Codex configuration projects %s without host/unselected harness authority",
  async (mode) => {
    const f = fixture();
    const originalAuth = JSON.stringify({
      tokens: { account_id: "account", access_token: crypto.randomUUID(), refresh_token: crypto.randomUUID() },
    });
    const latestAuth = JSON.stringify({
      tokens: { account_id: "account", access_token: crypto.randomUUID(), refresh_token: crypto.randomUUID() },
    });
    if (mode === "endpoint")
      f.credentials.env[CODEX_ENDPOINT_ENV] = JSON.stringify({
        version: 1,
        baseUrl: "https://model.example/responses",
        apiVersion: "2026-01-01",
      });
    if (mode.startsWith("native") || mode === "shared") {
      f.credentials.codexAuthJson = true;
      f.credentials.env = mode === "shared" ? { ARMADA_SERVER_CODEX: "1" } : { [CODEX_AUTH_ENV]: originalAuth };
    }
    if (mode === "key") {
      f.sandbox.repositoryDir = null;
      f.manifest.architecture = "arm64";
    }
    const architecture = mode === "key" ? ("arm64" as const) : ("x64" as const);
    const modelAuth = {
      state: {
        async read(actor: typeof f.actor, id: string, version: number, sandboxId: string) {
          if (
            actor.userId !== f.actor.userId ||
            id !== f.sandbox.credentialId ||
            version !== 3 ||
            sandboxId !== f.sandbox.id
          )
            throw Error("wrong auth projection scope");
          if (mode === "native-fresh") return undefined;
          return {
            authJson: latestAuth,
            revision: 7,
            secrets: [originalAuth],
            sourceGeneration: mode === "shared" ? "server:ready" : "runtime:previous",
          };
        },
      },
    };
    const broker = {
      async access() {
        throw Error("projection must not fetch model access");
      },
    };
    const plan = await boatRuntimeConfiguration({
      ...f,
      architecture,
      modelAuth: { ...modelAuth, ...(mode === "shared" ? { broker } : {}) },
    });
    expect(plan.artifact).toEqual({ sha256: "a".repeat(64), bytes: 10 });
    expect(plan.configuration).toMatchObject({
      selectedHarness: "codex",
      root: `/home/user/.armada-runtime/${f.sandbox.id}`,
      cwd: mode === "key" ? "/home/user" : "/home/user/project",
      grant: { expiresAt: Date.parse(f.sandbox.expiresAt ?? "") },
      claudeEnv: {},
      claudeExecutable: "",
      codexExecutable: "",
    });
    expect(plan.configuration.mcp).toEqual({ revision: "boat_runtime_empty_v1", servers: {} });
    expect(Object.keys(plan).sort()).toEqual(["artifact", "cacheDir", "configuration"]);
    expect(plan.configuration.codexEnv[CODEX_AUTH_ENV]).toBeUndefined();
    expect(plan.configuration.codexEnv.ARMADA_SERVER_CODEX).toBeUndefined();
    if (mode.startsWith("native")) {
      expect(plan.configuration.codexAuthJson).toBe(mode === "native-fresh" ? originalAuth : latestAuth);
      expect(plan.configuration.nativeAuthRevision).toBe(mode === "native-fresh" ? 0 : 7);
      expect(plan.configuration.nativeAuthSecrets).toEqual(mode === "native-fresh" ? [] : [originalAuth]);
    } else if (mode === "shared") {
      expect(plan.configuration.runtimeSubscription).toBe(true);
      expect(plan.configuration.codexAuthJson).toBeUndefined();
      expect(plan.configuration.nativeAuthRevision).toBeUndefined();
      expect(plan.configuration.nativeAuthSecrets).toBeUndefined();
      expect(plan.configuration.codexEnv.OPENAI_API_KEY).toBeUndefined();
      expect("subscription" in plan.configuration).toBe(false);
      expect(JSON.stringify(plan)).not.toContain(JSON.parse(latestAuth).tokens.refresh_token);
    } else {
      expect(plan.configuration.codexEnv.OPENAI_API_KEY).toBe(f.key);
      expect(plan.configuration.codexAuthJson).toBeUndefined();
      if (mode === "endpoint")
        expect(JSON.parse(plan.configuration.codexEnv[CODEX_ENDPOINT_ENV] ?? "")).toEqual({
          version: 1,
          baseUrl: "https://model.example",
          apiVersion: "2026-01-01",
        });
    }
    // Returned manifest is a frozen launch copy, not the caller's mutable metadata.
    f.manifest.runtime.sha256 = "b".repeat(64);
    expect(plan.configuration.artifactManifest.runtime).toMatchObject({ sha256: "a".repeat(64) });
  },
);

test.each([
  "owner",
  "pin",
  "provider",
  "harness",
  "expiry",
  "directory",
  "architecture",
  "descriptor",
  "unselected-key",
  "auth-unmanaged",
  "server-unenrolled",
  "shared-unconfigured",
  "source-error",
] as const)("configuration fails closed for %s and does not reflect private input", async (reason) => {
  const f = fixture();
  if (reason === "owner") f.actor.userId = crypto.randomUUID();
  if (reason === "pin") f.credentials.binding = { credentialId: crypto.randomUUID(), credentialVersion: 3 };
  if (reason === "provider") f.sandbox.provider = "modal";
  if (reason === "harness") f.sandbox.harness = "claude";
  if (reason === "expiry") f.sandbox.expiresAt = "1970-01-01T00:00:00Z";
  if (reason === "directory") f.sandbox.repositoryDir = "../private";
  if (reason === "architecture") f.manifest.architecture = "arm64";
  if (reason === "descriptor") f.manifest.runtime.sha256 = "not-a-digest";
  if (reason === "unselected-key") f.credentials.env.ANTHROPIC_API_KEY = f.key;
  if (
    reason === "auth-unmanaged" ||
    reason === "server-unenrolled" ||
    reason === "source-error" ||
    reason === "shared-unconfigured"
  ) {
    f.credentials.codexAuthJson = true;
    f.credentials.env =
      reason === "server-unenrolled"
        ? { ARMADA_SERVER_CODEX: "1" }
        : {
            [CODEX_AUTH_ENV]: JSON.stringify({
              tokens: { account_id: "account", access_token: f.key, refresh_token: crypto.randomUUID() },
            }),
          };
  }
  const input: Parameters<typeof boatRuntimeConfiguration>[0] = { ...f };
  if (reason === "server-unenrolled" || reason === "source-error" || reason === "shared-unconfigured")
    input.modelAuth = {
      state: {
        async read() {
          if (reason === "source-error") throw Error(f.key);
          const authJson = f.credentials.env[CODEX_AUTH_ENV];
          if (!authJson) return undefined;
          return {
            authJson,
            revision: 0,
            secrets: [],
            sourceGeneration: reason === "shared-unconfigured" ? "server:ready" : "runtime:previous",
          };
        },
      },
    };
  await expect(boatRuntimeConfiguration(input)).rejects.toMatchObject({
    code: "unavailable",
    message: "Boat runtime configuration is unavailable.",
  });
});

test.each(["key", "token", "endpoint", "mixed", "wrong-harness"] as const)(
  "Claude private configuration projects only selected harness credentials (%s)",
  async (mode) => {
    const f = fixture();
    f.sandbox.harness = "claude";
    Object.assign(f.manifest.harnesses, { claude: { files: [{ path: "bin/claude" }] } });
    f.credentials.env = mode === "token" ? { CLAUDE_CODE_OAUTH_TOKEN: f.key } : { ANTHROPIC_API_KEY: f.key };
    if (mode === "endpoint")
      f.credentials.env.ARMADA_CLAUDE_ENDPOINT = JSON.stringify({
        version: 1,
        baseUrl: "https://model.example/anthropic",
        auth: "api-key",
      });
    if (mode === "mixed") f.credentials.env.CLAUDE_CODE_OAUTH_TOKEN = f.key;
    if (mode === "wrong-harness") f.credentials.env = { OPENAI_API_KEY: f.key };
    if (mode === "mixed" || mode === "wrong-harness") {
      await expect(boatRuntimeConfiguration(f)).rejects.toThrow("Boat runtime configuration is unavailable.");
      return;
    }
    const plan = await boatRuntimeConfiguration(f);
    expect(plan.configuration.selectedHarness).toBe("claude");
    expect(plan.configuration.claudeEnv).toMatchObject(f.credentials.env);
    expect(plan.configuration.codexEnv.OPENAI_API_KEY).toBeUndefined();
    expect(plan.configuration.codexAuthJson).toBeUndefined();
  },
);
