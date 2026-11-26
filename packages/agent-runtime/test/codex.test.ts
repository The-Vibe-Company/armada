import { expect, jest, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, type Provider, promptOutcome } from "@armada/core";
import { codexTurnUsage, settleCodexTurnUsage } from "../src/codex-turn-usage.ts";
import { RequestRefused } from "../src/errors.ts";
import { CodexDriver, createRedactor, type DriverEvent, Journal, type Turn } from "../src/index.ts";
import { createNativeAuthRefresher, removeNativeCodexAuth } from "../src/native-auth.ts";

const nativeTest = process.platform === "linux" ? test : test.skip;

// Audit: actual JSONL child-process transport owns request/notification races and restart steering.
// Runtime fake tests cannot detect duplicate delivery or response-vs-terminal ordering here.
nativeTest("Codex waits for interrupt terminal then sends steer once on the same resumed thread", async () => {
  let started = false;
  const driver = new CodexDriver({
    executable: `${import.meta.dir}/fixtures/app-server.ts`,
    onStarted: () => {
      started = true;
    },
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ARMADA_RESUME_USAGE_BASELINE: "before" },
  });
  let turn: Turn | undefined;
  let steering: Promise<void> | undefined;
  const events: DriverEvent[] = [];
  const sessions: string[] = [];
  try {
    turn = driver.start({
      request: { sandboxId: "s", harness: "codex", text: "initial" },
      sessionId: "persisted-thread",
      signal: new AbortController().signal,
      session: (id) => sessions.push(id),
      emit: (event) => {
        expect(started).toBe(true); // Handshake stage must precede native turn output.
        events.push(event);
        if (event.kind === "message" && event.partial && !steering) steering = turn?.steer("redirect");
      },
    });
    expect(await turn.done).toBe("finished");
    await steering;
    expect(sessions).toEqual(["persisted-thread"]);
    // Account notifications have no threadId and must survive thread filtering.
    expect(events.filter((e) => e.kind === "other" && e.type === "account/rateLimits/updated")).toEqual([
      {
        kind: "other",
        type: "account/rateLimits/updated",
        data: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1794268800 },
            secondary: null,
          },
        },
      },
    ]);
    expect(events.filter((e) => e.kind === "message" && e.text === "redirect delivered once")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "other" && e.type === "turn/completed")).toHaveLength(2);
    expect(events.filter((e) => e.kind === "other" && e.type === "armada/turnUsage")).toEqual([
      {
        kind: "other",
        type: "armada/turnUsage",
        data: {
          model: "gpt-6.2-sol",
          inputTokens: 200,
          outputTokens: 40,
          cachedTokens: 60,
          cacheWriteTokens: 20,
          reasoningTokens: 8,
        },
      },
    ]);
  } finally {
    await driver.close();
  }
});

