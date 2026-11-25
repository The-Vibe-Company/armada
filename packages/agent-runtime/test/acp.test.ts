import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestRefused } from "../src/errors.ts";
import { AcpDriver, AntigravityDriver, type DriverEvent, Journal } from "../src/index.ts";

import { executeWithReceipt } from "../src/request-receipts.ts";

// The real stdio transport owns load replay, cancel-response races and multi-turn usage attribution.
// The existing Runner tests cannot observe wire behavior inside a native harness process.
for (const action of ["finish", "steer", "interrupt", "unknown"] as const) {
  const checkPinnedMcp = action === "finish";
  const behavior = checkPinnedMcp ? " and sends pinned MCP configuration on load and new" : "";
  test(`ACP v1 ${action} preserves session identity and native usage without replay${behavior}`, async () => {
    const driver = new AcpDriver({
      executable: process.execPath,
      args: ["run", `${import.meta.dir}/fixtures/acp.ts`],
      cwd: "/tmp",
      env: checkPinnedMcp ? { EXPECT_PINNED_MCP: "1" } : {},
    });
    const events: DriverEvent[] = [];
    let observed!: () => void;
    const emitted = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const context = {
      request: {
        sandboxId: "s",
        harness: "opencode" as const,
        text: action === "steer" || action === "interrupt" ? "hold" : action === "finish" ? "DOCKER_OK" : action,
        model: "test/model",
      },
      ...(checkPinnedMcp
        ? {
            mcp: {
              revision: "fixture-mcp",
              servers: {
                local: {
                  type: "stdio" as const,
                  command: "npx",
                  args: ["--yes", "--", "fixture-mcp@1.2.3", "--local"],
                  env: { MCP_PRIVATE_VALUE: "fixture_private_value" },
                },
              },
            },
          }
        : {}),
      signal: new AbortController().signal,
      emit: (event: DriverEvent) => {
        events.push(event);
        if (event.kind === "message") observed();
      },
      session: (id: string) => expect(id).toBe("session-1"),
    };
    try {
      await driver.resumeSession({ ...context, sessionId: "session-1" });
      expect(events).toEqual([]);
      const turn = driver.start(
        checkPinnedMcp
          ? { ...context, session: (id) => expect(id).toBe("new-session") }
          : { ...context, sessionId: "session-1" },
      );
      if (action === "steer" || action === "interrupt") await Promise.race([emitted, turn.done]);
      if (action === "steer") await turn.steer("next");
      if (action === "interrupt") await turn.interrupt();
      expect(await turn.done).toBe(action === "interrupt" ? "interrupted" : "finished");
      expect(
        events
          .filter((e): e is Extract<DriverEvent, { kind: "message" }> => e.kind === "message" && e.partial)
          .map((e) => e.text),
      ).toEqual(
        action === "steer"
          ? ["hold", "next"]
          : action === "finish"
            ? ["D", "OCK", "ER", "_OK"]
            : [context.request.text],
      );
      if (action === "finish") {
        const command = `echo ${"x".repeat(250)}😀${"y".repeat(155)}`;
        const preview = command.slice(0, 255);
        const tools = events.flatMap((event) => (event.kind === "message" ? event.tools : []));
        expect(tools).toEqual([
          { id: expect.any(String), name: preview, input: command },
          { id: expect.any(String), name: "tool_result" },
          { id: expect.any(String), name: "tool_result", input: { title: command, rawInput: { cwd: "/tmp" } } },
          {
            id: expect.any(String),
            name: preview,
            input: { title: command, rawInput: { cwd: "/tmp" } },
          },
          { id: "tool", name: "shell" },
        ]);
        expect(tools[0]?.id).toBe(tools[1]?.id);
        expect(tools[0]?.id).toBe(tools[2]?.id);
        expect(tools[0]?.id).not.toBe(tools[3]?.id);
        for (const tool of tools) {
          expect(tool.id.length).toBeGreaterThan(0);
          expect(tool.id.length).toBeLessThanOrEqual(256);
          expect(tool.id).not.toContain("\0");
        }
      }
      const finals = events.filter((event) => event.kind === "message" && !event.partial && !event.tools.length);
      expect(finals.map((event) => (event.kind === "message" ? event.text : ""))).toEqual(
        action === "interrupt" ? [] : [action === "steer" ? "next" : context.request.text],
      );
      if (finals[0]?.kind === "message") {
        expect(finals[0].messageId).toEqual(expect.any(String));
        const lastChunk = events.findLast((event) => event.kind === "message" && event.partial);
        expect(finals[0]).toMatchObject({
          textMode: "snapshot",
          messageId: lastChunk?.kind === "message" ? lastChunk.messageId : undefined,
        });
      }
      const usage = events.filter((e) => e.kind === "other" && e.type === "armada/turnUsage");
      expect(usage).toHaveLength(1);
      expect(usage[0]?.kind === "other" ? usage[0].data : undefined).toMatchObject({
        model: "test/model",
        inputTokens: action === "steer" ? 7 : action === "interrupt" ? 4 : action === "unknown" ? null : 3,
        outputTokens: action === "steer" ? 3 : action === "interrupt" ? 1 : action === "unknown" ? null : 2,
      });
    } finally {
      await driver.close();
    }
  });
}
test("ACP names a turn cut by the model output limit instead of a configuration failure", async () => {
  const driver = new AcpDriver({
    executable: process.execPath,
    args: ["run", `${import.meta.dir}/fixtures/acp.ts`],
    cwd: "/tmp",
    env: {},
  });
  try {
    const turn = driver.start({
      request: { sandboxId: "s", harness: "opencode", text: "output-limit" },
      signal: new AbortController().signal,
      emit: () => {},
      session: () => {},
    });
    await expect(turn.done).rejects.toMatchObject({ code: "output_limit_exceeded" });
  } finally {
    await driver.close();
  }
});

