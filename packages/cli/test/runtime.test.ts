import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatus, type Fleet, herdrHarnessLabel, parseConfig, recordClaim, recordMerge } from "@armada/core";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import { ARMADA_URL, DEMO_TOML, FakeLinear, fakeArmada, fakeClock, issue, NOW } from "../../core/test/support.ts";
import { run } from "../src/cli.ts";
import { herdrPhase, parseHerdrHandle, reportHerdr } from "../src/herdr.ts";
import type { Io } from "../src/io.ts";
import { observeRuntimes } from "../src/runtime.ts";
import { archiveClaimKey, claimRef } from "../src/runtimes/adapter.ts";

const handle = { workspace: "w8", pane: "w8:p9", agent: "demo-7" };
const rawHandle = JSON.stringify(handle);
const branch = "feature/demo-7";
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});
async function fixture(harness = "codex") {
  const home = await mkdtemp(join(tmpdir(), "armada-runtime-"));
  homes.push(home);
  const store = memoryFleet();
  const clock = fakeClock(NOW);
  const api = fakeArmada({ keys: { armada_key_CANARY_runtime: "runtime" }, store, clock });
  const linear = new FakeLinear();
  linear.add("DEMO-7", { labels: [{ id: "phase-implementing", name: "implementing", group: "Agent phase" }] });
  const calls: string[][] = [],
    out: string[] = [],
    err: string[] = [];
  let state = "blocked",
    sequence = 1,
    dirty = "",
    left = "",
    upstream = "origin\0refs/heads/feature/demo-7",
    failure = false;
  const io: Io = {
    cwd: "/work/widgets",
    env: {
      XDG_CONFIG_HOME: home,
      ARMADA_API_URL: ARMADA_URL,
      ARMADA_API_KEY: "armada_key_CANARY_runtime",
      LINEAR_API_KEY: "CANARY",
    },
    now: clock.now,
    sleep: clock.sleep,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    readFile: async (path) => (path === "/work/widgets/armada.toml" ? DEMO_TOML : null),
    ghToken: () => null,
    fetch: api.fetch,
    linearWriter: () => linear,
    exec: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "git") {
        const value =
          args[0] === "status"
            ? dirty
            : args[0] === "branch"
              ? branch
              : args[0] === "for-each-ref"
                ? upstream
                : args[0] === "log"
                  ? left
                  : args[0] === "ls-remote"
                    ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/feature/demo-7"
                    : args[0] === "rev-parse"
                      ? args[1] === "HEAD"
                        ? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                        : "/work/widgets/.git"
                      : "";
        return { code: 0, stdout: value, stderr: "" };
      }
      if (cmd === "herdr" && args[0] === "agent" && args[1] === "send-keys") state = "idle";
      if (failure) throw new Error("private prompt armada_launch_CANARY");
      const result =
        args[0] === "workspace"
          ? {
              workspace: {
                workspace_id: "w8",
                worktree: { repo_root: "/work/widgets", checkout_path: "/work/trees/demo-7", is_linked_worktree: true },
              },
            }
          : args[0] === "worktree"
            ? { type: "worktree_removed", workspace_id: "w8", path: "/work/trees/demo-7", forced: false }
            : args[0] === "pane"
              ? args[1] === "get"
                ? {
                    pane: { pane_id: handle.pane, workspace_id: handle.workspace, agent: harness, agent_status: state },
                  }
                : { type: "ok" }
              : {
                  agent: {
                    name: handle.agent,
                    agent: harness,
                    workspace_id: handle.workspace,
                    pane_id: handle.pane,
                    agent_status: state,
                    state_change_seq: sequence,
                  },
                };
      return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
    },
  };
  await recordClaim(
    store,
    "widgets",
    {
      ticket: "DEMO-7",
      runtime: "Herdr",
      handle: rawHandle,
      branch,
      phase: "implementing",
      resuming: false,
      profile: null,
    },
    NOW,
  );
  return {
    io,
    calls,
    store,
    linear,
    api,
    clock,
    out,
    err,
    change: (changes: {
      state?: string;
      sequence?: number;
      dirty?: string;
      left?: string;
      upstream?: string;
      failure?: boolean;
    }) => {
      state = changes.state ?? state;
      sequence = changes.sequence ?? sequence;
      dirty = changes.dirty ?? dirty;
      left = changes.left ?? left;
      upstream = changes.upstream ?? upstream;
      failure = changes.failure ?? failure;
    },
  };
}

