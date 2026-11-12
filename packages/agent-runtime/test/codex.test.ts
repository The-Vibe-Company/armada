import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, type Provider, promptOutcome } from "@armada/core";
import { CodexDriver, type DriverEvent, type Turn } from "../src/index.ts";

const nativeTest = process.platform === "linux" ? test : test.skip;

// Audit: actual JSONL child-process transport owns request/notification races and restart steering.
// Runtime fake tests cannot detect duplicate delivery or response-vs-terminal ordering here.
nativeTest("Codex waits for interrupt terminal then sends steer once on the same resumed thread", async () => {
  const driver = new CodexDriver({
    executable: `${import.meta.dir}/fixtures/app-server.ts`,
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
          model: "gpt-6.1-sol",
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
          model: "gpt-6.1-sol",
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
  ["rateLimitExceeded", "rate_limited"],
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
          model: "gpt-6.1-sol",
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
    try {
      const turn = driver.start({
        request: { sandboxId: "s", harness: "codex", text: "redirect" },
        signal: AbortSignal.timeout(3000),
        session: () => {},
        emit: () => {},
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
  const requests: boolean[] = [];
  const events: DriverEvent[] = [];
  const driver = new CodexDriver({
    executable: `${import.meta.dir}/fixtures/app-server.ts`,
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ARMADA_EXTERNAL_AUTH: "1" },
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
    "rateLimitExceeded",
    { primary: { usedPercent: 100, resetsAt: 1794268800 }, secondary: { usedPercent: 100, resetsAt: 1794270000 } },
    "2026-11-10T00:20:00.000Z",
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
      const code = text === "rateLimitExceeded" ? "rate_limited" : "usage_limit_exceeded";
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
            model: "gpt-6.1-sol",
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

nativeTest("Codex process loss cannot publish partial resumed totals or seed the next prompt baseline", async () => {
  const driver = new CodexDriver({
    executable: `${import.meta.dir}/fixtures/app-server.ts`,
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ARMADA_RESUME_USAGE_BASELINE: "before" },
  });
  const events: DriverEvent[] = [];
  const start = (text: string) =>
    driver.start({
      request: { sandboxId: "s", harness: "codex", text },
      sessionId: "persisted-thread",
      signal: AbortSignal.timeout(3000),
      session() {},
      emit(event) {
        events.push(event);
      },
    });
  try {
    await expect(start("usage-process-lost").done).rejects.toMatchObject({ code: "harness_process_lost" });
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
    events.length = 0;
    // The synthetic next peer supplies only a post-dispatch total; no new pre-turn baseline.
    driver.configureReadableVariables({ ARMADA_RESUME_USAGE_BASELINE: "late" });
    expect(await start("redirect").done).toBe("finished");
    expect(events.find((e) => e.kind === "other" && e.type === "armada/turnUsage")).toMatchObject({
      data: { inputTokens: null, outputTokens: null, cachedTokens: null },
    });
  } finally {
    await driver.close();
  }
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