test("ACP refuses another protocol before dispatching a prompt", async () => {
  const driver = new AcpDriver({
    executable: process.execPath,
    args: ["run", `${import.meta.dir}/fixtures/acp.ts`],
    cwd: "/tmp",
    env: { BAD_ACP: "1" },
  });
  try {
    await expect(
      driver.start({
        request: { sandboxId: "s", harness: "codex", text: "no" },
        signal: new AbortController().signal,
        emit: () => {
          throw Error("unexpected event");
        },
        session: () => {
          throw Error("unexpected session");
        },
      }).done,
    ).rejects.toThrow("invalid_harness_protocol");
  } finally {
    await driver.close();
  }
});

test("ACP bounds active retained long tool titles and frees budget on terminal or replaced calls", async () => {
  const driver = new AcpDriver({
    executable: process.execPath,
    args: ["run", `${import.meta.dir}/fixtures/acp.ts`],
    cwd: "/tmp",
    env: {},
  });
  try {
    const overBudget = driver.start({
      request: { sandboxId: "s", harness: "opencode", text: "tool-title-budget" },
      signal: new AbortController().signal,
      emit: () => {},
      session: () => {},
    });
    await expect(overBudget.done).rejects.toMatchObject({ code: "invalid_harness_protocol" });

    const events: DriverEvent[] = [];
    const completed = driver.start({
      request: { sandboxId: "s", harness: "opencode", text: "tool-title-completed" },
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      session: () => {},
    });
    expect(await completed.done).toBe("finished");

    const tools = events.flatMap((event) => (event.kind === "message" ? event.tools : []));
    const longTitle = `echo ${"x".repeat(32768)}`;
    expect(tools.find((tool) => tool.id === "done-0" && tool.result)).toMatchObject({
      id: "done-0",
      input: { title: longTitle, rawInput: { index: 0 } },
      result: { output: "ok", isError: false },
    });
    expect(tools.find((tool) => tool.id === "done-1" && tool.result)).toMatchObject({
      id: "done-1",
      input: { title: longTitle, rawInput: { index: 1 } },
      result: { output: "ok", isError: true },
    });
    expect(tools.findLast((tool) => tool.id === "replaced")).toMatchObject({
      id: "replaced",
      name: "tool_result",
      input: { title: `echo 33 ${"y".repeat(32768)}`, rawInput: { final: true } },
    });
  } finally {
    await driver.close();
  }
});

// A failed native telemetry channel cannot silently leave the active prompt running without wait visibility.
test("ACP observes native events before prompt and releases the observer when its stream fails", async () => {
  let rejectFailure!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  let ready = false;
  let closed = false;
  const driver = new AcpDriver({
    executable: process.execPath,
    args: ["run", `${import.meta.dir}/fixtures/acp.ts`],
    cwd: "/tmp",
    env: {},
    observation: {
      ready: async (sessionId) => {
        expect(sessionId).toBe("session-1");
        ready = true;
      },
      failed,
      close: async () => {
        closed = true;
      },
    },
  });
  try {
    const turn = driver.start({
      request: { sandboxId: "s", harness: "opencode", text: "hold" },
      signal: new AbortController().signal,
      session: () => {},
      emit: (event) => {
        if (event.kind === "message") {
          expect(ready).toBe(true);
          rejectFailure(new Error("observer_lost"));
        }
      },
    });
    await expect(turn.done).rejects.toThrow("observer_lost");
    expect(closed).toBe(true);
  } finally {
    await driver.close();
  }
});