test("a fresh coordinator finds a blocked claim before its next report, answers in one command, and clears the inbox", async () => {
  const f = await fixture();
  expect(await run(["inbox", "--json"], f.io)).toBe(0);
  expect(JSON.parse(f.out.at(-1) ?? "{}").items[0].kind).toBe("runtime-blocked");
  const text = "Approved\n'\" $(never) `never`";
  expect(await run(["answer", "DEMO-7", text], { ...f.io })).toBe(0);
  expect(f.calls).toContainEqual(["herdr", "pane", "run", handle.pane, text]);
  expect(f.linear.bodies.at(-1)).toContain("Approved\n\n'\" $(never) `never`");
  expect(await run(["inbox", "--json"], { ...f.io })).toBe(0);
  expect(JSON.parse(f.out.at(-1) ?? "{}").items).toEqual([]);
});

test("failed runtime delivery leaves questions open and writes no answer; failed validation never prompts", async () => {
  const f = await fixture();
  const id = await f.store.addInboxItem({
    project: "widgets",
    ticket: "DEMO-7",
    recipient: "coordinator",
    kind: "question",
    body: "What next?",
    author: rawHandle,
    at: NOW,
  });
  f.change({ failure: true });
  expect(await run(["answer", String(id), "resume"], f.io)).toBe(2);
  expect((await f.store.getInboxItem("widgets", id))?.resolvedAt).toBeNull();
  expect(f.linear.writes).toEqual([]);
  expect(f.err.join("")).not.toContain("CANARY");
  const before = f.calls.length;
  expect(await run(["answer", "999", "resume"], f.io)).toBe(1);
  expect(f.calls).toHaveLength(before);
});

test.each([
  { dirty: " M src/widget.ts\n?? local.txt", expected: "uncommitted work" },
  { left: "abc1234 local change", expected: "unpushed commits" },
  { upstream: "\0", expected: "no verified remote upstream" },
])("stop refuses remaining work: $expected", async ({ expected, ...changes }) => {
  const f = await fixture();
  f.change(changes);
  expect(await run(["stop", "DEMO-7"], f.io)).toBe(1);
  expect(f.err.join("")).toContain(expected);
  expect(f.calls.some((c) => c[0] === "herdr" && c[1] === "worktree")).toBe(false);
  expect((await f.store.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBeNull();
});

test("stop archives a pushed worktree after release too, with no force or branch deletion", async () => {
  const f = await fixture();
  await f.store.releaseRuntimeHandle("widgets", "DEMO-7", NOW);
  expect(await run(["stop", "DEMO-7", "--json"], f.io)).toBe(0);
  expect(f.calls).toContainEqual([
    "git",
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    "--",
    "origin",
    "refs/heads/feature/demo-7",
  ]);
  expect(f.calls).toContainEqual(["herdr", "worktree", "remove", "--workspace", "w8"]);
  expect(f.calls.flat()).not.toContain("--force");
  expect(f.calls.flat()).not.toContain("-D");
  expect(JSON.parse(f.out.at(-1) ?? "{}").stopped).toBe(true);
});

test("unknown/runtime failures preserve reports instead of inventing a fresh working state", async () => {
  const f = await fixture();
  f.change({ state: "unknown" });
  const writes: unknown[] = [];
  const fleet = {
    runtimeHandles: () => f.store.openRuntimeHandles("widgets"),
    observeRuntime: async (input: unknown) => {
      writes.push(input);
      return true;
    },
  } as unknown as Fleet;
  await observeRuntimes(f.io, fleet);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ state: "unknown" });
  f.change({ failure: true });
  await observeRuntimes(f.io, fleet);
  expect(writes).toHaveLength(1);
});

test("phase self-reporting uses Armada source, maps every phase, and is nonfatal", async () => {
  const f = await fixture();
  f.io.env.HERDR_ENV = "1";
  f.io.env.HERDR_PANE_ID = handle.pane;
  for (const phase of [
    "planning",
    "implementing",
    "shipping",
    "blocked",
    "awaiting-approval",
    "awaiting-validation",
    "ready-to-merge",
  ]) {
    await reportHerdr(f.io, phase, "codex");
    expect(f.calls.at(-1)).toEqual([
      "herdr",
      "pane",
      "report-agent",
      handle.pane,
      "--source",
      "armada",
      "--agent",
      "codex",
      "--state",
      herdrPhase(phase),
    ]);
  }
  f.change({ failure: true });
  await reportHerdr(f.io, "shipping", "deepseek");
  expect(f.err.join("")).toContain("Armada reporting continues");
  expect(f.err.join("")).not.toContain("CANARY");
  f.io.env.HERDR_ENV = "0";
  const before = f.calls.length;
  await reportHerdr(f.io, "shipping", "codex");
  expect(f.calls).toHaveLength(before);
  expect(() => parseHerdrHandle('{"workspace":"--bad","pane":"x","agent":"x"}')).toThrow();
});