nativeTest("Codex usage snapshot includes all native turns restarted by steer within one Armada prompt", async () => {
  const driver = new CodexDriver({
    executable: `${import.meta.dir}/fixtures/app-server.ts`,
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  let turn: Turn | undefined;
  let steering: Promise<void> | undefined;
  const events: DriverEvent[] = [];
  try {
    turn = driver.start({
      request: { sandboxId: "s", harness: "codex", text: "initial" },
      signal: new AbortController().signal,
      session: () => {},
      emit: (event) => {
        events.push(event);
        if (event.kind === "message" && event.partial && !steering) steering = turn?.steer("redirect");
      },
    });
    expect(await turn.done).toBe("finished");
    await steering;
    expect(events.filter((e) => e.kind === "other" && e.type === "armada/turnUsage")).toEqual([
      {
        kind: "other",
        type: "armada/turnUsage",
        data: {
          model: "gpt-6.2-sol",
          inputTokens: 200,
          outputTokens: 40,
          cachedTokens: 60,
          cacheWriteTokens: 20,
          reasoningTokens: 8,
        },
      },
    ]);
  } finally {
    await driver.close();
  }
});

// Sanitized terminal captured from pinned 0.167.0 in opt-in Boat smoke. No provider text or credentials.
nativeTest.each([
  ["recorded-failure", "harness_failed"],
  ["unauthorized", "authentication_failed"],
  ["usageLimitExceeded", "usage_limit_exceeded"],
  ["output-limit", "output_limit_exceeded"],
])("Codex terminal %s is a typed failure, never successful completion", async (text, code) => {
  const driver = new CodexDriver({
    executable: `${import.meta.dir}/fixtures/app-server.ts`,
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", OPENAI_API_KEY: "synthetic-not-a-real-key" },
  });
  const events: DriverEvent[] = [];
  try {
    const turn = driver.start({
      request: { sandboxId: "s", harness: "codex", text },
      signal: new AbortController().signal,
      session: () => {},
      emit: (e) => {
        events.push(e);
      },
    });
    await expect(turn.done).rejects.toMatchObject({ code });
    expect(events.filter((e) => e.kind === "other" && e.type === "turn/completed")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "other" && e.type === "armada/turnUsage")).toEqual([
      {
        kind: "other",
        type: "armada/turnUsage",
        data: {
          model: "gpt-6.2-sol",
          inputTokens: 100,
          outputTokens: 20,
          cachedTokens: 30,
          cacheWriteTokens: 10,
          reasoningTokens: 4,
        },
      },
    ]);
  } finally {
    await driver.close();
  }
});

nativeTest("Codex reports malformed JSON buffered after a terminal notification", async () => {
  const driver = new CodexDriver({
    executable: `${import.meta.dir}/fixtures/app-server.ts`,
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  const events: DriverEvent[] = [];
  try {
    const turn = driver.start({
      request: { sandboxId: "s", harness: "codex", text: "malformed-protocol" },
      signal: new AbortController().signal,
      session: () => {},
      emit: (event) => events.push(event),
    });
    await expect(turn.done).rejects.toMatchObject({
      code: "invalid_harness_protocol",
      cause: expect.any(SyntaxError),
    });
    expect(events.find((event) => event.kind === "other" && event.type === "harness_stderr")).toMatchObject({
      data: { exitCode: null, signal: "SIGKILL", text: "fixture diagnostic\n" },
    });
  } finally {
    await driver.close();
  }
});

// JSONL process boundary is independent of the Claude SDK's argv serialization risk.
nativeTest(
  "Codex delivers MCP header and stdio env only through private JSONL, not native argv or global env",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "armada-codex-mcp-"));
    const receipt = join(root, "inspection.json");
    const driver = new CodexDriver({
      executable: `${import.meta.dir}/fixtures/app-server.ts`,
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, CODEX_HOME: root, ARMADA_MCP_INSPECTION: receipt },
    });
    const toolEvents: DriverEvent[] = [];
    try {
      const turn = driver.start({
        request: { sandboxId: "s", harness: "codex", text: "redirect" },
        signal: AbortSignal.timeout(3000),
        session: () => {},
        emit: (event) => toolEvents.push(event),
        mcp: {
          revision: "r1",
          servers: {
            remote: {
              type: "http",
              url: "https://example.invalid/mcp",
              headers: { Authorization: "mcp-header-fixture-sensitive" },
            },
            local: {
              type: "stdio",
              command: "fixture-command",
              env: { PRIVATE_MCP_VALUE: "mcp-env-fixture-sensitive" },
            },
          },
        },
      });
      expect(await turn.done).toBe("finished");
      expect(
        toolEvents.some(
          (e) =>
            e.kind === "message" &&
            e.tools.some((t) => t.server === "remote" && t.name === "read_fixture" && t.result?.isError === false),
        ),
      ).toBe(true);
      expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({
        argvLeak: false,
        environmentLeak: false,
        configured: true,
      });
    } finally {
      await driver.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

// The real JSONL child records every request: a fabricated native proof or accidental
// first turn cannot hide behind a fake Driver or an echoed journal identifier.
nativeTest(
  "Codex no-text verification resumes the stored thread without creating a thread or starting a turn",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "armada-codex-resume-"));
    const driver = new CodexDriver({
      executable: `${import.meta.dir}/fixtures/app-server.ts`,
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ARMADA_CWD_PROOF: "1" },
    });
    try {
      const native = await driver.resumeSession({
        request: { sandboxId: "s", harness: "codex", model: "gpt-6.1-sol" },
        sessionId: "persisted-native",
        signal: new AbortController().signal,
      });
      expect(native).toEqual({ sessionId: "persisted-native" });
      const records = JSON.parse(await readFile(join(root, "native-cwd-proof.json"), "utf8")) as {
        method: string;
        text: string | null;
      }[];
      expect(records.map((r) => r.method)).toEqual(["initialize", "initialized", "thread/resume"]);
      expect(records.every((r) => r.text === null)).toBe(true);
    } finally {
      await driver.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

nativeTest.each(["thread", "model"])(
  "Codex no-text verification rejects a mismatched native %s response",
  async (mismatch) => {
    const driver = new CodexDriver({
      executable: `${import.meta.dir}/fixtures/app-server.ts`,
      cwd: import.meta.dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ARMADA_NATIVE_RESUME_MISMATCH: mismatch },
    });
    try {
      await expect(
        driver.resumeSession({
          request: { sandboxId: "s", harness: "codex", model: "gpt-6.1-sol" },
          sessionId: "persisted-native",
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(mismatch === "thread" ? "native_session_identity_changed" : "native_session_model_changed");
    } finally {
      await driver.close();
    }
  },
);

nativeTest.each(["reported", "unavailable"])(
  "native account snapshot %s stays private and never blocks the coding turn",
  async (mode) => {
    const driver = new CodexDriver({
      executable: `${import.meta.dir}/fixtures/app-server.ts`,
      cwd: import.meta.dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        CODEX_HOME: import.meta.dir,
        ...(mode === "unavailable" ? { ARMADA_QUOTA_UNAVAILABLE: "1" } : {}),
      },
    });
    const events: DriverEvent[] = [];
    try {
      const turn = driver.start({
        request: { sandboxId: "s", harness: "codex", text: "redirect" },
        signal: AbortSignal.timeout(3000),
        session: () => {},
        emit: (event) => {
          events.push(event);
        },
      });
      expect(await turn.done).toBe("finished");
      const snapshot = events.find((event) => event.kind === "other" && event.type === "account/rateLimits/read");
      if (mode === "reported")
        expect(snapshot).toMatchObject({
          data: {
            rateLimits: { credits: { hasCredits: false, unlimited: false, balance: "0" } },
            rateLimitsByLimitId: { review: { credits: { balance: "12.3400" } } },
          },
        });
      else expect(snapshot).toBeUndefined();
      expect(events.filter((event) => event.kind === "message").every((event) => !event.text.includes("12.3400"))).toBe(
        true,
      );
    } finally {
      await driver.close();
    }
  },
);

nativeTest.each([true, false])(
  "native renewable writer admission is exclusive only when managed (%s)",
  async (exclusiveAuth) => {
    const driver = new CodexDriver({
      executable: `${import.meta.dir}/fixtures/app-server.ts`,
      cwd: import.meta.dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      exclusiveAuth,
    });
    const turns: Turn[] = [];
    const start = () => {
      let ready!: () => void;
      const partial = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const turn = driver.start({
        request: { sandboxId: "s", harness: "codex", text: "initial" },
        signal: new AbortController().signal,
        session() {},
        emit(event) {
          if (event.kind === "message") ready();
        },
      });
      turns.push(turn);
      return { turn, partial };
    };
    try {
      const first = start();
      await first.partial;
      if (exclusiveAuth) expect(start).toThrow("native_auth_writer_busy");
      else await start().partial;
      await Promise.all(
        turns.map(async (turn) => {
          await turn.interrupt();
          await turn.done;
        }),
      );
      const next = start();
      await next.partial;
      await next.turn.interrupt();
      expect(await next.turn.done).toBe("interrupted");
    } finally {
      await driver.close();
    }
  },
);

nativeTest("external subscription refresh completes an already-running Codex turn over private RPC", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-shared-native-"));
  await mkdir(join(root, "codex"), { mode: 0o700 });
  await writeFile(
    join(root, "codex/auth.json"),
    JSON.stringify({
      tokens: {
        access_token: "synthetic-retired-access",
        refresh_token: "synthetic-retired-refresh",
        account_id: "synthetic-account",
      },
    }),
    { mode: 0o600 },
  );
  const retired: string[] = [];
  removeNativeCodexAuth(root, (values) => retired.push(...values));
  await expect(readFile(join(root, "codex/auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(createRedactor(retired)("synthetic-retired-access synthetic-retired-refresh")).toBe("[REDACTED] [REDACTED]");
  const requests: boolean[] = [];
  const events: DriverEvent[] = [];
  const driver = new CodexDriver({
    executable: `${import.meta.dir}/fixtures/app-server.ts`,
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ARMADA_EXTERNAL_AUTH: "1", CODEX_HOME: join(root, "codex") },
    subscriptionAccess: async (refresh) => {
      requests.push(refresh);
      return {
        accessToken: refresh ? "synthetic-refreshed-access" : "synthetic-initial-access",
        chatgptAccountId: "synthetic-account",
        chatgptPlanType: null,
      };
    },
  });
  try {
    const turn = driver.start({
      request: { sandboxId: "s", harness: "codex", text: "continue through renewal" },
      signal: new AbortController().signal,
      session: () => {},
      emit: (event) => events.push(event),
    });
    expect(await turn.done).toBe("finished");
    expect(requests).toEqual([false, true]);
    expect(events).toContainEqual({
      kind: "message",
      text: "renewed turn completed",
      partial: false,
      tools: [],
      messageId: "renewed",
      textMode: "snapshot",
    });
    expect(JSON.stringify(events)).not.toContain("synthetic-refreshed-access");
    expect(JSON.stringify(events)).not.toContain("account/chatgptAuthTokens/refresh");
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});

nativeTest.each([
  [
    "usageLimitExceeded",
    { primary: { usedPercent: 100, resetsAt: 1794268800 }, secondary: { usedPercent: 25, resetsAt: 1894268800 } },
    "2026-11-10T00:00:00.000Z",
    "updated",
  ],
  [
    "usageLimitExceeded",
    { primary: { usedPercent: 100, resetsAt: "private-vendor-error-body" } },
    undefined,
    "updated",
  ],
  ["usageLimitExceeded", { primary: { usedPercent: 25, resetsAt: 1794268800 } }, undefined, "updated"],
  ["usageLimitExceeded", { primary: { usedPercent: 100, resetsAt: 1794268800 } }, "2026-11-10T00:00:00.000Z", "read"],
  ["usageLimitExceeded", { primary: { usedPercent: 100, resetsAt: 1794268800 } }, "2026-11-10T00:20:00.000Z", "raced"],
] as const)(
  "native %s preserves only exhausted-window reset evidence in public outcomes (%j; reset=%s; source=%s)",
  async (text, snapshot, resetsAt, source) => {
    const events: DriverEvent[] = [];
    const driver = new CodexDriver({
      executable: `${import.meta.dir}/fixtures/app-server.ts`,
      cwd: import.meta.dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        ARMADA_LIMITS: JSON.stringify({ limitId: "codex", ...snapshot }),
        ARMADA_LIMIT_SOURCE: source,
        ...(source !== "updated" ? { CODEX_HOME: "synthetic-codex-home" } : {}),
      },
    });
    try {
      const turn = driver.start({
        request: { sandboxId: "s", harness: "codex", text },
        signal: new AbortController().signal,
        session: () => {},
        emit: (event) => events.push(event),
      });
      const code = "usage_limit_exceeded";
      await expect(turn.done).rejects.toMatchObject({ code });
      const publicEvents = events.filter(
        (event) =>
          event.kind !== "other" || !["account/rateLimits/updated", "account/rateLimits/read"].includes(event.type),
      );
      expect(JSON.stringify(publicEvents)).not.toContain("private-vendor-error-body");
      const limit = { code, ...(resetsAt ? { resetsAt } : {}) };
      expect(publicEvents.find((event) => event.kind === "other" && event.type === "usage_limit")).toMatchObject({
        data: limit,
      });
      const outcome = await promptOutcome(
        { id: "modal" } as Provider,
        { sandboxId: "s", promptId: "p" },
        {
          state: { promptId: "p", status: "failed", done: true },
          events: [
            ...publicEvents.map((event, i) => ({ ...event, id: String(i), at: i, promptId: "p" }) as AgentEvent),
            { kind: "prompt", id: "failed", at: 100, promptId: "p", text: "", status: "failed", reason: code },
          ],
        },
      );
      expect(outcome).toMatchObject({ state: "failed", limit });
      expect(outcome.state === "failed" && outcome.reason).toContain(resetsAt ?? "Try again after the limit resets.");
    } finally {
      await driver.close();
    }
  },
);

// Real JSONL driver boundary: native resolution is independent of requested/default model.
nativeTest.each([
  { requested: undefined, resumed: false, native: "native-selected", reroute: "", expected: "native-selected" },
  { requested: "requested-alias", resumed: false, native: "native-selected", reroute: "", expected: "native-selected" },
  { requested: "requested-alias", resumed: true, native: "native-selected", reroute: "", expected: "native-selected" },
  { requested: "requested-alias", resumed: false, native: "missing", reroute: "", expected: null },
  { requested: undefined, resumed: false, native: "native-selected", reroute: "current", expected: null },
  { requested: undefined, resumed: false, native: "native-selected", reroute: "foreign", expected: "native-selected" },
])("Codex usage trusts native model metadata (%j)", async ({ requested, resumed, native, reroute, expected }) => {
  const root = await mkdtemp(join(tmpdir(), "armada-codex-model-"));
  const events: DriverEvent[] = [];
  const driver = new CodexDriver({
    executable: `${import.meta.dir}/fixtures/app-server.ts`,
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ARMADA_CWD_PROOF: "1",
      ARMADA_USAGE_MODEL: native,
      ARMADA_USAGE_REROUTE: reroute,
    },
  });
  try {
    const turn = driver.start({
      request: { sandboxId: "s", harness: "codex", text: "redirect", ...(requested ? { model: requested } : {}) },
      ...(resumed ? { sessionId: "persisted-thread" } : {}),
      signal: AbortSignal.timeout(3000),
      session: () => {},
      emit: (event) => {
        events.push(event);
      },
    });
    expect(await turn.done).toBe("finished");
    const usage = events.filter((event) => event.kind === "other" && event.type === "armada/turnUsage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ data: { model: expected, inputTokens: resumed ? null : 100 } });
    const calls = JSON.parse(await readFile(join(root, "native-cwd-proof.json"), "utf8")) as {
      method: string;
      model: string | null;
    }[];
    expect(calls.find((call) => call.method === (resumed ? "thread/resume" : "thread/start"))?.model).toBe(
      requested ?? null,
    );
    expect(calls.find((call) => call.method === "turn/start")?.model).toBe(native === "missing" ? null : native);
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Native baseline timing is independent of current-turn totals and `last` request counters.
nativeTest.each(["before", "after", "partial", "foreign", "invalid", "regressed", "lost-optional", "late"])(
  "Codex resumed baseline %s is adopted only before dispatch on the verified thread",
  async (mode) => {
    const driver = new CodexDriver({
      executable: `${import.meta.dir}/fixtures/app-server.ts`,
      cwd: import.meta.dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        ARMADA_RESUME_USAGE_BASELINE: mode,
        ...(mode === "after" ? { CODEX_HOME: import.meta.dir } : {}),
      },
    });
    const events: DriverEvent[] = [];
    try {
      if (mode === "invalid") {
        const seed = driver.start({
          request: { sandboxId: "s", harness: "codex", text: "redirect" },
          signal: AbortSignal.timeout(3000),
          session() {},
          emit() {},
        });
        expect(await seed.done).toBe("finished");
      }
      const turn = driver.start({
        request: { sandboxId: "s", harness: "codex", text: "redirect" },
        sessionId: mode === "invalid" ? "fixture-thread" : "persisted-thread",
        signal: AbortSignal.timeout(3000),
        session() {},
        emit(event) {
          events.push(event);
        },
      });
      expect(await turn.done).toBe("finished");
      const measured = mode === "before" || mode === "after" || mode === "partial";
      expect(events.filter((event) => event.kind === "other" && event.type === "armada/turnUsage")).toEqual([
        {
          kind: "other",
          type: "armada/turnUsage",
          data: {
            model: "gpt-6.2-sol",
            inputTokens: measured ? 100 : null,
            outputTokens: measured ? 20 : null,
            cachedTokens: measured ? 30 : null,
            cacheWriteTokens: measured && mode !== "partial" ? 10 : null,
            reasoningTokens: measured && mode !== "partial" ? 4 : null,
          },
        },
      ]);
    } finally {
      await driver.close();
    }
  },
);

test("Codex process loss cannot publish partial resumed totals or seed the next prompt baseline", () => {
  const baseline = {
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 30,
    cacheWriteInputTokens: 10,
    reasoningOutputTokens: 4,
  };
  const partial = {
    inputTokens: 200,
    outputTokens: 40,
    cachedInputTokens: 60,
    cacheWriteInputTokens: 20,
    reasoningOutputTokens: 8,
  };
  const threadId = "persisted-thread";
  const tokenTotals = new Map([[threadId, partial]]);
  const latest = codexTurnUsage(partial, baseline);
  expect(latest).toMatchObject({ inputTokens: 100, outputTokens: 20, cachedTokens: 30 });
  expect(
    settleCodexTurnUsage({
      tokenTotals,
      threadId,
      dispatched: true,
      terminalObserved: false,
      latest,
      model: "gpt-6.2-sol",
    }),
  ).toEqual({
    model: "gpt-6.2-sol",
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  });

  // The next prompt supplies only a post-dispatch total.
  const next = { inputTokens: 300, outputTokens: 60, cachedInputTokens: 90 };
  expect(codexTurnUsage(next, tokenTotals.get(threadId) ?? null)).toEqual({
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
  });
});

// Captured native ordering, not an inferred pre-turn baseline: the old total
// arrives only after dispatch, followed by the new cumulative total.
nativeTest("recorded cold Codex resume publishes one unknown snapshot, never historical totals", async () => {
  const driver = new CodexDriver({
    executable: `${import.meta.dir}/fixtures/recorded-resume.ts`,
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  const events: DriverEvent[] = [];
  try {
    expect(
      await driver.start({
        request: { sandboxId: "s", harness: "codex", text: "Reply OK" },
        sessionId: "recorded-thread",
        signal: new AbortController().signal,
        session: () => {},
        emit: (e) => events.push(e),
      }).done,
    ).toBe("finished");
    expect(events.filter((e) => e.kind === "other" && e.type === "armada/turnUsage")).toEqual([
      {
        kind: "other",
        type: "armada/turnUsage",
        data: {
          model: "gpt-6.1-sol",
          inputTokens: null,
          outputTokens: null,
          cachedTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
        },
      },
    ]);
  } finally {
    await driver.close();
  }
});

// One driver-boundary regression: actual native notification ordering plus
// persisted token_count fields; no provider/server duplicate of this contract.
nativeTest.each(["closed", "after-abort", "unclosed", "wrong-session", "corrupt"])(
  "cold Codex resume validates persisted history: %s",
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), "codex-resume-"));
    const path = join(dir, "rollout.jsonl");
    const recording = await import("./fixtures/codex-resume-recorded.json");
    const total = recording.default.find((e) => e.phase === "fresh" && e.method === "thread/tokenUsage/updated")!
      .params!.tokenUsage.total;
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: mode === "wrong-session" ? "unrelated-thread" : "recorded-thread" },
        }),
        ...(mode === "after-abort"
          ? [
              JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "aborted" } }),
              JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "aborted" } }),
            ]
          : []),
        JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "recorded-fresh" } }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: "history\u2028text\u2029continues" },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: total.inputTokens,
                output_tokens: total.outputTokens,
                cached_input_tokens: total.cachedInputTokens,
                cache_write_input_tokens: total.cacheWriteInputTokens,
                reasoning_output_tokens: total.reasoningOutputTokens,
              },
            },
          },
        }),
        ...(mode === "unclosed"
          ? []
          : [JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "recorded-fresh" } })]),
        ...(mode === "corrupt" ? ["not-json"] : []),
      ].join("\n") + "\n",
    );
    const driver = new CodexDriver({
      executable: `${import.meta.dir}/fixtures/recorded-resume.ts`,
      cwd: import.meta.dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ARMADA_TEST_ROLLOUT: path },
    });
    const events: DriverEvent[] = [];
    try {
      expect(
        await driver.start({
          request: { sandboxId: "s", harness: "codex", text: "Reply OK" },
          sessionId: "recorded-thread",
          signal: new AbortController().signal,
          session: () => {},
          emit: (e) => events.push(e),
        }).done,
      ).toBe("finished");
      expect(events.filter((e) => e.kind === "other" && e.type === "armada/turnUsage")).toEqual([
        {
          kind: "other",
          type: "armada/turnUsage",
          data: {
            model: "gpt-6.1-sol",
            inputTokens: mode === "closed" || mode === "after-abort" ? 13163 : null,
            outputTokens: mode === "closed" || mode === "after-abort" ? 5 : null,
            cachedTokens: mode === "closed" || mode === "after-abort" ? 13140 : null,
            cacheWriteTokens: mode === "closed" || mode === "after-abort" ? 20 : null,
            reasoningTokens: mode === "closed" || mode === "after-abort" ? 0 : null,
          },
        },
      ]);
    } finally {
      await driver.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

nativeTest("Codex journals a terminal rate limit and remains interruptible during backoff", async () => {
  const controller = new AbortController();
  const events: DriverEvent[] = [];
  const driver = new CodexDriver({
    executable: `${import.meta.dir}/fixtures/app-server.ts`,
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", OPENAI_API_KEY: "synthetic-not-a-real-key" },
  });
  try {
    const turn = driver.start({
      request: { sandboxId: "s", harness: "codex", text: "rateLimitExceeded" },
      signal: controller.signal,
      session: () => {},
      emit: (event) => {
        events.push(event);
        if (event.kind === "other" && event.type === "armada/modelRateLimit") controller.abort();
      },
    });
    expect(await turn.done).toBe("interrupted");
    expect(events.find((event) => event.kind === "other" && event.type === "armada/modelRateLimit")).toMatchObject({
      data: { retryCount: 1 },
    });
  } finally {
    await driver.close();
  }
});

nativeTest("Codex resumes the same thread after throttling without a real wait", async () => {
  const events: DriverEvent[] = [];
  const sessions: string[] = [];
  const driver = new CodexDriver({
    executable: `${import.meta.dir}/fixtures/app-server.ts`,
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", OPENAI_API_KEY: "synthetic-not-a-real-key" },
  });
  try {
    const turn = driver.start({
      request: { sandboxId: "s", harness: "codex", text: "rateLimitExceeded" },
      signal: new AbortController().signal,
      session: (id) => sessions.push(id),
      emit: (event) => {
        events.push(event);
        if (event.kind === "other" && event.type === "armada/modelRateLimit") {
          jest.useFakeTimers();
          queueMicrotask(() => {
            jest.advanceTimersByTime(1000);
            jest.useRealTimers();
          });
        }
      },
    });
    expect(await turn.done).toBe("finished");
    expect(sessions).toHaveLength(1);
    expect(events.filter((e) => e.kind === "other" && e.type === "armada/modelRateLimit")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "message" && e.text === "redirect delivered once")).toHaveLength(1);
  } finally {
    jest.useRealTimers();
    await driver.close();
  }
});

