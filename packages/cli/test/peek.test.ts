import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArmadaApiError,
  formatWorkerSession,
  GITHUB_GRAPHQL,
  machinePaths,
  parseConfig,
  readWatchState,
  recordClaim,
  resolveCredentials,
  updateCredentialStore,
  updateWatchState,
} from "@armada/core";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import { ARMADA_URL, DEMO_TOML, fakeArmada, fakeClock, pullResponse } from "../../core/test/support.ts";
import { run } from "../src/cli.ts";
import type { Io } from "../src/io.ts";
import { peek, requirePeekCoordinator } from "../src/peek.ts";
import events from "./fixtures/conductor-codex-events.json";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(runtime = "Conductor", pending = false) {
  const home = await mkdtemp(join(tmpdir(), "armada-peek-"));
  homes.push(home);
  const store = memoryFleet();
  const clock = fakeClock(new Date("2026-07-01T12:14:00Z"));
  const api = fakeArmada({ keys: { armada_key_CANARY_peek: "peek" }, store, clock });
  const handle =
    runtime === "Herdr" ? JSON.stringify({ workspace: "w8", pane: "w8:p9", agent: "demo-7" }) : "ws_8/ses_9";
  if (!pending)
    await recordClaim(
      store,
      "widgets",
      {
        ticket: "DEMO-7",
        runtime,
        handle,
        branch: "feature/demo-7",
        phase: "implementing",
        resuming: false,
        profile: null,
      },
      new Date("2026-07-01T11:00:00Z"),
    );
  await store.recordEvent({
    project: "widgets",
    ticket: "DEMO-7",
    kind: "report",
    phase: "implementing",
    message: "Tests next",
    at: new Date("2026-07-01T12:02:00Z"),
  });
  await store.recordHeartbeat({ project: "widgets", ticket: "DEMO-7", handle, at: new Date("2026-07-01T12:13:00Z") });
  await store.addInboxItem({
    project: "widgets",
    ticket: "DEMO-7",
    kind: "question",
    body: "Which export?",
    recipient: "coordinator",
    author: null,
    at: new Date("2026-07-01T12:02:00Z"),
  });
  const calls: string[][] = [],
    out: string[] = [],
    err: string[] = [];
  let pages = 0;
  const io: Io = {
    cwd: "/work/widgets",
    env: {
      XDG_CONFIG_HOME: home,
      ARMADA_API_URL: ARMADA_URL,
      ARMADA_API_KEY: "armada_key_CANARY_peek",
      LINEAR_API_KEY: "CANARY",
      TZ: "Europe/Paris",
      CUSTOM_SECRET: "private-value",
    },
    now: clock.now,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ghToken: () => null,
    readFile: async (path) =>
      path === "/work/widgets/armada.toml" ? `${DEMO_TOML}\n[secrets]\nnames = ["CUSTOM_SECRET"]\n` : null,
    fetch: api.fetch,
    exec: async (cmd, args, options) => {
      calls.push([cmd, ...args]);
      expect(options.maxOutputBytes).toBeGreaterThan(0);
      expect(options.maxOutputBytes).toBeLessThanOrEqual(2_000_000);
      if (cmd === "git")
        return { code: 0, stdout: args[0] === "branch" ? "feature/demo-7" : "/work/widgets/.git", stderr: "" };
      if (cmd === "herdr") {
        if (args[0] === "pane" && args[1] === "read")
          return { code: 0, stdout: "Tests pass armada_worker_CANARY_peek", stderr: "" };
        const result =
          args[0] === "workspace"
            ? {
                workspace: {
                  workspace_id: "w8",
                  worktree: { repo_root: "/work/widgets", checkout_path: "/work/demo-7", is_linked_worktree: true },
                },
              }
            : {
                agent: {
                  name: "demo-7",
                  workspace_id: "w8",
                  pane_id: "w8:p9",
                  agent_status: "working",
                  state_change_seq: 1,
                },
              };
        return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
      }
      const body =
        args[1] === "session" && args[2] === "status"
          ? { workspaceId: "ws_8", sessionId: "ses_9", status: "working", updatedAt: "2026-07-01T12:05:00Z" }
          : pages++ === 0
            ? events
            : { data: [], hasMore: false };
      return { code: 0, stdout: JSON.stringify(body), stderr: "" };
    },
  };
  const paths = machinePaths(io.env);
  if (!paths) throw new Error("missing temporary machine paths");
  return { io, store, out, err, calls, handle, home, api, paths };
}