test("report and ask self-report their resulting phase, including nonfatal herdr failures", async () => {
  const f = await fixture();
  f.io.env.HERDR_ENV = "1";
  f.io.env.HERDR_PANE_ID = handle.pane;
  expect(await run(["report", "shipping", "--ticket", "DEMO-7", "--message", "tests passed"], f.io)).toBe(0);
  expect(f.calls.at(-1)).toEqual([
    "herdr",
    "pane",
    "report-agent",
    handle.pane,
    "--source",
    "armada",
    "--agent",
    "codex",
    "--state",
    "working",
  ]);
  expect(await run(["ask", "What should happen next?", "--ticket", "DEMO-7"], f.io)).toBe(0);
  expect(f.calls.at(-1)?.at(-1)).toBe("blocked");
  f.change({ failure: true });
  expect(await run(["report", "implementing", "--ticket", "DEMO-7", "--message", "resumed"], f.io)).toBe(0);
  expect(f.linear.bodies.at(-1)).toContain("resumed");
  expect(f.err.join("")).toContain("could not report worker state to herdr");
});

test("heartbeat uses its current scoped phase and continues when herdr reporting fails", async () => {
  const f = await fixture();
  f.io.env.HERDR_ENV = "1";
  f.io.env.HERDR_PANE_ID = handle.pane;
  f.io.pid = 12345;
  f.io.processAlive = () => f.clock.now().getTime() < NOW.getTime() + 1000;
  f.change({ failure: true });
  expect(
    await run(["heartbeat", "--every", "1s", "--ticket", "DEMO-7", "--handle", rawHandle, "--parent", "4242"], f.io),
  ).toBe(0);
  expect(f.api.calls.some((c) => c.path === "fleet/heartbeat")).toBe(true);
  expect(f.err.join("")).toContain("Armada reporting continues");
  expect(f.err.join("")).not.toContain("CANARY");
  expect(f.linear.writes).toEqual([]);
});