// Definite pre-side-effect refusal at the driver boundary: no continuation exists to steer.
test("ACP refuses a steer after its turn stopped with a replayable refusal", async () => {
  const driver = new AcpDriver({
    executable: process.execPath,
    args: ["run", `${import.meta.dir}/fixtures/acp.ts`],
    cwd: "/tmp",
    env: {},
  });
  try {
    const turn = driver.start({
      request: { sandboxId: "s", harness: "opencode", text: "DOCKER_OK", model: "test/model" },
      signal: new AbortController().signal,
      emit: () => {},
      session: () => {},
    });
    expect(await turn.done).toBe("finished");
    await expect(turn.steer("too-late")).rejects.toBeInstanceOf(RequestRefused);
  } finally {
    await driver.close();
  }
});

// Preflight validation runs before the ACP child spawns, so the refusal is definite.
test("ACP refuses an unsupported reasoning effort before spawning the child", async () => {
  const driver = new AcpDriver({
    executable: process.execPath,
    args: ["run", `${import.meta.dir}/fixtures/acp.ts`],
    cwd: "/tmp",
    env: {},
  });
  try {
    expect(() =>
      driver.start({
        request: { sandboxId: "s", harness: "opencode", text: "hello", reasoningEffort: "high" },
        signal: new AbortController().signal,
        session: () => {},
        emit: () => {},
      }),
    ).toThrow(RequestRefused);
  } finally {
    await driver.close();
  }
});

function antigravityFixture(credential: ConstructorParameters<typeof AntigravityDriver>[0]["credential"]) {
  const root = mkdtempSync(join(tmpdir(), "antigravity-acp-"));
  const executable = join(root, "fake-acy.ts");
  writeFileSync(
    executable,
    `#!${process.execPath}\nimport ${JSON.stringify(`${import.meta.dir}/fixtures/acp.ts`)};\n`,
    {
      mode: 0o700,
    },
  );
  const registered: string[] = [];
  const events: DriverEvent[] = [];
  return {
    root,
    registered,
    events,
    driver: () =>
      new AntigravityDriver({
        executable,
        root,
        cwd: root,
        credential,
        githubTools: { root: join(root, "github-generation"), home: root },
        journal: {
          registerApplicationSecrets: (values) => {
            registered.push(...values);
          },
        },
      }),
    context: (text: string, model?: string) => ({
      request: { sandboxId: "s", harness: "opencode" as const, text, ...(model === undefined ? {} : { model }) },
      signal: new AbortController().signal,
      emit: (event: DriverEvent) => events.push(event),
      session: () => {},
    }),
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}

const antigravityTest = test.skipIf(process.platform !== "linux");

antigravityTest("Antigravity authenticates and selects a loaded ACP v1 model", async () => {
  const f = antigravityFixture({ method: "gemini-api-key", apiKey: "fixture-gemini-value" });
  try {
    await expect(
      f.driver().start({ ...f.context("explicit", "fixture/model"), sessionId: "session-1" }).done,
    ).resolves.toBe("finished");
  } finally {
    f.clean();
  }
});

antigravityTest("Antigravity refuses an unlisted model before sending a prompt", async () => {
  const f = antigravityFixture({ method: "gemini-api-key", apiKey: "fixture-gemini-value" });
  try {
    const done = f.driver().start(f.context("never-prompt", "unknown/model")).done;
    await expect(done).rejects.toBeInstanceOf(RequestRefused);
    await expect(done).rejects.toThrow("invalid_request");
  } finally {
    f.clean();
  }
});

for (const [apiKey, phase] of [
  ["refuse-fixture-key", "authentication"],
  ["banner-fixture-key", "authentication"],
  ["missing-session-auth-key", "session_start"],
] as const) {
  antigravityTest(`Antigravity safely reports authentication failure for ${apiKey}`, async () => {
    const f = antigravityFixture({ method: "gemini-api-key", apiKey });
    try {
      await expect(f.driver().start(f.context("never-prompt")).done).rejects.toMatchObject({
        message: "authentication_failed",
        reason: `authentication_failed:${phase}`,
      });
    } finally {
      f.clean();
    }
  });
}

antigravityTest(
  "Antigravity writes a private Google token file and redacts credentials echoed by the agent",
  async () => {
    const token = {
      access_token: "fixture-access-value",
      refresh_token: "fixture-refresh-value",
      expiry: "2026-11-20T18:00:00.123456789Z",
      token_type: "Bearer",
      expires_in: 3599,
    };
    const f = antigravityFixture({ method: "google", token });
    try {
      await expect(f.driver().start(f.context("echo-token", "default")).done).resolves.toBe("finished");
      const directory = join(f.root, "antigravity", "antigravity-acp");
      const file = join(directory, "antigravity-oauth-token");
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ token, auth_method: "consumer" });
      expect(f.registered).toEqual([token.access_token, token.refresh_token]);
      expect(f.events.some((event) => event.kind === "message" && event.text.includes("***"))).toBe(true);
      const tools = f.events.flatMap((event) => (event.kind === "message" ? event.tools : []));
      expect(tools).toEqual([
        {
          id: "fixture-tool",
          name: `${"a".repeat(254)}**`,
          input: { title: `${"a".repeat(254)}***`, rawInput: { "***": "echo" } },
        },
      ]);
      const streamed = f.events
        .flatMap((event) => (event.kind === "message" && event.partial ? [event.text] : []))
        .join("");
      expect(streamed).toBe(`*** *** ${token.expiry} ${token.token_type} ${token.expires_in}`);
      for (const value of f.registered) {
        expect(JSON.stringify(f.events)).not.toContain(value);
        expect(streamed).not.toContain(value);
      }
    } finally {
      f.clean();
    }
  },
);