test("peek shows local runtime facts, redacted reply and commands and keeps its cursor/tail across reads", async () => {
  const f = await fixture();
  expect(await run(["peek", "DEMO-7"], f.io)).toBe(0);
  const text = f.out.join("");
  expect(text).toContain("14:02");
  expect(text).toContain("12 min ago");
  expect(text).toContain("working since");
  expect(text).toContain("Running tests");
  expect(text).toContain("exit 0");
  expect(text).toContain("exit 1");
  expect(text).toContain("heartbeat 1 min ago");
  expect(text).toContain("question #");
  expect(text).not.toContain("CANARY_peek");
  expect(text).not.toContain("private-value");
  expect((await f.store.getRuntimeHandle("widgets", "DEMO-7"))?.runtimeState?.state).toBe("working");
  const saved = await readWatchState(f.paths, "widgets.peek");
  expect(saved?.peek?.[f.handle]).toBe("ev_3");
  await updateWatchState(f.paths, "widgets@coordinator", { root: "/work/widgets" });
  f.io.cwd = "/tmp";
  expect(await run(["peek", "DEMO-7", "--project", "widgets", "--json"], f.io)).toBe(0);
  const json = JSON.parse(f.out.at(-1) ?? "{}");
  expect(json.runtime.lastReply.text).toContain("Running tests");
  expect(json.runtime.actions.map((a: { exit: number }) => a.exit)).toEqual([0, 1]);
  expect(f.calls.at(-1)).toContain("--after");
  expect(f.calls.every((call) => !call.includes("sql") && !call.includes("create"))).toBe(true);
});

test("peek reads a local herdr worker through the same command", async () => {
  const f = await fixture("Herdr");
  expect(await run(["peek", "DEMO-7", "--json"], f.io)).toBe(0);
  const json = JSON.parse(f.out.at(-1) ?? "{}");
  expect(json.runtime.state).toBe("working");
  expect(json.runtime.lastReply.text).toBe("Tests pass [redacted]");
  const native = f.io.exec;
  if (!native) throw new Error("missing fake exec");
  await updateWatchState(f.paths, "widgets@coordinator", { root: "/work/widgets" });
  f.io.cwd = "/tmp";
  const gitRoots: string[] = [];
  f.io.now = () => new Date("2026-07-01T12:20:00Z");
  f.io.exec = async (cmd, args, options) => {
    if (cmd === "git") {
      gitRoots.push(options.cwd ?? "");
      if (options.cwd === "/tmp") return { code: 1, stdout: "", stderr: "not a git repository" };
    }
    const result = await native(cmd, args, options);
    if (cmd === "herdr" && args[0] === "agent") {
      const body = JSON.parse(result.stdout);
      body.result.agent.state_change_seq = 2;
      return { ...result, stdout: JSON.stringify(body) };
    }
    return result;
  };
  expect(await run(["peek", "DEMO-7", "--project", "widgets", "--json"], f.io)).toBe(0);
  const next = JSON.parse(f.out.at(-1) ?? "{}");
  expect(next.runtime.since).toBe("2026-07-01T12:20:00.000Z");
  expect(next.runtime.unavailable).toBeNull();
  expect(next.runtime.lastReply.text).toBe("Tests pass [redacted]");
  expect(gitRoots).toContain("/work/widgets");
  expect(gitRoots).not.toContain("/tmp");
});

test.each(["Conductor", "Herdr"])("peek reads a bound %s launch before sign-in or claim", async (runtime) => {
  const f = await fixture(runtime, true);
  f.store.launches.push({
    project: "widgets",
    ticket: "DEMO-7",
    runtime,
    handle: f.handle,
    launchedAt: "2026-07-01T12:00:00Z",
    tokenUsedAt: null,
    endedAt: null,
  });
  expect(await run(["peek", "DEMO-7", "--json"], f.io)).toBe(0);
  const result = JSON.parse(f.out.at(-1) ?? "{}");
  expect(result.claimedAt).toBeNull();
  expect(result.runtime.state).toBe("working");
  expect(await f.store.getRuntimeHandle("widgets", "DEMO-7")).toBeNull();
});