nativeTest.each(["interrupt", "steer"] as const)(
  "Codex %s during model backoff needs no native interrupt",
  async (action) => {
    const driver = new CodexDriver({
      executable: `${import.meta.dir}/fixtures/app-server.ts`,
      cwd: import.meta.dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", OPENAI_API_KEY: "synthetic-not-a-real-key" },
    });
    let turn: Turn;
    let actionDone: Promise<void> | undefined;
    try {
      turn = driver.start({
        request: { sandboxId: "s", harness: "codex", text: "rateLimitExceeded" },
        signal: new AbortController().signal,
        session: () => {},
        emit: (event) => {
          if (event.kind === "other" && event.type === "armada/modelRateLimit") {
            queueMicrotask(() => {
              actionDone = action === "interrupt" ? turn.interrupt() : turn.steer("redirect");
            });
          }
        },
      });
      expect(await turn.done).toBe(action === "interrupt" ? "interrupted" : "finished");
      await actionDone;
    } finally {
      await driver.close();
    }
  },
);

// Definite pre-side-effect refusal at the driver boundary: the app-server turn is closed.
nativeTest("Codex refuses a steer after its turn closed with a replayable refusal", async () => {
  const driver = new CodexDriver({
    executable: `${import.meta.dir}/fixtures/app-server.ts`,
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  try {
    const turn = driver.start({
      request: { sandboxId: "s", harness: "codex", text: "message-semantics" },
      signal: new AbortController().signal,
      session: () => {},
      emit: () => {},
    });
    expect(await turn.done).toBe("finished");
    await expect(turn.steer("too-late")).rejects.toBeInstanceOf(RequestRefused);
  } finally {
    await driver.close();
  }
});

nativeTest("Codex recovers a poisoned thread with visible context and resumes the saved replacement", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "armada-codex-recovery-"));
  const journal = new Journal(":memory:", (value) => value);
  const driver = new CodexDriver({
    executable: `${import.meta.dir}/fixtures/app-server.ts`,
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ARMADA_HYDRATION_FAILURE: "1", ARMADA_CWD_PROOF: "1" },
  });
  journal.saveSession("conversation", "codex", "poisoned-thread");
  const start = (text: string) => {
    const sessionId = journal.session("conversation");
    return driver.start({
      request: { sandboxId: "s", harness: "codex", text },
      ...(sessionId ? { sessionId } : {}),
      signal: new AbortController().signal,
      session: (...session) => journal.saveSession("conversation", "codex", ...session),
      emit: () => {},
    });
  };
  try {
    expect(await start("Review the migration").done).toBe("finished");
    expect(journal.session("conversation")).toBe("recovered-thread");
    expect(await start("Check the diff").done).toBe("finished");
    const records = JSON.parse(await readFile(join(cwd, "native-cwd-proof.json"), "utf8"));
    const prompts = records.filter((record: { method: string }) => record.method === "turn/start");
    expect(prompts).toHaveLength(3);
    expect(prompts[1].text).toContain("The migration is already committed.");
    expect(prompts[1].text).toContain("Review the migration");
    expect(prompts[1].text).not.toContain("opaque-history-must-stay-behind");
    expect(prompts[2].text).toBe("Check the diff");
  } finally {
    await driver.close();
    journal.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

nativeTest("Codex never replays a hydration failure after a tool started", async () => {
  const journal = new Journal(":memory:", (value) => value);
  journal.saveSession("conversation", "codex", "poisoned-thread");
  const driver = new CodexDriver({
    executable: `${import.meta.dir}/fixtures/app-server.ts`,
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ARMADA_HYDRATION_FAILURE: "after-tool" },
  });
  try {
    const turn = driver.start({
      request: { sandboxId: "s", harness: "codex", text: "Run the command" },
      sessionId: "poisoned-thread",
      signal: new AbortController().signal,
      session: (...session) => journal.saveSession("conversation", "codex", ...session),
      emit: () => {},
    });
    await expect(turn.done).rejects.toThrow("harness_failed");
    expect(journal.session("conversation")).toBe("poisoned-thread");
  } finally {
    await driver.close();
    journal.close();
  }
});