antigravityTest("Antigravity refuses a symlinked Google token file", () => {
  const f = antigravityFixture({
    method: "google",
    token: { access_token: "fixture-access-value", refresh_token: "fixture-refresh-value" },
  });
  try {
    const directory = join(f.root, "antigravity", "antigravity-acp");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = join(f.root, "other");
    writeFileSync(target, "unchanged");
    symlinkSync(target, join(directory, "antigravity-oauth-token"));
    expect(() => f.driver()).toThrow("harness_initialization_failed");
    expect(readFileSync(target, "utf8")).toBe("unchanged");
  } finally {
    f.clean();
  }
});

antigravityTest("Antigravity passes the Gemini key only in a private child environment", async () => {
  const apiKey = "fixture-gemini-value";
  const f = antigravityFixture({ method: "gemini-api-key", apiKey });
  const ambient = [
    "GOOGLE_FIXTURE",
    "GCLOUD_PROJECT",
    "CLOUDSDK_CORE_PROJECT",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "BROWSER",
    "AGY_ACP_UNKNOWN",
    "SSH_CONNECTION",
    "GEMINI_API_KEY",
  ];
  const previous = ambient.map((name) => process.env[name]);
  try {
    for (const name of ambient) process.env[name] = "ambient-fixture-value";
    const driver = f.driver();
    expect(() => driver.configureReadableVariables({ GEMINI_API_KEY: "replacement" })).toThrow("invalid_request");
    expect(() => driver.configureReadableVariables({ GIT_CONFIG_GLOBAL: "/tmp/other-config" })).toThrow(
      "invalid_request",
    );
    driver.configureReadableVariables({ APP_REGION: "fixture-region" });
    await expect(driver.start(f.context("environment", "default")).done).resolves.toBe("finished");
    const event = f.events.find((value) => value.kind === "message" && !value.partial);
    expect(event?.kind === "message" && JSON.parse(event.text)).toEqual({
      argv: ["acp", "--gemini-dir", join(f.root, "antigravity"), "--app-data-dir", "antigravity-acp"],
      key: true,
      region: "fixture-region",
      isolated: true,
      privateEnvironment: true,
      gitHubTools: {
        firstPath: join(f.root, "github-generation", "bin"),
        bashEnv: join(f.root, "github-generation", "shell-env.sh"),
        gitConfig: join(f.root, ".gitconfig"),
        home: join(f.root, "antigravity"),
      },
    });
    expect(f.registered).toEqual([apiKey]);
  } finally {
    for (const [index, name] of ambient.entries()) {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    }
    f.clean();
  }
});

antigravityTest(
  "Antigravity credentials are scrubbed inside workspace command output before a receipt is written",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "antigravity-receipt-"));
    const journal = new Journal(":memory:", (text) => text);
    const apiKey = "key42";
    try {
      new AntigravityDriver({
        executable: join(root, "unused"),
        root,
        cwd: root,
        credential: { method: "gemini-api-key", apiKey },
        journal,
      });
      const response = await executeWithReceipt(
        journal,
        {
          version: 1,
          sandboxId: "sandbox",
          requestId: "workspace-receipt",
          op: "workspaceExec",
          input: { command: "fixture", cwd: root, timeoutSeconds: 1, phase: "init", index: 0, attempt: 1 },
        },
        async () => ({
          exitCode: 0,
          stdout: { text: `prefix${apiKey}suffix`, truncated: false },
          stderr: { text: "", truncated: false },
        }),
      );
      expect(await response.json()).toMatchObject({ result: { stdout: "prefix[REDACTED]suffix" } });
      expect(journal.db.query("SELECT body FROM requests WHERE id = ?").get("workspace-receipt")).toMatchObject({
        body: expect.stringContaining("prefix[REDACTED]suffix"),
      });
    } finally {
      journal.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