test("an unreachable runtime preserves the stored observation and its age", async () => {
  const f = await fixture("Herdr");
  expect(await run(["peek", "DEMO-7"], f.io)).toBe(0);
  expect(
    await run(["peek", "DEMO-7", "--json"], {
      ...f.io,
      exec: async () => {
        throw new Error("ghp_CANARY_peek");
      },
    }),
  ).toBe(0);
  const result = JSON.parse(f.out.at(-1) ?? "{}");
  expect(result.runtime.unavailable).toBe("runtime not reachable from this machine");
  expect(result.runtime.state).toBe("working");
  expect(result.runtime.observedAt).toBe("2026-07-01T12:14:00.000Z");
  expect(f.err.join("")).not.toContain("CANARY_peek");
});

test("peek refuses worker sessions and invalid action counts before runtime reads", async () => {
  const f = await fixture();
  expect(await run(["peek", "DEMO-7", "--actions", "-1"], f.io)).toBe(2);
  expect(f.calls).toHaveLength(0);
  const env = {
    ARMADA_API_URL: ARMADA_URL,
    ARMADA_TICKET: "DEMO-7",
    ARMADA_WORKER_SESSION_DEMO_7: formatWorkerSession({
      token: "armada_worker_CANARY_peek",
      api: ARMADA_URL,
      ticket: "DEMO-7",
      project: "widgets",
      organization: "synthetic-org",
      id: "synthetic-session",
    }),
  };
  const store = { ARMADA_WORKER_SESSION_DEMO_7: env.ARMADA_WORKER_SESSION_DEMO_7 };
  await updateCredentialStore(f.paths, store);
  const credentials = resolveCredentials({ env, store, ticket: "DEMO-7" });
  expect(await run(["peek", "DEMO-7"], { ...f.io, env: { ...env, XDG_CONFIG_HOME: f.home } })).toBe(1);
  expect(f.calls).toHaveLength(0);
  // Direct command callers also have the same 403 guard; fleet API already denies worker reads.
  const worker = credentials;
  expect(() => requirePeekCoordinator(worker)).toThrow("worker sessions cannot inspect runtimes");
  try {
    requirePeekCoordinator(worker);
  } catch (error) {
    expect((error as ArmadaApiError).status).toBe(403);
  }
});

test("peek reads PR check counts once and reports missing GitHub credentials", async () => {
  const f = await fixture();
  await f.store.recordEvent({
    project: "widgets",
    ticket: "DEMO-7",
    kind: "report",
    phase: "shipping",
    prUrl: "https://github.com/acme/widgets/pull/12",
    at: new Date("2026-07-01T12:12:00Z"),
  });
  let reads = 0;
  const io: Io = {
    ...f.io,
    env: { ...f.io.env, GITHUB_TOKEN: "ghp_CANARY_peek" },
    fetch: async (url, options) => {
      if (String(url) !== GITHUB_GRAPHQL) return f.api.fetch(url, options);
      reads++;
      return new Response(
        JSON.stringify(
          pullResponse({
            number: 12,
            headSha: "a".repeat(40),
            checks: [
              { name: "tests", conclusion: "SUCCESS" },
              { name: "lint", conclusion: null, status: "IN_PROGRESS" },
              { name: "build", conclusion: "FAILURE" },
            ],
          }),
        ),
        { status: 200 },
      );
    },
  };
  expect(await run(["peek", "DEMO-7", "--json"], io)).toBe(0);
  const result = JSON.parse(f.out.at(-1) ?? "{}");
  expect(result.pull.counts).toEqual({ passed: 1, running: 1, failed: 1 });
  expect(result.pull.failing).toEqual(["build"]);
  expect(result.pull.headSha).toBe("a".repeat(40));
  expect(reads).toBe(1);
  expect(await run(["peek", "DEMO-7"], f.io)).toBe(0);
  expect(f.out.at(-1)).toContain("checks not read: no GitHub token");
});

