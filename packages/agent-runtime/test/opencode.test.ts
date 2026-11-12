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
    executable: process.execPath,
    args: [`${import.meta.dir}/fixtures/opencode.ts`],
    root,
    cwd: root,
    env: {},
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
    const history = await readFile(join(root, "sessions/session-1.json"), "utf8");
    expect(history).not.toContain("private-key-for-test");
    expect(history).toContain("[REDACTED]");
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
      models: ["deepseek-chat"],
    }),
  };
  configureOpenCodeEndpoint(env);
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
  expect(config.enabled_providers).toEqual(["armada"]);
  expect(config.provider.armada).toMatchObject({
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: "https://api.deepseek.com/v1", apiKey: "fake-key" },
    models: { "deepseek-chat": { name: "deepseek-chat" } },
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
