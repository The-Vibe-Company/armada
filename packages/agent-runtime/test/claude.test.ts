import { expect, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeDriver, type DriverEvent, type Turn } from "../src/index.ts";

const nativeTest = process.platform === "linux" ? test : test.skip;

// Audit: real SDK controls a real local JSONL child; protects merged-result termination and native input.
nativeTest("Claude SDK consumes native steering and finishes a merged two-input result once", async () => {
  const driver = new ClaudeDriver({
    executable: `${import.meta.dir}/fixtures/claude-process.ts`,
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  let turn: Turn | undefined;
  let steering: Promise<void> | undefined;
  const events: DriverEvent[] = [];
  const bounded = AbortSignal.timeout(2000);
  try {
    turn = driver.start({
      request: { sandboxId: "s", harness: "claude", text: "initial" },
      sessionId: "fixture-session",
      signal: bounded,
      session: () => {},
      emit: (e) => {
        events.push(e);
        if (e.kind === "message" && e.partial && !steering) steering = turn?.steer("redirect");
      },
    });
    expect(await turn.done).toBe("finished");
    await steering;
    expect(events.filter((e) => e.kind === "message" && e.text.includes("private-account-allowance"))).toEqual([]);
    // Structured native /usage is independent of assistant text conversion.
    expect(events.find((e) => e.kind === "other" && e.type === "usage_report")).toMatchObject({
      data: {
        rate_limits: {
          limits: [{ percent: 25, resets_at: "2026-11-10T00:00:00Z" }],
          extra_usage: { used_credits: 125, monthly_limit: 2000, currency: "EUR" },
        },
      },
    });
    expect(events.filter((e) => e.kind === "message" && !e.partial && e.text === "steered")).toHaveLength(1);
    expect(
      events.filter(
        (e) => e.kind === "message" && e.partial && e.tools.some((t) => t.id === "tool-call" && t.name === "Read"),
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (e) =>
          e.kind === "message" &&
          e.tools.some((t) => t.id === "tool-call" && t.result?.output === "fixture output" && !t.result.isError),
      ),
    ).toHaveLength(1);
  } finally {
    await driver.close();
  }
});
nativeTest("closing one Claude SDK turn leaves another conversation alive for its own interrupt", async () => {
  const driver = new ClaudeDriver({
    executable: `${import.meta.dir}/fixtures/claude-process.ts`,
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  let readyFirst!: () => void, readySecond!: () => void;
  const firstReady = new Promise<void>((r) => {
      readyFirst = r;
    }),
    secondReady = new Promise<void>((r) => {
      readySecond = r;
    });
  const context = (text: string, ready: () => void) => ({
    request: { sandboxId: "s", harness: "claude" as const, text },
    signal: new AbortController().signal,
    session: () => {},
    emit: (e: DriverEvent) => {
      if (e.kind === "message" && e.partial) ready();
    },
  });
  const first = driver.start(context("one", readyFirst)),
    second = driver.start(context("two", readySecond));
  let secondSettled = false;
  void second.done.then(
    () => {
      secondSettled = true;
    },
    () => {
      secondSettled = true;
    },
  );
  try {
    await Promise.all([firstReady, secondReady]);
    await first.steer("redirect");
    expect(await first.done).toBe("finished");
    expect(secondSettled).toBe(false);
    await second.interrupt();
    expect(await second.done).toBe("interrupted");
  } finally {
    await driver.close();
    await Promise.allSettled([first.done, second.done]);
  }
});

// Security owner boundary: the real SDK spawns a real peer, which observes kernel argv and file modes.
nativeTest(
  "Claude MCP secrets travel only through a private config file and are removed after turn shutdown",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "armada-mcp-argv-"));
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const receipt = join(root, "inspection.json");
    const driver = new ClaudeDriver({
      executable: `${import.meta.dir}/fixtures/claude-process.ts`,
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        CLAUDE_CONFIG_DIR: home,
        ARMADA_MCP_INSPECTION: receipt,
      },
    });
    let ready!: () => void;
    const started = new Promise<void>((r) => {
      ready = r;
    });
    const turn = driver.start({
      request: { sandboxId: "s", harness: "claude", text: "initial" },
      signal: AbortSignal.timeout(3000),
      session: () => {},
      mcp: {
        revision: "r1",
        servers: {
          remote: {
            type: "http",
            url: "https://example.invalid/mcp",
            headers: { Authorization: "mcp-header-fixture-sensitive" },
          },
          local: { type: "stdio", command: "fixture-command", env: { PRIVATE_MCP_VALUE: "mcp-env-fixture-sensitive" } },
        },
      },
      emit: (e) => {
        if (e.kind === "message" && e.partial) ready();
      },
    });
    try {
      await started;
      const observed = JSON.parse(await readFile(receipt, "utf8"));
      expect(observed.argvLeak).toBe(false);
      expect(observed.environmentLeak).toBe(false);
      expect(observed).toMatchObject({
        pathOnly: true,
        fileMode: 0o600,
        directoryMode: 0o700,
        noSymlink: true,
        configured: true,
        strict: true,
      });
      await turn.steer("redirect");
      expect(await turn.done).toBe("finished");
      expect(
        await access(observed.configPath).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(
        await access(observed.directoryPath).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      await driver.close();
      await turn.done.catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);

nativeTest("Claude MCP setup refuses symlinked or non-private configured homes before spawning", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-mcp-home-")),
    home = join(root, "home"),
    alias = join(root, "alias");
  await mkdir(home, { mode: 0o700 });
  await symlink(home, alias);
  try {
    for (const base of [alias, home]) {
      if (base === home) await chmod(home, 0o777);
      const driver = new ClaudeDriver({
        executable: `${import.meta.dir}/fixtures/claude-process.ts`,
        cwd: root,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CLAUDE_CONFIG_DIR: base },
      });
      let turn: Turn | undefined;
      try {
        expect(() => {
          turn = driver.start({
            request: { sandboxId: "s", harness: "claude", text: "initial" },
            signal: AbortSignal.timeout(1000),
            session: () => {},
            emit: () => {},
            mcp: {
              revision: "r1",
              servers: {
                docs: {
                  type: "http",
                  url: "https://example.invalid/mcp",
                  headers: { Authorization: "mcp-header-fixture-sensitive" },
                },
              },
            },
          });
        }).toThrow("mcp_config_setup_failed");
      } finally {
        await driver.close();
        await turn?.done.catch(() => {});
      }
      expect(await readdir(home)).toEqual([]);
    }
  } finally {
    await chmod(home, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});

nativeTest("Claude native /usage fallback does not become public assistant text or partials", async () => {
  const driver = new ClaudeDriver({
    executable: `${import.meta.dir}/fixtures/claude-process.ts`,
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  const events: DriverEvent[] = [];
  try {
    const turn = driver.start({
      request: { sandboxId: "s", harness: "claude", text: "/usage" },
      signal: AbortSignal.timeout(3000),
      session: () => {},
      emit: (event) => {
        events.push(event);
      },
    });
    expect(await turn.done).toBe("finished");
    expect(events.filter((event) => event.kind === "message")).toEqual([]);
    expect(events.some((event) => event.kind === "other" && event.type === "system")).toBe(true);
  } finally {
    await driver.close();
  }
});