test("Conductor bounds a long transcript, resumes from its cursor and reads archived/unknown formats", async () => {
  const f = await fixture();
  let pages = 0;
  const io: Io = {
    ...f.io,
    exec: async (_cmd, args, options) => {
      expect(options.maxOutputBytes).toBe(2_000_000);
      let body: unknown;
      if (args[2] === "status")
        body =
          args[1] === "workspace"
            ? { workspaceId: "ws_8", status: "archived" }
            : { workspaceId: "ws_8", sessionId: "ses_9", status: "idle", updatedAt: "2026-07-01T12:05:00Z" };
      else
        body = {
          data: [
            {
              id: `ev_${++pages}`,
              receivedAt: "2026-07-01T12:06:00Z",
              content: { rawPayload: { type: "custom", text: "Unknown agent ghp_CANARY_peek" } },
            },
          ],
          hasMore: true,
        };
      return { code: 0, stdout: JSON.stringify(body), stderr: "" };
    },
  };
  expect(await run(["peek", "DEMO-7", "--json"], io)).toBe(0);
  const result = JSON.parse(f.out.at(-1) ?? "{}");
  expect(pages).toBe(20);
  expect(result.runtime.truncated).toBe(true);
  expect(result.runtime.state).toBe("gone");
  expect(result.runtime.lastReply.text).toBe("Unknown agent [redacted]");
  expect(result.runtime.detail).toContain("unknown agent format");
  expect(result.runtime.actions).toEqual([]);
  expect((await readWatchState(f.paths, "widgets.peek"))?.peek?.[f.handle]).toBe("ev_20");
  const native = io.exec;
  if (!native) throw new Error("missing fake exec");
  io.exec = async (cmd, args, options) =>
    args[2] === "message"
      ? { code: 0, stderr: "", stdout: JSON.stringify({ data: [], hasMore: false }) }
      : native(cmd, args, options);
  expect(await run(["peek", "DEMO-7", "--json"], io)).toBe(0);
  expect(JSON.parse(f.out.at(-1) ?? "{}").runtime.truncated).toBe(false);
});

test("Claude replies and tool results expose command exit codes", async () => {
  const f = await fixture();
  const native = f.io.exec;
  if (!native) throw new Error("missing fake exec");
  f.io.exec = async (cmd, args, options) =>
    args[2] === "message"
      ? {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            data: [
              {
                id: "c1",
                receivedAt: "2026-07-01T12:01:00Z",
                content: {
                  rawPayload: {
                    type: "assistant",
                    message: {
                      content: [{ type: "tool_use", id: "tool_1", name: "Bash", input: { command: "bun test" } }],
                    },
                  },
                },
              },
              {
                id: "c2",
                receivedAt: "2026-07-01T12:02:00Z",
                content: {
                  rawPayload: {
                    type: "user",
                    message: { content: [{ type: "tool_result", tool_use_id: "tool_1", content: "Exit code: 0" }] },
                  },
                },
              },
              {
                id: "c3",
                receivedAt: "2026-07-01T12:03:00Z",
                content: { rawPayload: { type: "result", result: "Passed" } },
              },
            ],
            hasMore: false,
          }),
        }
      : native(cmd, args, options);
  expect(await run(["peek", "DEMO-7", "--json"], f.io)).toBe(0);
  const result = JSON.parse(f.out.at(-1) ?? "{}");
  expect(result.runtime.lastReply.text).toBe("Passed");
  expect(result.runtime.actions[0]).toMatchObject({ text: "bun test", exit: 0 });
});