nativeTest(
  "Codex pipelines rateLimits/read without blocking turn/start and starts subscriptionAccess with initialize",
  async () => {
    const order: string[] = [];
    const driver = new CodexDriver({
      executable: `${import.meta.dir}/fixtures/app-server.ts`,
      cwd: import.meta.dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        CODEX_HOME: import.meta.dir,
        ARMADA_HANG_RATE_LIMITS: "1",
        ARMADA_EXTERNAL_AUTH: "1",
      },
      onStarted: () => order.push("onStarted"),
      subscriptionAccess: async (refresh) => {
        order.push(`subscriptionAccess:${refresh}`);
        return {
          accessToken: refresh ? "synthetic-refreshed-access" : "synthetic-initial-access",
          chatgptAccountId: "synthetic-account",
          chatgptPlanType: null,
        };
      },
    });
    try {
      const turn = driver.start({
        request: { sandboxId: "s", harness: "codex", text: "continue through renewal" },
        signal: AbortSignal.timeout(1000),
        session: () => {},
        emit: () => {},
      });
      expect(await turn.done).toBe("finished");
      expect(order.slice(0, 2)).toEqual(["subscriptionAccess:false", "onStarted"]);
    } finally {
      await driver.close();
    }
  },
);

nativeTest(
  "stat-cached native auth refresher skips unchanged auth.json, reloads rotations, and enforces safety",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "armada-auth-cache-"));
    const codexDir = join(root, "codex");
    const authPath = join(codexDir, "auth.json");
    await mkdir(codexDir, { mode: 0o700 });
    const initial = JSON.stringify({ tokens: { access_token: "synthetic-token-1" } });
    const rotated = JSON.stringify({ tokens: { access_token: "synthetic-token-2-rotated" } });
    await writeFile(authPath, initial, { mode: 0o600 });
    let registerCalls = 0;
    const changes: (string | undefined)[] = [];
    const refresh = createNativeAuthRefresher(
      root,
      () => registerCalls++,
      (auth) => changes.push(auth),
    );
    try {
      refresh();
      refresh();
      refresh();
      expect([registerCalls, changes]).toEqual([1, [initial]]);
      await writeFile(join(codexDir, "auth.json.next"), rotated, { mode: 0o600 });
      await rename(join(codexDir, "auth.json.next"), authPath);
      refresh();
      refresh();
      expect([registerCalls, changes]).toEqual([2, [initial, rotated]]);
      await chmod(authPath, 0o644);
      expect(() => refresh()).toThrow("native_auth_state_unavailable");
      await rm(authPath);
      await writeFile(join(root, "other"), initial, { mode: 0o600 });
      await symlink(join(root, "other"), authPath);
      expect(() => refresh()).toThrow("native_auth_state_unavailable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
