import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENCODE_ENDPOINT_ENV, parseOpenCodeEndpoint } from "@armada/core";
import { createRedactor, OpenCodeDriver } from "../src/index.ts";
import { configureOpenCodeEndpoint } from "../src/opencode-endpoint.ts";

// Native exported session state is the checkpoint boundary: credentials/cache/SQLite must not be persisted.
test("OpenCode exports sanitized history and imports it before no-text resume and follow-up", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-state-"));
  const driver = new OpenCodeDriver({
    executable: `${import.meta.dir}/fixtures/opencode.ts`,
    root: join(root, "opencode"),
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    redact: createRedactor(["private-key-for-test"]),
  });
  const context = {
    request: { sandboxId: "s", harness: "codex" as const, text: "hello" },
    signal: new AbortController().signal,
    emit: () => {},
    session: (id: string) => expect(id).toBe("session-1"),
  };
  try {
    expect(await driver.start(context).done).toBe("finished");
    const history = await readFile(join(root, "opencode/sessions/session-1.json"), "utf8");
    expect(history).not.toContain("private-key-for-test");
    expect(history).toContain("[REDACTED]");
    const { HarnessState } = await import("../src/state.ts");
    await Bun.write(join(root, "opencode/data/auth.json"), "fake-private-cache");
    const state = new HarnessState(root, createRedactor(["private-key-for-test"]));
    await state.checkpoint();
    await state.restore();
    expect(await Bun.file(join(root, "opencode/data/auth.json")).exists()).toBe(false);

    expect(await driver.resumeSession({ ...context, sessionId: "session-1" })).toEqual({ sessionId: "session-1" });
    expect(await driver.start({ ...context, sessionId: "session-1" }).done).toBe("finished");
    await expect(driver.resumeSession({ ...context, sessionId: "../other" })).rejects.toThrow(
      "invalid_harness_protocol",
    );
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Protect the private native provider configuration, not a second credential catalog.
test("OpenCode translates a sealed-compatible endpoint into memory-only native configuration", () => {
  const env: Record<string, string> = {
    OPENCODE_API_KEY: "fake-key",
    [OPENCODE_ENDPOINT_ENV]: JSON.stringify({
      version: 1,
      baseUrl: "https://api.deepseek.com/v1/",
      models: ["deepseek-flash"],
    }),
  };
  configureOpenCodeEndpoint(env);
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
  expect(config.enabled_providers).toEqual(["armada"]);
  expect(config.agent.title.disable).toBe(true);
  expect(config.default_agent).toBe("build");
  expect(config.agent.build.permission.task).toBe("deny");
  expect(config.provider.armada).toMatchObject({
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: "https://api.deepseek.com/v1", apiKey: "fake-key" },
    models: { "deepseek-flash": { name: "deepseek-flash" } },
  });
  expect(env.OPENCODE_API_KEY).toBeUndefined();
  expect(env[OPENCODE_ENDPOINT_ENV]).toBeUndefined();
  for (const baseUrl of [
    "http://endpoint.invalid",
    "https://user:key@endpoint.invalid",
    "https://endpoint.invalid?key=x",
  ])
    expect(() => parseOpenCodeEndpoint({ version: 1, baseUrl, models: ["model"] })).toThrow(
      "Invalid OpenCode endpoint",
    );
});

test("OpenCode uses the native Anthropic SDK for Messages connections and removes source secrets", () => {
  const env: Record<string, string> = {
    OPENCODE_API_KEY: "fake-key",
    [OPENCODE_ENDPOINT_ENV]: JSON.stringify({
      version: 1,
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com/v1/",
      models: ["claude-test"],
    }),
  };
  configureOpenCodeEndpoint(env);
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
  expect(config.provider.armada).toMatchObject({
    npm: "@ai-sdk/anthropic",
    options: { baseURL: "https://api.anthropic.com/v1", apiKey: "fake-key" },
    models: { "claude-test": { name: "claude-test" } },
  });
  expect(env.OPENCODE_API_KEY).toBeUndefined();
  expect(env[OPENCODE_ENDPOINT_ENV]).toBeUndefined();
});

test("OpenCode uses Azure Responses without duplicating v1 on Azure OpenAI or losing Foundry paths", () => {
  for (const [baseUrl, sdkUrl] of [
    ["https://resource.openai.azure.com/openai/v1", "https://resource.openai.azure.com/openai"],
    ["https://resource.services.ai.azure.com/openai/v1", "https://resource.services.ai.azure.com/openai/v1"],
  ]) {
    const env: Record<string, string> = {
      OPENCODE_API_KEY: "fake-azure-key",
      [OPENCODE_ENDPOINT_ENV]: JSON.stringify({ version: 1, protocol: "azure", baseUrl, models: ["my-deployment"] }),
    };
    configureOpenCodeEndpoint(env);
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
    expect(config.provider.armada).toMatchObject({
      npm: "@ai-sdk/azure",
      options: { baseURL: sdkUrl, apiKey: "fake-azure-key" },
      models: { "my-deployment": { name: "my-deployment" } },
    });
    expect(env.OPENCODE_API_KEY).toBeUndefined();
    expect(env[OPENCODE_ENDPOINT_ENV]).toBeUndefined();
  }
});

// A failed native export must not turn an older JSON export into a false continuity proof.
test("OpenCode refuses stale history and checkpoint after an unacknowledged export", async () => {
  const { HarnessState } = await import("../src/state.ts");
  const root = await mkdtemp(join(tmpdir(), "opencode-export-failure-"));
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const driver = new OpenCodeDriver({
    executable: `${import.meta.dir}/fixtures/opencode.ts`,
    root: join(root, "opencode"),
    cwd: root,
    env,
    redact: createRedactor(["private-key-for-test"]),
  });
  const context = {
    request: { sandboxId: "s", harness: "opencode" as const, text: "hello" },
    signal: new AbortController().signal,
    emit: () => {},
    session: () => {},
  };
  try {
    expect(await driver.start(context).done).toBe("finished");
    env.FAIL_EXPORT = "1";
    await expect(driver.start({ ...context, sessionId: "session-1" }).done).rejects.toThrow("harness_failed");
    await expect(driver.resumeSession({ ...context, sessionId: "session-1" })).rejects.toThrow(
      "invalid_harness_protocol",
    );
    await expect(new HarnessState(root, createRedactor([])).checkpoint()).rejects.toThrow(
      "checkpoint_opencode_session_unverified",
    );
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});

// The pin's ACP usage is only the last model step. Native export counters cover all new tool/model steps.
test("OpenCode meters every new native assistant step once, excludes loaded history and normalizes reasoning output", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-turn-tokens-"));
  const env = { EXPORT_STAGE: "1", PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const driver = new OpenCodeDriver({
    executable: `${import.meta.dir}/fixtures/opencode.ts`,
    root,
    cwd: root,
    env,
    redact: createRedactor([]),
  });
  const usage: unknown[] = [];
  const context = {
    request: { sandboxId: "s", harness: "opencode" as const, text: "hello" },
    signal: new AbortController().signal,
    emit: (event: import("../src/protocol.ts").DriverEvent) => {
      if (event.kind === "other" && event.type === "armada/turnUsage") usage.push(event.data);
    },
    session: () => {},
  };
  try {
    expect(await driver.start(context).done).toBe("finished");
    env.EXPORT_STAGE = "2";
    expect(await driver.start({ ...context, sessionId: "session-1" }).done).toBe("finished");
    expect(usage).toEqual([
      {
        model: "armada/model",
        inputTokens: 2,
        outputTokens: 4,
        cachedTokens: 1,
        cacheWriteTokens: 0,
        reasoningTokens: 1,
      },
      {
        model: "armada/model",
        inputTokens: 6,
        outputTokens: 8,
        cachedTokens: 2,
        cacheWriteTokens: 2,
        reasoningTokens: 2,
      },
    ]);
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});