test("a pending replacement is inspected instead of the released previous claim", async () => {
  const f = await fixture();
  await f.store.releaseRuntimeHandle("widgets", "DEMO-7", new Date("2026-07-01T12:10:00Z"));
  f.store.launches.push({
    project: "widgets",
    ticket: "DEMO-7",
    runtime: "Conductor",
    handle: "ws_new/ses_new",
    launchedAt: "2026-07-01T12:12:00Z",
    tokenUsedAt: null,
    endedAt: null,
  });
  f.io.exec = async (_cmd, args) => ({
    code: 0,
    stderr: "",
    stdout: JSON.stringify(
      args[2] === "status"
        ? { workspaceId: "ws_new", sessionId: "ses_new", status: "working", updatedAt: "2026-07-01T12:13:00Z" }
        : { data: [], hasMore: false },
    ),
  });
  expect(await run(["peek", "DEMO-7", "--json"], f.io)).toBe(0);
  const result = JSON.parse(f.out.at(-1) ?? "{}");
  expect(result.runtime.handle).toBe("ws_new/ses_new");
  expect(result.claimedAt).toBeNull();
  expect(result.launchedAt).toBe("2026-07-01T12:12:00Z");
});

test("incremental Claude completion updates a cached command and user prompts preserve the worker reply", async () => {
  const f = await fixture();
  const native = f.io.exec;
  if (!native) throw new Error("missing fake exec");
  let page = 0;
  f.io.exec = async (cmd, args, options) => {
    if (args[2] !== "message") return native(cmd, args, options);
    const batch = page++;
    const raw =
      batch === 0
        ? [
            { type: "result", result: "Previous worker reply" },
            {
              type: "assistant",
              message: {
                content: [{ type: "tool_use", id: "tool_split", name: "Bash", input: { command: "bun test" } }],
              },
            },
          ]
        : batch === 1
          ? [
              { type: "user", message: { content: "Continue and report" } },
              {
                type: "user",
                message: { content: [{ type: "tool_result", tool_use_id: "tool_split", content: "Exit code: 0" }] },
              },
            ]
          : [{ type: "assistant", message: { content: [{ type: "text", text: "Current assistant progress" }] } }];
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        data: raw.map((rawPayload, i) => ({
          id: `split_${page}_${i}`,
          receivedAt: "2026-07-01T12:02:00Z",
          content: { rawPayload },
        })),
        hasMore: false,
      }),
    };
  };
  expect(await run(["peek", "DEMO-7", "--json"], f.io)).toBe(0);
  expect(JSON.parse(f.out.at(-1) ?? "{}").runtime.actions[0].exit).toBeNull();
  expect(await run(["peek", "DEMO-7", "--json"], f.io)).toBe(0);
  const result = JSON.parse(f.out.at(-1) ?? "{}");
  expect(result.runtime.actions[0]).toMatchObject({ text: "bun test", exit: 0 });
  expect(result.runtime.lastReply.text).toBe("Previous worker reply");
  expect(result.runtime.actionResults).toBeUndefined();
  expect(await run(["peek", "DEMO-7", "--json"], f.io)).toBe(0);
  expect(JSON.parse(f.out.at(-1) ?? "{}").runtime.lastReply.text).toBe("Current assistant progress");
});

test("whole configured secrets are masked before prefixes, including resolved unprefixed tokens and the cache", async () => {
  const f = await fixture();
  f.io.env.CUSTOM_SECRET = "opaque.sk-demo.tail";
  const credentials = resolveCredentials({ env: f.io.env });
  const config = parseConfig((await f.io.readFile("/work/widgets/armada.toml")) ?? "");
  const native = f.io.exec;
  if (!native) throw new Error("missing fake exec");
  f.io.exec = async (cmd, args, options) =>
    args[2] === "message"
      ? {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            data: [
              {
                id: "secret_1",
                receivedAt: "2026-07-01T12:02:00Z",
                content: { rawPayload: { type: "result", result: "opaque.sk-demo.tail opaque-credential-canary" } },
              },
            ],
            hasMore: false,
          }),
        }
      : native(cmd, args, options);
  // The opaque canary is an already resolved credential, without a recognized prefix.
  expect(
    await peek(
      f.io,
      config,
      { ...credentials, githubToken: "opaque-credential-canary" },
      { rest: ["DEMO-7"], options: {}, json: true },
    ),
  ).toBe(0);
  expect(JSON.parse(f.out.at(-1) ?? "{}").runtime.lastReply.text).toBe("[redacted] [redacted]");
  const saved = await readWatchState(f.paths, "widgets.peek");
  expect(saved?.peekTail?.[f.handle]?.lastReply?.text).toBe("[redacted] [redacted]");
});