test("a failed archive record can be retried after herdr explicitly confirms the workspace is gone", async () => {
  const f = await fixture();
  f.io.exec = async (cmd, args) => {
    f.calls.push([cmd, ...args]);
    return {
      code: 1,
      stdout: "",
      stderr: JSON.stringify({ error: { code: "workspace_not_found", message: "private CANARY" } }),
    };
  };
  expect(await run(["stop", "DEMO-7", "--json"], f.io)).toBe(0);
  expect(f.calls).toEqual([["herdr", "workspace", "get", "w8"]]);
  expect(JSON.parse(f.out.at(-1) ?? "{}").alreadyAbsent).toBe(true);
  expect((await f.store.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBe(NOW.toISOString());
});

test("heartbeat preserves a detected harness question before any worker report", async () => {
  const f = await fixture();
  f.io.env.HERDR_ENV = "1";
  f.io.env.HERDR_PANE_ID = handle.pane;
  await reportHerdr(f.io, "implementing", "codex", true);
  expect(f.calls.at(-1)?.at(-1)).toBe("blocked");
});

test.each(["new commit", "replaced pane"])("stop keeps the worktree when verification sees a %s", async (change) => {
  const f = await fixture();
  const exec = f.io.exec;
  let headReads = 0;
  f.io.exec = async (cmd, args, options) => {
    if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD" && ++headReads > 1 && change === "new commit")
      return { code: 0, stdout: "cccccccccccccccccccccccccccccccccccccccc", stderr: "" };
    const result = await exec?.(cmd, args, options);
    if (cmd === "herdr" && args[0] === "agent" && args[1] === "get" && change === "replaced pane") {
      const body = JSON.parse(result?.stdout ?? "{}");
      body.result.agent.name = "another-worker";
      return { code: 0, stdout: JSON.stringify(body), stderr: "" };
    }
    return result ?? { code: 1, stdout: "", stderr: "" };
  };
  expect(await run(["stop", "DEMO-7"], f.io)).not.toBe(0);
  expect(f.calls.some((c) => c[0] === "herdr" && c[1] === "worktree" && c[2] === "remove")).toBe(false);
  expect((await f.store.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBeNull();
});

test("a live herdr claim receives an answer despite stale tracker phase labels", async () => {
  const f = await fixture();
  f.linear.add("DEMO-7", { labels: [] });
  await f.store.addInboxItem({
    project: "widgets",
    ticket: "DEMO-7",
    recipient: "coordinator",
    kind: "question",
    body: "Proceed?",
    author: rawHandle,
    at: NOW,
  });
  expect(await run(["answer", "DEMO-7", "yes"], f.io)).toBe(0);
  expect(f.calls).toContainEqual(["herdr", "pane", "run", handle.pane, "yes"]);
  expect(await f.store.openInboxItems({ project: "widgets", recipient: "coordinator" })).toEqual([]);
});

test("an answer validated for an old claim never reaches its replacement", async () => {
  const f = await fixture();
  const id = await f.store.addInboxItem({
    project: "widgets",
    ticket: "DEMO-7",
    recipient: "coordinator",
    kind: "question",
    body: "Proceed?",
    author: rawHandle,
    at: NOW,
  });
  const read = f.linear.readTicket.bind(f.linear);
  f.linear.readTicket = async (ticket) => {
    const result = await read(ticket);
    await f.store.releaseRuntimeHandle("widgets", "DEMO-7", NOW);
    await recordClaim(
      f.store,
      "widgets",
      {
        ticket: "DEMO-7",
        runtime: "Herdr",
        handle: JSON.stringify({ ...handle, pane: "w8:p10" }),
        branch,
        phase: "implementing",
        resuming: false,
        profile: null,
      },
      new Date(NOW.getTime() + 1000),
    );
    return result;
  };
  expect(await run(["answer", String(id), "yes"], f.io)).toBe(1);
  expect(f.calls.some((c) => c[0] === "herdr" && ["prompt", "run"].includes(c[2] ?? ""))).toBe(false);
  expect((await f.store.getInboxItem("widgets", id))?.resolvedAt).toBeNull();
  expect(f.linear.writes).toEqual([]);
});

test("reused runtime IDs in another repository are neither observed nor messaged", async () => {
  const f = await fixture();
  const exec = f.io.exec;
  f.io.exec = async (cmd, args, options) =>
    cmd === "git" && options?.cwd === "/work/trees/demo-7" && args[0] === "rev-parse"
      ? { code: 0, stdout: "/another/repository/.git", stderr: "" }
      : ((await exec?.(cmd, args, options)) ?? { code: 1, stdout: "", stderr: "" });
  expect(await run(["inbox", "--json"], f.io)).toBe(0);
  expect(JSON.parse(f.out.at(-1) ?? "{}").items.some((i: { kind: string }) => i.kind === "runtime-blocked")).toBe(
    false,
  );
  expect(await run(["answer", "--note", "DEMO-7", "yes"], f.io)).toBe(1);
  expect(f.calls.some((c) => c[0] === "herdr" && ["prompt", "run"].includes(c[2] ?? ""))).toBe(false);
});

test("stop retains the checkout when cancellation does not settle the active turn", async () => {
  const f = await fixture();
  f.change({ state: "working" });
  const exec = f.io.exec;
  f.io.exec = async (cmd, args, options) =>
    cmd === "herdr" && args[0] === "agent" && args[1] === "send-keys"
      ? { code: 0, stdout: JSON.stringify({ result: { type: "ok" } }), stderr: "" }
      : ((await exec?.(cmd, args, options)) ?? { code: 1, stdout: "", stderr: "" });
  expect(await run(["stop", "DEMO-7"], f.io)).toBe(2);
  expect(f.calls.some((c) => c[0] === "herdr" && c[1] === "worktree" && c[2] === "remove")).toBe(false);
  expect((await f.store.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBeNull();
});

test("a second native approval between polls reappears without any worker report", async () => {
  const f = await fixture();
  expect(await run(["inbox", "--json"], f.io)).toBe(0);
  expect(await run(["answer", "DEMO-7", "yes"], f.io)).toBe(0);
  expect(await run(["inbox", "--json"], f.io)).toBe(0);
  expect(JSON.parse(f.out.at(-1) ?? "{}").items).toEqual([]);
  f.clock.advance(1000);
  f.change({ sequence: 3 });
  expect(await run(["inbox", "--json"], f.io)).toBe(0);
  expect(JSON.parse(f.out.at(-1) ?? "{}").items.map((i: { kind: string }) => i.kind)).toEqual(["runtime-blocked"]);
});

test("DeepSeek profiles keep their model label while report, heartbeat, answer and stop drive OpenCode", async () => {
  const f = await fixture("opencode");
  const configText = `${DEMO_TOML}\n[herdr.profiles.backend]\nharness = "deepseek"\nmodel = "deepseek/deepseek-reasoner"\neffort = "high"\n`;
  f.io.readFile = async (path) => (path === "/work/widgets/armada.toml" ? configText : null);
  f.linear.post(
    "DEMO-7",
    `Agent claim — runtime: Herdr · session: ${rawHandle} · branch: ${branch} · profile: backend`,
    NOW.toISOString(),
  );
  await f.store.saveWorkerProfile({
    project: "widgets",
    ticket: "DEMO-7",
    at: NOW,
    profile: {
      name: "backend",
      agent: herdrHarnessLabel("deepseek"),
      model: "deepseek/deepseek-reasoner",
      effort: "high",
      fastMode: false,
      routed: null,
      reason: "back end work",
      why: "semantic choice",
    },
  });
  f.io.env.HERDR_ENV = "1";
  f.io.env.HERDR_PANE_ID = handle.pane;
  expect(await run(["report", "shipping", "--ticket", "DEMO-7", "--message", "checks passed"], f.io)).toBe(0);
  expect(f.calls.at(-1)).toEqual([
    "herdr",
    "pane",
    "report-agent",
    handle.pane,
    "--source",
    "armada",
    "--agent",
    "opencode",
    "--state",
    "working",
  ]);
  expect(await run(["ask", "Allow this operation?", "--ticket", "DEMO-7"], f.io)).toBe(0);
  f.io.processAlive = () => f.clock.now().getTime() < NOW.getTime() + 1000;
  expect(
    await run(["heartbeat", "--every", "1s", "--ticket", "DEMO-7", "--handle", rawHandle, "--parent", "4242"], f.io),
  ).toBe(0);
  expect(f.calls.at(-1)).toEqual([
    "herdr",
    "pane",
    "report-agent",
    handle.pane,
    "--source",
    "armada",
    "--agent",
    "opencode",
    "--state",
    "blocked",
  ]);
  expect(await run(["answer", "DEMO-7", "yes"], f.io)).toBe(0);
  expect(f.calls).toContainEqual(["herdr", "pane", "run", handle.pane, "yes"]);
  f.change({ state: "idle" });
  expect(await run(["inbox", "--json"], f.io)).toBe(0);
  const saved = await f.store.getRuntimeHandle("widgets", "DEMO-7");
  expect(saved).not.toBeNull();
  if (!saved) throw new Error("missing fixture claim");
  const status = buildStatus({
    config: parseConfig(configText),
    program: {
      rootId: "DEMO-1",
      fetchedAt: NOW.toISOString(),
      issues: [issue("DEMO-1"), issue("DEMO-7", { parentId: "DEMO-1", agentRuntime: "Herdr", agentPhase: "blocked" })],
      comments: [],
      warnings: [],
    },
    forge: null,
    now: f.clock.now(),
    live: { after: NOW.toISOString(), events: {}, handles: { "DEMO-7": saved } },
  });
  expect(status.inFlight[0]).toMatchObject({
    profile: "backend",
    harness: herdrHarnessLabel("deepseek"),
    runtimeState: "idle",
  });
  expect(await run(["stop", "DEMO-7"], f.io)).toBe(0);
  expect(f.calls).toContainEqual(["herdr", "worktree", "remove", "--workspace", handle.workspace]);
});

test.each(["matching", "active-replacement", "ended-replacement", "no-key-replacement", "wrong-pr", "stale-key"])(
  "merge recovery stops only the ended merged generation (%s)",
  async (scenario) => {
    const f = await fixture();
    const url = "https://github.com/acme/widgets/pull/9";
    const merged = await recordMerge(
      f.store,
      "widgets",
      {
        ticket: "DEMO-7",
        number: 9,
        url,
        mergeCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      NOW,
    );
    if (!merged.handle) throw new Error("missing merged fixture claim");
    const key = archiveClaimKey(claimRef(merged.handle));
    if (scenario.includes("replacement")) {
      await f.store.saveRuntimeHandle({
        project: "widgets",
        ticket: "DEMO-7",
        runtime: "Herdr",
        handle: rawHandle,
        branch,
        at: new Date(NOW.getTime() + 1000),
      });
      if (scenario === "ended-replacement" || scenario === "no-key-replacement")
        await f.store.releaseRuntimeHandle("widgets", "DEMO-7", new Date(NOW.getTime() + 2000));
    }
    const args = ["stop", "DEMO-7", "--merged-pr", scenario === "wrong-pr" ? `${url}0` : url];
    if (scenario !== "no-key-replacement") args.push("--claim-key", scenario === "stale-key" ? "0".repeat(64) : key);
    expect(await run(args, f.io)).toBe(scenario === "matching" ? 0 : 1);
    if (scenario === "matching") expect(f.calls).toContainEqual(["herdr", "worktree", "remove", "--workspace", "w8"]);
    else {
      expect(f.calls).toEqual([]);
      expect(f.err.join(" ")).toContain("left its workspace untouched");
    }
  },
);
