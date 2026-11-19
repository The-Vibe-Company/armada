import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENCODE_ENDPOINT_ENV, parseOpenCodeEndpoint } from "@armada/core";
import { createRedactor, Journal, OpenCodeDriver } from "../src/index.ts";
import { configureOpenCodeEndpoint } from "../src/opencode-endpoint.ts";
import { exportedToolProofs } from "../src/opencode-export-observations.ts";

// The local stdio/export fixture does not implement OpenCode's separate HTTP event server.
// Observer wire/auth/filter behavior has its own fake-stream boundary test (no network).
const createRetryObserver = async () => ({
  args: ["acp"],
  env: {},
  observation: { ready: async () => {}, failed: new Promise<never>(() => {}), close: async () => {} },
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

test("OpenCode uses native OpenAI Responses for a sealed OpenAI connection", () => {
  const env: Record<string, string> = {
    OPENCODE_API_KEY: "fake-openai-key",
    [OPENCODE_ENDPOINT_ENV]: JSON.stringify({
      version: 1,
      protocol: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: ["gpt-test"],
    }),
  };
  configureOpenCodeEndpoint(env);
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
  expect(config.provider.armada).toMatchObject({
    npm: "@ai-sdk/openai",
    options: { baseURL: "https://api.openai.com/v1", apiKey: "fake-openai-key" },
    models: { "gpt-test": { name: "gpt-test" } },
  });
  expect(env.OPENCODE_API_KEY).toBeUndefined();
  expect(env[OPENCODE_ENDPOINT_ENV]).toBeUndefined();
});

// A failed native export must not turn an older JSON export into a false continuity proof.
test("OpenCode refuses stale history and checkpoint after an unacknowledged export", async () => {
  const { HarnessState } = await import("../src/state.ts");
  const root = await mkdtemp(join(tmpdir(), "opencode-export-failure-"));
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const driver = new OpenCodeDriver({
    createRetryObserver,
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
    createRetryObserver,
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

// Completed native exports own tool receipts; ACP display titles are not evidence.
function nativeToolMessage(id: string, kind: "shell" | "mcp") {
  const metadata: { exit?: number; truncated: boolean; timeout?: boolean } =
    kind === "shell" ? { exit: 0, truncated: false, timeout: false } : { truncated: false };
  return {
    info: { id, sessionID: "session-1", role: "assistant", time: { completed: 1 } },
    parts: [
      {
        type: "tool",
        id: `part-${id}`,
        callID: `call-${id}`,
        messageID: id,
        sessionID: "session-1",
        tool: kind === "shell" ? "bash" : "armada_fixture_read_counter",
        state: {
          status: "completed",
          input:
            kind === "shell"
              ? { command: id === "old" ? "printf OLD" : "printf EXPECTED" }
              : { label: "fixture", nested: { a: 1, b: 2 } },
          output: kind === "shell" ? (id === "old" ? "OLD" : "EXPECTED") : "native MCP result",
          metadata,
        },
      },
    ],
  };
}

const shellReceipt = (id: string, command: string, output: string) => ({
  type: "armada/opencodeShell" as const,
  data: {
    version: 1,
    nativeMessageId: id,
    callId: `call-${id}`,
    tool: "bash",
    command,
    output,
    exitCode: 0,
    truncated: false,
  },
});
const mcpServer = { type: "http" as const, url: "https://gateway.example/mcp" };
const mcpConfiguration = { revision: "r1", servers: { armada_fixture: mcpServer } };
const mcpReceipt = (id: string) => ({
  type: "armada/opencodeMcp" as const,
  data: {
    version: 1,
    nativeMessageId: id,
    callId: `call-${id}`,
    server: "armada_fixture",
    configurationRevision: "r1",
    nativeToolName: "armada_fixture_read_counter",
    input: { label: "fixture", nested: { a: 1, b: 2 } },
    result: { output: "native MCP result", isError: false },
  },
});

test.each([
  "success",
  "exit",
  "missing-exit",
  "truncated",
  "timeout",
  "duplicate",
  "foreign-session",
  "oversized",
] as const)("OpenCode shell proof excludes restored history and refuses unsafe native results (%s)", (mode) => {
  const old = nativeToolMessage("old", "shell"),
    next = nativeToolMessage("new-tool", "shell");
  const part = next.parts[0]!;
  if (mode === "exit") part.state.metadata.exit = 1;
  if (mode === "missing-exit") delete part.state.metadata.exit;
  if (mode === "truncated") part.state.metadata.truncated = true;
  if (mode === "timeout") part.state.metadata.timeout = true;
  if (mode === "duplicate") next.parts.push(part);
  if (mode === "foreign-session") part.sessionID = "foreign";
  if (mode === "oversized") part.state.output = "x".repeat(65537);
  if (mode === "success")
    expect(exportedToolProofs({ info: { id: "session-1" }, messages: [old] }, new Set())).toEqual([
      shellReceipt("old", "printf OLD", "OLD"),
    ]);
  expect(exportedToolProofs({ info: { id: "session-1" }, messages: [old, next] }, new Set(["old"]))).toEqual(
    mode === "success" ? [shellReceipt("new-tool", "printf EXPECTED", "EXPECTED")] : [],
  );
});

test.each([
  "success",
  "failed",
  "truncated",
  "duplicate",
  "foreign-session",
  "unknown-server",
  "ambiguous-server",
  "oversized",
] as const)("OpenCode MCP proof binds new native results to the selected configuration (%s)", (mode) => {
  const old = nativeToolMessage("old", "mcp"),
    next = nativeToolMessage("new-tool", "mcp");
  const part = next.parts[0]!;
  if (mode === "failed") part.state.status = "error";
  if (mode === "truncated") part.state.metadata.truncated = true;
  if (mode === "duplicate") next.parts.push(part);
  if (mode === "foreign-session") part.sessionID = "foreign";
  if (mode === "unknown-server") part.tool = "foreign_read_counter";
  if (mode === "oversized") part.state.output = "x".repeat(65537);
  const mcp =
    mode === "ambiguous-server"
      ? { revision: "r2", servers: { ...mcpConfiguration.servers, armada_fixture_read: mcpServer } }
      : mcpConfiguration;
  if (mode === "success")
    expect(exportedToolProofs({ info: { id: "session-1" }, messages: [old] }, new Set(), mcp)).toEqual([
      mcpReceipt("old"),
    ]);
  expect(exportedToolProofs({ info: { id: "session-1" }, messages: [old, next] }, new Set(["old"]), mcp)).toEqual(
    mode === "success" ? [mcpReceipt("new-tool")] : [],
  );
});

// One real driver receipt owns save/restore baseline delivery and native event publication.
test("OpenCode driver publishes only the new MCP receipt from a follow-up native export", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-mcp-proof-"));
  const journal = new Journal(":memory:", (text) => text);
  const env = { EXPORT_STAGE: "1", EXPORT_MCP: "success", PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const driver = new OpenCodeDriver({
    createRetryObserver,
    executable: `${import.meta.dir}/fixtures/opencode.ts`,
    root,
    cwd: root,
    env,
    redact: journal.redact,
  });
  const proofs: unknown[] = [];
  const context = {
    request: { sandboxId: "s", harness: "opencode" as const, text: "hello" },
    signal: new AbortController().signal,
    mcp: mcpConfiguration,
    emit: (event: import("../src/protocol.ts").DriverEvent) => {
      if (event.kind === "other" && event.type === "armada/opencodeMcp") proofs.push(event.data);
    },
    session: () => {},
  };
  try {
    journal.registerSecrets(["native MCP result"]);
    expect(await driver.start(context).done).toBe("finished");
    expect(proofs).toEqual([mcpReceipt("old").data]);
    const history = await readFile(join(root, "sessions/session-1.json"), "utf8");
    expect(history).not.toContain("native MCP result");
    expect(history).toContain("[REDACTED]");
    await expect(driver.resumeSession({ ...context, sessionId: "../other" })).rejects.toThrow(
      "invalid_harness_protocol",
    );
    proofs.length = 0;
    env.EXPORT_STAGE = "2";
    expect(await driver.start({ ...context, sessionId: "session-1" }).done).toBe("finished");
    expect(proofs).toEqual([mcpReceipt("new-tool").data]);
  } finally {
    await driver.close();
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Morph account reaches OpenCode through the generic compatible provider", async () => {
  const { resolveCredentials } = await import("../../core/src/credentials.ts");
  const { encryptSecret } = await import("../../core/src/crypto.ts");
  const key = Buffer.alloc(32, 7).toString("base64");
  const valueEnc = await encryptSecret("morph_test_key", key);
  const resolved = await resolveCredentials(
    {
      credentials: async () => [{ id: "account", kind: "morph", valueEnc }],
      orgBoatKey: async () => null,
    },
    key,
    { userId: "u", orgId: "o", harness: "opencode", credentialId: "account" },
  );
  configureOpenCodeEndpoint(resolved.env);
  expect(JSON.parse(resolved.env.OPENCODE_CONFIG_CONTENT!).provider.armada).toEqual({
    npm: "@ai-sdk/openai-compatible",
    name: "Armada model connection",
    options: { baseURL: "https://api.morphllm.com/v1", apiKey: "morph_test_key" },
    models: {
      "morph-kimik31": { name: "morph-kimik31" },
      "morph-dsv41flash": { name: "morph-dsv41flash" },
      "morph-dsv41flash-1017": { name: "morph-dsv41flash-1017" },
    },
  });
  expect(resolved.env.OPENCODE_API_KEY).toBeUndefined();
  expect(resolved.env[OPENCODE_ENDPOINT_ENV]).toBeUndefined();
});
