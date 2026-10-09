// armada merge on a throwaway repository: a local bare repository stands in
// for GitHub's git side (the test merge and the base-branch search run real
// git), a fake `gh` takes the merge, and fake APIs answer GitHub and Linear.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Fetch,
  GITHUB_GRAPHQL,
  LinearError,
  type MergeOutcome,
  machinePaths,
  parseConfig,
  type RawIssue,
  type RawPull,
  readWatchState,
  reserveNotice,
  resolveCredentials,
} from "@armada/core";
import githubPulls from "../../core/test/fixtures/github-pulls.json";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import {
  ARMADA_URL,
  DEMO_PROJECT,
  DEMO_TOML,
  FakeLinear,
  fakeArmada,
  LABELS,
  NOW,
  recordedFetch,
} from "../../core/test/support.ts";
import { afterMerge } from "../src/after-merge.ts";
import { run } from "../src/cli.ts";
import type { Exec, Io } from "../src/io.ts";
import { ghMerge, ghUpdateBranch } from "../src/merge.ts";

test.each([
  ["unexpected end of JSON input", true],
  ["invalid character '<' looking for beginning of value", true],
  ["HTTP 422: Validation Failed", false],
])("SHA-guarded gh writes classify unreadable responses as temporary (%s)", async (message, transient) => {
  const calls: string[][] = [];
  const exec: Exec = async (_command, args) => {
    calls.push(args);
    return { code: 1, stdout: "", stderr: message };
  };
  const sha = "1".repeat(40);
  for (const write of [ghMerge, ghUpdateBranch]) {
    expect(await write(exec, "/repo", "demo/widgets")(9, sha)).toEqual({ ok: false, message, transient });
  }
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain("--match-head-commit");
  expect(calls[0]).toContain(sha);
  expect(calls[1]).toContain(`expected_head_sha=${sha}`);
});

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const SQUASH = "5555555555555555555555555555555555555555";
const BRANCH = "feature/demo-18-expire-idle-sessions";
const KEY = "armada_key_CANARY_coordinator";

test.each(["first", "reserved", "json", "dry-run", "worker", "deploy", "job"])(
  "merge's no-deploy hint is daily and only follows a human coordinator's confirmed merge (%s)",
  async (scenario) => {
    const f = await fixture();
    const paths = machinePaths(f.io.env);
    if (!paths) throw new Error("no temporary machine store");
    if (scenario === "reserved") await reserveNotice(paths, "hint:deploy:widgets", NOW, 86_400_000);
    if (scenario === "worker") f.io.env.ARMADA_TICKET = "DEMO-18";
    if (scenario === "job")
      await f.store.startJob({
        project: "widgets",
        ticket: "DEMO-18",
        name: "evaluation",
        startedBy: "default",
        at: NOW,
      });
    if (scenario === "deploy") {
      const path = join(f.io.cwd, "armada.toml");
      await writeFile(
        path,
        `${await readFile(path, "utf8")}\n[[deploy.target]]\nname = "web"\nlive_sha_command = "echo pending"\nsmoke = "echo ok"\n`,
      );
    }
    const flags = scenario === "json" ? ["--json"] : scenario === "dry-run" ? ["--dry-run"] : [];
    expect(await run(["merge", "9", ...flags], f.io), f.err()).toBe(0);
    const hint = "No deploy check after merges: add [[deploy.target]] with a smoke command (armada doctor lists it)";
    if (scenario === "first" || scenario === "job") {
      expect(f.out()).toContain(hint);
      expect(f.out().indexOf(hint)).toBeLessThan(f.out().indexOf("keep watching:"));
      expect(f.out().includes("long runs: configure [jobs.<name>] and use armada job")).toBe(scenario === "job");
    } else expect(f.out()).not.toContain(hint);
    if (scenario !== "reserved")
      expect(await reserveNotice(paths, "hint:deploy:widgets", NOW, 86_400_000)).toBe(
        scenario !== "first" && scenario !== "job",
      );
  },
);

test.each([false, true])(
  "--no-notify preserves the manual list even with unavailable live state (%s)",
  async (liveDown) => {
    const f = await fixture();
    f.net.liveDown = liveDown;
    expect(await run(["merge", "9", "--no-notify"], f.io)).toBe(0);
    expect(f.out()).toContain("Tell these workers in flight what landed on main");
    expect(f.out()).toContain("DEMO-11  implementing  Claude Code · ws-11");
    expect(f.out()).not.toContain("not affected");
    expect(f.armada.calls.some((c) => c.path === "fleet/answer")).toBe(false);
  },
);

test.each([
  "overlap",
  "partial",
  "herdr",
  "unknown-outcome",
  "shared",
  "unsupported",
  "failed",
  "replaced",
  "fresh-owner-transfer",
  "fresh-own-transfer",
  "shared-other-owner",
  "boundary-owner-transfer",
  "late-owner-transfer",
  "late-owner-transfer-state-outage",
  "late-hand-back",
  "late-shared-hand-back",
  "no-notify",
  "files-unknown",
  "truncated-prs",
  "old-server",
  "live-hand-back",
  "live-outage",
  "both-outages",
  "no-pr",
  "handed-back",
  "before-archive",
])("merge notes select recipients and deliver before archive (%s)", async (scenario) => {
  const f = await fixture();
  if (scenario === "partial")
    f.linear.post(
      "DEMO-18",
      `Agent status: ready-to-merge — PR #9, head ${f.head}, CI green; more PRs: the dashboard part`,
      "2026-03-04T09:50:00Z",
    );
  const reservedKeys: string[] = [];
  const recordedKeys: { ticket: string; key: string }[] = [];
  const recordNotice = f.store.recordMergeNotice;
  f.store.recordMergeNotice = async (input) => {
    recordedKeys.push({ ticket: input.ticket, key: input.key });
    return recordNotice(input);
  };
  const reserveNotice = f.store.prepareMergeNotice;
  f.store.prepareMergeNotice = async (project, key, at) => {
    reservedKeys.push(key);
    return reserveNotice(project, key, at);
  };
  const herdrTree = join(f.io.cwd, "..", "herdr-worker");
  const herdrHandle = JSON.stringify({ workspace: "ws-worker", pane: "pane-worker", agent: "worker" });
  if (scenario === "herdr") f.git("worktree", "add", "-b", "feature/demo-11-worker", herdrTree, "main");
  const pulls = structuredClone(githubPulls.data.repository.open.nodes) as RawPull[];
  for (const p of pulls) {
    if (
      p.number === 7 ||
      (["shared", "shared-other-owner", "late-shared-hand-back"].includes(scenario) && p.number === 8)
    ) {
      p.files = { nodes: [{ path: "src/lists.ts", additions: 1, deletions: 1 }], pageInfo: { hasNextPage: false } };
    }
  }
  f.net.workerPulls = scenario === "no-pr" ? pulls.filter((p) => p.number !== 7) : pulls;
  if (scenario === "files-unknown") f.net.forgeDown = true;
  if (scenario === "truncated-prs") f.net.truncatedPrs = true;
  if (scenario === "old-server") f.net.oldServer = true;
  if (scenario === "live-outage") f.net.liveDown = true;
  if (scenario === "both-outages") {
    f.net.liveDown = true;
    f.net.forgeDown = true;
  }
  if (scenario === "live-hand-back")
    await f.store.recordEvent({
      project: "widgets",
      ticket: "DEMO-11",
      kind: "report",
      phase: "ready-to-merge",
      message: "handed back after the tracker read",
      at: new Date(NOW.getTime() + 1000),
    });
  if (scenario === "handed-back") {
    const original = f.io.fetch as Fetch;
    f.io.fetch = async (url, init) => {
      const response = await original(url, init);
      if (!url.startsWith("https://api.linear.app/")) return response;
      const body = (await response.json()) as { data: { issues?: { nodes: RawIssue[] } } };
      for (const issue of body.data.issues?.nodes ?? [])
        if (issue.identifier === "DEMO-11" && issue.labels) {
          issue.labels.nodes = issue.labels.nodes.filter((l) => !["implementing", "shipping"].includes(l.name));
          issue.labels.nodes.push({ name: "ready-to-merge", parent: { name: "Agent phase" } });
        }
      return Response.json(body);
    };
  }
  for (const ticket of ["shared", "shared-other-owner", "late-shared-hand-back"].includes(scenario)
    ? ["DEMO-11", "DEMO-16"]
    : ["DEMO-11"]) {
    await f.store.saveRuntimeHandle({
      project: "widgets",
      ticket,
      runtime: scenario === "unsupported" ? "Claude Code" : scenario === "herdr" ? "herdr" : "Conductor",
      handle: scenario === "herdr" ? herdrHandle : "ws-worker/ses-worker",
      branch: scenario === "herdr" ? "feature/demo-11-worker" : null,
      at: NOW,
    });
  }
  let transferred = false;
  const transfer = async () => {
    expect(
      await f.store.transferTickets({
        project: "widgets",
        tickets: ["DEMO-11"],
        to: scenario === "fresh-own-transfer" ? "default" : "release",
        ...(scenario === "fresh-own-transfer" ? { from: "release" } : {}),
        at: NOW,
      }),
    ).toBe(true);
    transferred = true;
  };
  if (scenario === "late-owner-transfer-state-outage") {
    const original = f.io.fetch as Fetch;
    f.io.fetch = (url, init) =>
      transferred && url.endsWith("/fleet/events/state")
        ? Promise.reject(new Error("synthetic phase read outage"))
        : original(url, init);
  }
  if (scenario === "fresh-own-transfer" || scenario === "shared-other-owner")
    expect(
      await f.store.transferTickets({
        project: "widgets",
        tickets: [scenario === "fresh-own-transfer" ? "DEMO-11" : "DEMO-16"],
        to: "release",
        at: NOW,
      }),
    ).toBe(true);
  if (["fresh-owner-transfer", "fresh-own-transfer", "boundary-owner-transfer"].includes(scenario)) {
    const original = f.io.fetch as Fetch;
    let reads = 0;
    f.io.fetch = async (url, init) => {
      if (f.merged() && url.endsWith("/fleet/runtime/handles")) {
        reads++;
        if (scenario === "boundary-owner-transfer" && reads === 3) await transfer();
        const response = await original(url, init);
        // Keep the status snapshot stale; the following claim read must win.
        if (["fresh-owner-transfer", "fresh-own-transfer"].includes(scenario) && reads === 1) await transfer();
        return response;
      }
      return original(url, init);
    };
  }
  if (scenario === "before-archive")
    await f.store.saveRuntimeHandle({
      project: "widgets",
      ticket: "DEMO-18",
      runtime: "Conductor",
      handle: "ws-merged/ses-merged",
      branch: BRANCH,
      at: NOW,
    });
  const native: { args: string[]; input?: string }[] = [];
  const exec = f.io.exec as Exec;
  f.io.exec = async (command, args, options) => {
    if (command === "herdr") {
      native.push({ args, input: options.input });
      const result =
        args[0] === "workspace"
          ? {
              workspace: {
                workspace_id: "ws-worker",
                worktree: {
                  is_linked_worktree: true,
                  repo_root: f.io.cwd,
                  checkout_path: herdrTree,
                },
              },
            }
          : { agent: { name: "worker", pane_id: "pane-worker", workspace_id: "ws-worker", agent_status: "idle" } };
      return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
    }
    if (command !== "conductor") return exec(command, args, options);
    native.push({ args, input: options.input });
    if (["late-owner-transfer", "late-owner-transfer-state-outage"].includes(scenario) && args[1] === "session")
      await transfer();
    if (["late-hand-back", "late-shared-hand-back"].includes(scenario) && args[1] === "session")
      await f.store.recordEvent({
        project: "widgets",
        ticket: scenario === "late-shared-hand-back" ? "DEMO-16" : "DEMO-11",
        kind: "report",
        phase: "ready-to-merge",
        message: "handed back during native provenance",
        at: new Date(NOW.getTime() + 1000),
      });
    if (scenario === "failed") return { code: 4, stdout: "armada_launch_CANARY", stderr: "private runtime output" };
    if (scenario === "unknown-outcome" && args[1] === "message")
      return { code: 4, stdout: "", stderr: "lost reply after native write" };
    if (scenario === "replaced")
      await f.store.saveRuntimeHandle({
        project: "widgets",
        ticket: "DEMO-11",
        runtime: "Conductor",
        handle: "ws-new/ses-new",
        branch: null,
        at: new Date(NOW.getTime() + 1000),
      });
    const mergedWorker = args.at(-1) === "ses-merged" || args.at(-1) === "ws-merged";
    const body =
      args[1] === "session"
        ? {
            sessionId: mergedWorker ? "ses-merged" : "ses-worker",
            workspaceId: mergedWorker ? "ws-merged" : "ws-worker",
            status: "idle",
          }
        : args[1] === "workspace"
          ? args[2] === "archive"
            ? { status: "archived" }
            : { workspaceId: mergedWorker ? "ws-merged" : "ws-worker", status: "ready" }
          : { messageId: args.at(-1), state: "sent" };
    if (args[1] === "message") expect(f.merged()).toBe(true);
    return { code: 0, stdout: JSON.stringify(body), stderr: "" };
  };
  expect(await run(["merge", "9", "--json", ...(scenario === "no-notify" ? ["--no-notify"] : [])], f.io)).toBe(0);
  const o = JSON.parse(f.out());
  if (scenario === "partial") {
    expect(o.keepOpen).toBe(true);
    expect(o.archive).toBeNull();
    expect(o.unblocked).toBeNull();
    expect(o.notices.some((w: { ticket: string }) => w.ticket === "DEMO-18")).toBe(false);
    expect(f.armada.calls.some((c) => c.path === "workers/end")).toBe(false);
    expect((await f.store.getRuntimeHandle("widgets", "DEMO-18"))?.releasedAt).toBeNull();
    expect(o.lines.join("\n")).toContain("Continue with: the dashboard part");
  }
  const messages = () => native.filter((c) => c.args[1] === "message" || c.args[1] === "prompt");
  const delivers = ["overlap", "partial", "herdr", "shared", "before-archive", "fresh-own-transfer"].includes(scenario);
  expect(messages()).toHaveLength(delivers || scenario === "unknown-outcome" ? 1 : 0);
  if (delivers) {
    expect(o.notified.map((n: { ticket: string; delivered: boolean }) => [n.ticket, n.delivered])).toEqual(
      scenario === "shared"
        ? [
            ["DEMO-11", true],
            ["DEMO-16", true],
          ]
        : [["DEMO-11", true]],
    );
    const message = scenario === "herdr" ? messages()[0]?.args[3] : messages()[0]?.input;
    expect(message).toContain('main moved: PR #9 "feat(lists): share a list by link" (DEMO-18) merged as 5555555.');
    expect(message).toContain("your PR #7 (DEMO-11) also changes: src/lists.ts");
    expect(message).toContain("shareList");
    expect(message).toContain("git fetch origin && git merge origin/main, then run the checks again");
    // Merge retries use the durable receipt identity, even when the notice's text changes.
    if (scenario !== "herdr") {
      const note = recordedKeys.find((n) => n.ticket === "DEMO-11");
      if (!note) throw new Error("the peer's generated note was not recorded");
      expect(reservedKeys).toContain(note.key);
      expect(messages()[0]?.args.at(-1)).toBe(note.key);
    }
    const notes = f.store.items.filter((i) => i.kind === "note");
    expect(notes).toHaveLength(scenario === "shared" ? 2 : 1);
    expect(notes.every((n) => n.resolvedAt === NOW.toISOString())).toBe(true);
    expect(f.linear.bodies).toHaveLength(1);
    if (scenario === "before-archive") {
      expect(o.archive.archived).toBe(true);
      expect(native.findIndex((c) => c.args[1] === "message")).toBeLessThan(
        native.findIndex((c) => c.args[2] === "archive"),
      );
    }
    if (["overlap", "herdr"].includes(scenario)) {
      // Armada's durable receipt prevents native calls and duplicate notes on retries, regardless of runtime.
      const retry = await afterMerge(
        f.io,
        parseConfig(DEMO_TOML),
        resolveCredentials({ env: f.io.env }),
        { ...o, hints: ["A refreshed hint"] },
        { noArchive: true },
      );
      expect(retry.notified[0]?.delivered).toBe(true);
      expect(messages()).toHaveLength(1);
      expect(f.store.items.filter((i) => i.kind === "note")).toHaveLength(1);
    }
  } else if (["unsupported", "failed", "replaced", "old-server", "unknown-outcome"].includes(scenario)) {
    expect(o.notified[0]).toMatchObject({ ticket: "DEMO-11", delivered: false });
    expect(o.notified[0].text).toContain("git merge origin/main");
    expect(f.store.items.filter((i) => i.kind === "note")).toHaveLength(0);
    if (scenario === "unknown-outcome") {
      const retry = await afterMerge(f.io, parseConfig(DEMO_TOML), resolveCredentials({ env: f.io.env }), o, {
        noArchive: true,
      });
      expect(retry.notified[0]?.detail).toContain("unknown outcome");
      expect(messages()).toHaveLength(1);
    }
  } else expect(o.notified).toEqual([]);
  if (
    [
      "fresh-owner-transfer",
      "boundary-owner-transfer",
      "late-owner-transfer",
      "late-owner-transfer-state-outage",
      "shared-other-owner",
    ].includes(scenario)
  ) {
    expect(o.notAffected).toContainEqual({ ticket: "DEMO-11", why: "owned by coordinator release" });
    if (!["late-owner-transfer", "late-owner-transfer-state-outage"].includes(scenario))
      expect(f.armada.calls.some((c) => c.path === "fleet/merge-notice/prepare")).toBe(false);
    expect(f.store.items.filter((i) => i.kind === "note")).toHaveLength(0);
  }
  if (["handed-back", "live-hand-back", "late-hand-back", "late-shared-hand-back"].includes(scenario))
    expect(o.notAffected).toContainEqual({ ticket: "DEMO-11", why: "already handed back" });
  if (scenario === "no-pr") expect(o.notAffected).toContainEqual({ ticket: "DEMO-11", why: "no pull request yet" });
  if (["files-unknown", "truncated-prs", "both-outages"].includes(scenario))
    expect(o.notAffected.every((w: { why: string }) => w.why === "files unknown")).toBe(true);
  if (scenario === "live-outage") {
    expect(o.workersListed).toBe(true);
    expect(o.workers.map((w: { ticket: string }) => w.ticket)).toContain("DEMO-11");
    expect(o.notAffected.every((w: { why: string }) => w.why === "worker state unknown")).toBe(true);
    expect(o.noticeFallback).toBe("worker state unknown");
  }
  if (
    ![
      "shared",
      "shared-other-owner",
      "late-shared-hand-back",
      "files-unknown",
      "truncated-prs",
      "live-outage",
      "both-outages",
    ].includes(scenario)
  )
    expect(o.notAffected).toContainEqual({ ticket: "DEMO-16", why: "not affected" });
  expect(f.err() + f.out()).not.toContain("CANARY");
  expect(f.err() + f.out()).not.toContain("private runtime output");
});

/** A coordinator's terminal, signed in to the fake Armada with an organization API key unless `signedIn` is false. */
async function fixture({ signedIn = true, unblocks = false }: { signedIn?: boolean; unblocks?: boolean } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "armada-merge-test-")));
  dirs.push(home);
  const origin = join(home, "origin.git");
  const work = join(home, "widgets");
  // Git only: no user or system config, so hooks, signing and templates of the machine never apply.
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Ada Worker",
    GIT_AUTHOR_EMAIL: "ada@example.com",
    GIT_COMMITTER_NAME: "Ada Worker",
    GIT_COMMITTER_EMAIL: "ada@example.com",
  };
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: work, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = async (path: string, text: string) => {
    await mkdir(join(work, path, ".."), { recursive: true });
    await writeFile(join(work, path), text);
  };
  spawnSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin], { env });
  await mkdir(work);
  git("init", "--quiet", "--initial-branch=main");
  git("remote", "add", "origin", origin);
  await write(
    "armada.toml",
    `${DEMO_TOML}\n[gates]\nrequired_checks = ["test"]\nlocal_commands = ["test -f src/share.ts", "grep -q shareListByLink src/lists.ts"]\n${unblocks ? '[conductor.profiles.backend]\nagent = "codex"\nmodel = "example-model"\neffort = "high"\n' : ""}`,
  );
  await write("src/lists.ts", "export function shareList(id: string) {\n  return id;\n}\n");
  await write("src/menu.ts", 'import { shareList } from "./lists";\nshareList("a");\n');
  git("add", "--all");
  git("commit", "--quiet", "--message", "chore: start");
  git("push", "--quiet", "origin", "main");
  const fork = git("rev-parse", "HEAD");

  // The worker's pull request renames shareList.
  git("switch", "--quiet", "--create", BRANCH);
  await write("src/lists.ts", "export function shareListByLink(id: string) {\n  return id;\n}\n");
  await write("src/menu.ts", 'import { shareListByLink } from "./lists";\nshareListByLink("a");\n');
  git("commit", "--quiet", "--all", "--message", "feat(lists): share a list by link");
  const head = git("rev-parse", "HEAD");
  git("push", "--quiet", "origin", `${BRANCH}:refs/pull/9/head`);
  const diff = git("diff", fork, head);

  // Meanwhile main gained a caller of the old name.
  git("switch", "--quiet", "main");
  await write("src/share.ts", 'import { shareList } from "./lists";\nexport const share = shareList;\n');
  git("add", "--all");
  git("commit", "--quiet", "--message", "feat: share button");
  git("push", "--quiet", "origin", "main");
  const base = git("rev-parse", "HEAD");

  let merged = false;
  const ghCalls: string[][] = [];
  // The pull request as GitHub shows it; `gh api … update-branch` merges main into it, as GitHub does.
  const pr = { head, state: "CLEAN", check: { status: "COMPLETED", conclusion: "SUCCESS" as string | null } };
  const exec: Exec = async (command, args, { cwd }) => {
    if (command === "gh" && args[0] === "pr" && args[1] === "comment") {
      ghCalls.push(args);
      return { code: 0, stdout: "comment posted", stderr: "" };
    }
    if (command === "gh" && args[0] === "api") {
      ghCalls.push(args);
      git("switch", "--quiet", BRANCH);
      git("merge", "--quiet", "--no-ff", "--no-edit", "main");
      git("push", "--quiet", "--force", "origin", `${BRANCH}:refs/pull/9/head`);
      Object.assign(pr, {
        head: git("rev-parse", "HEAD"),
        state: "BLOCKED",
        check: { status: "IN_PROGRESS", conclusion: null },
      });
      git("switch", "--quiet", "main");
      return { code: 0, stdout: '{"message":"Updating pull request branch."}', stderr: "" };
    }
    if (command === "gh") {
      ghCalls.push(args);
      merged = true;
      return { code: 0, stdout: "", stderr: "✓ Squashed and merged pull request #9\n" };
    }
    const r = spawnSync(command, args, { cwd, env, encoding: "utf8" });
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  };

  const linearProgram = recordedFetch({
    linear: unblocks
      ? (recorded) => {
          const nodes = recorded.Children.find((r) => r.data.issues.nodes.some((i) => i.identifier === "DEMO-12"))?.data
            .issues.nodes as RawIssue[] | undefined;
          const template = nodes?.find((i) => i.identifier === "DEMO-12");
          if (!nodes || !template) throw new Error("missing fixture template");
          for (const [id, labels, blockers] of [
            ["DEMO-19", ["ready-for-agent"], []],
            ["DEMO-20", [], []],
            ["DEMO-21", ["ready-for-agent", "parked"], []],
            ["DEMO-22", ["ready-for-agent"], ["EXT-1"]],
            ["DEMO-23", ["ready-for-agent"], []],
          ] as const) {
            nodes.push({
              ...structuredClone(template),
              id: `uuid-${id}`,
              identifier: id,
              title: `Follow-up ${id}`,
              state: { name: id === "DEMO-23" ? "Triage" : "Backlog", type: id === "DEMO-23" ? "triage" : "backlog" },
              labels: { pageInfo: { hasNextPage: false }, nodes: labels.map((name) => ({ name, parent: null })) },
              inverseRelations: {
                pageInfo: { hasNextPage: false },
                nodes: ["DEMO-18", ...blockers].map((identifier) => ({
                  type: "blocks",
                  issue: { identifier, state: { type: "started" } },
                })),
              },
            });
          }
          // The native follow-up launcher reads the program again before minting a token.
          recorded.Root.push(...structuredClone(recorded.Root));
          recorded.Children.push(...structuredClone(recorded.Children));
          recorded.Comments.push(...structuredClone(recorded.Comments));
        }
      : undefined,
  });
  const store = memoryFleet();
  const armada = fakeArmada({
    keys: { [KEY]: "coordinator" },
    store,
    vault: { linear: { apiKey: "lin_test", scope: "own" as const }, now: () => NOW },
  });
  const net = {
    armadaDown: false,
    confirmMerge: true,
    forgeDown: false,
    truncatedPrs: false,
    oldServer: false,
    liveDown: false,
    workerPulls: null as RawPull[] | null,
  };
  const fetch: Fetch = async (url, init) => {
    if (url.startsWith(`${ARMADA_URL}/`)) {
      if (net.armadaDown) throw new TypeError("fetch failed");
      if (net.liveDown && merged && /fleet\/(events\/state|runtime\/handles)$/.test(url))
        throw new TypeError("live state unavailable");
      if (net.oldServer && /fleet\/(merge-notice\/prepare|answer\/generated)$/.test(url))
        return Response.json({ error: "no fleet operation", next: "update Armada" }, { status: 404 });
      return armada.fetch(url, init);
    }
    if (url === "https://api.github.com/repos/acme/widgets/pulls/9") return new Response(`${diff}\n`);
    if (url !== GITHUB_GRAPHQL) {
      const response = await linearProgram.fetch(url, init);
      if (!unblocks) return response;
      // The post-close read sees the writer's state, while relation states can still be old.
      expect(linear.get("DEMO-18").statusType).toBe(merged ? "completed" : "started");
      const body = (await response.json()) as { data?: { issues?: { nodes: RawIssue[] } } };
      for (const i of body.data?.issues?.nodes ?? [])
        if (i.identifier === "DEMO-18" && i.state) {
          i.state.type = linear.get("DEMO-18").statusType;
        }
      return Response.json(body);
    }
    const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, string> };
    if (/query Pulls/.test(query)) {
      if (net.forgeDown) throw new TypeError("GitHub is unavailable");
      const body = (await (await linearProgram.fetch(url, init)).json()) as {
        data: { repository: { open: { nodes: RawPull[]; pageInfo: { hasNextPage: boolean } } } };
      };
      body.data.repository.open.pageInfo = { hasNextPage: net.truncatedPrs };
      if (net.workerPulls) body.data.repository.open.nodes = net.workerPulls;
      return Response.json(body);
    }
    if (/query Compare/.test(query)) {
      const compare =
        variables.head === base
          ? { status: "IDENTICAL", aheadBy: 0, behindBy: 0 }
          : spawnSync("git", ["merge-base", "--is-ancestor", "main", String(variables.head)], { cwd: work, env })
                .status === 0
            ? { status: "AHEAD", aheadBy: 2, behindBy: 0 }
            : { status: "DIVERGED", aheadBy: 1, behindBy: 1 };
      return Response.json({ data: { repository: { ref: { target: { oid: base }, compare } } } });
    }
    if (/query Commit/.test(query)) {
      const [oid = "", ...parents] = git("rev-list", "--parents", "-n", "1", String(variables.oid)).split(" ");
      const tree = git("rev-parse", `${oid}^{tree}`);
      const nodes = parents.map((p) => ({ oid: p }));
      return Response.json({ data: { repository: { object: { oid, tree: { oid: tree }, parents: { nodes } } } } });
    }
    return Response.json({
      data: {
        repository: {
          pullRequest: {
            number: Number(variables.number ?? 9),
            title: "feat(lists): share a list by link",
            url: `https://github.com/acme/widgets/pull/${variables.number ?? 9}`,
            state: merged && net.confirmMerge ? "MERGED" : "OPEN",
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: merged ? "UNKNOWN" : pr.state,
            headRefName: BRANCH,
            headRefOid: pr.head,
            baseRefName: "main",
            createdAt: "2026-03-04T08:00:00Z",
            updatedAt: "2026-03-04T09:00:00Z",
            mergedAt: merged ? "2026-03-04T10:00:00Z" : null,
            mergeCommit: merged && net.confirmMerge ? { oid: SQUASH } : null,
            reviewThreads: { totalCount: 1, nodes: [{ isResolved: true }] },
            files: {
              nodes: ["src/lists.ts", "src/menu.ts"].map((path) => ({ path, additions: 1, deletions: 1 })),
              pageInfo: { hasNextPage: false },
            },
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      state: "SUCCESS",
                      contexts: {
                        nodes: [{ __typename: "CheckRun", name: "test", ...pr.check }],
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    });
  };

  const linear = new FakeLinear();
  const label = (id: string) => LABELS.find((l) => l.id === id) ?? { id, name: id, group: null };
  linear.add("DEMO-18", {
    statusType: "started",
    stateId: "st-progress",
    labels: [label("phase-ready-to-merge"), label("rt-claude")],
  });
  linear.post("DEMO-18", `Agent status: ready-to-merge — PR #9, head ${head}, CI green`, "2026-03-04T09:40:00Z");

  await store.ensureProject(DEMO_PROJECT, NOW);
  for (const [ticket, handle] of [
    ["DEMO-18", "ws-18"],
    ["DEMO-11", "ws-11"],
  ] as const)
    await store.saveRuntimeHandle({
      project: "widgets",
      ticket,
      runtime: "Claude Code",
      handle,
      branch: null,
      at: NOW,
    });

  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd: work,
    env: {
      LINEAR_API_KEY: "lin_test",
      GITHUB_TOKEN: "gh_test",
      XDG_CONFIG_HOME: join(home, "config"),
      ...(signedIn ? { ARMADA_API_URL: ARMADA_URL, ARMADA_API_KEY: KEY } : {}),
    },
    readFile: (path) => readFile(path, "utf8").catch(() => null),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ghToken: () => null,
    fetch,
    now: () => NOW,
    exec,
    // Time passing: the checks on the head finish.
    sleep: async () => {
      Object.assign(pr, { state: "CLEAN", check: { status: "COMPLETED", conclusion: "SUCCESS" } });
    },
    linearWriter: () => linear,
  };
  return {
    io,
    git,
    head,
    pr,
    linear,
    ghCalls,
    armada,
    store,
    net,
    linearReads: () => linearProgram.calls.filter((c) => c.operation === "Root").length,
    merged: () => merged,
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

test.each([false, true])("merge lists unblocked tickets and routed launch hints (json=%s)", async (json) => {
  const f = await fixture({ unblocks: true });
  expect(await run(["merge", "9", ...(json ? ["--json"] : [])], f.io)).toBe(0);
  expect(f.err()).not.toContain("warning");
  expect(f.linearReads()).toBe(1);
  if (json)
    expect(JSON.parse(f.out()).unblocked).toEqual({
      ready: [
        {
          id: "DEMO-19",
          readyForAgent: true,
          reason: "ready for an agent",
          route: { profile: "backend", why: "the only profile in armada.toml" },
          launch: "armada brief DEMO-19 --prompt --profile backend",
        },
        {
          id: "DEMO-20",
          readyForAgent: false,
          reason: "no ready label",
          route: { profile: "backend", why: "the only profile in armada.toml" },
          launch: null,
        },
        {
          id: "DEMO-23",
          readyForAgent: false,
          reason: "in triage",
          route: { profile: "backend", why: "the only profile in armada.toml" },
          launch: null,
        },
      ],
      parked: ["DEMO-21"],
      nowWaitsOn: [{ id: "DEMO-22", on: ["EXT-1"] }],
    });
  else {
    expect(f.out()).toContain(
      "Unblocked by DEMO-18: DEMO-19 (ready for an agent), DEMO-20 (no ready label), DEMO-23 (in triage), DEMO-21 (parked)",
    );
    expect(f.out()).toContain("armada brief DEMO-19 --prompt --profile backend # the only profile in armada.toml");
    const launchLine = f
      .out()
      .split("\n")
      .find((line) => line.trimStart().startsWith("armada brief"));
    expect(spawnSync("sh", ["-n"], { input: launchLine, encoding: "utf8" }).status).toBe(0);
    expect(f.out()).toContain("DEMO-22 now waits only on EXT-1");
    expect(f.out()).not.toContain("armada brief DEMO-20");
    expect(f.out()).not.toContain("armada brief DEMO-21");
    expect(f.out()).not.toContain("armada brief DEMO-23");
  }
});

test("a coordinator's merge approval reason is masked before API and Linear comments", async () => {
  const f = await fixture();
  f.armada.secrets.set("widgets", new Map([["CUSTOM_KEY", "synthetic-project-secret"]]));
  expect(
    await run(
      ["merge", "9", "--ask-owner", "--reason", "inspect synthetic-project-secret and sk-synthetic-unknown"],
      f.io,
    ),
  ).toBe(0);
  const sent = JSON.stringify(f.armada.calls.filter((c) => c.path.startsWith("fleet/"))) + f.linear.bodies.join("\n");
  expect(sent).not.toContain("synthetic-project-secret");
  expect(sent).not.toContain("sk-synthetic-unknown");
  expect(sent).toContain("«secret CUSTOM_KEY»");
  expect(sent).toContain("«redacted»");
  expect(f.err()).toContain("masked CUSTOM_KEY");
  expect(f.err()).toContain("masked a value matching a key pattern");
  expect(f.merged()).toBe(false);
});

test.each([{ options: ["--dry-run"] }, { options: ["--no-ticket", "--reason", "configuration only"] }])(
  "a merge that closes no ticket lists nothing (%s)",
  async ({ options }) => {
    const f = await fixture();
    expect(await run(["merge", "9", "--json", ...options], f.io)).toBe(0);
    expect(JSON.parse(f.out()).unblocked).toBeNull();
  },
);

test("a named merge re-arms only its owned workers and pending launches", async () => {
  const f = await fixture();
  f.io.env.ARMADA_COORDINATOR = "front";
  expect(await f.store.transferTickets({ project: "widgets", tickets: ["DEMO-11"], to: "front", at: NOW })).toBe(true);
  await f.store.saveRuntimeHandle({
    project: "widgets",
    ticket: "DEMO-16",
    coordinator: "default",
    runtime: "conductor",
    handle: "ws/other",
    branch: null,
    at: NOW,
  });
  for (const [ticket, coordinator] of [
    ["DEMO-20", "default"],
    ["DEMO-21", "front"],
  ] as const)
    f.store.launches.push({
      project: "widgets",
      ticket,
      coordinator,
      launchedAt: NOW.toISOString(),
      tokenUsedAt: null,
      runtime: null,
      handle: null,
      endedAt: null,
    });
  expect(await run(["merge", "9", "--json"], f.io)).toBe(0);
  expect(JSON.parse(f.out()).watch.inFlight).toEqual(["DEMO-11", "DEMO-21"]);
});

test("armada merge test-merges a head behind main, merges it pinned to its SHA and says who to tell", async () => {
  const f = await fixture();
  expect(await run(["merge", "9"], f.io)).toBe(0);

  // The merge is pinned to the head and never deletes the branch.
  expect(f.ghCalls).toEqual([
    ["pr", "merge", "9", "--repo", "acme/widgets", "--squash", "--match-head-commit", f.head],
  ]);
  expect(
    f.out(),
  ).toBe(`Checklist passed for #9 (DEMO-18): handed back at ${f.head}, CLEAN, checks green, no open review thread.
Head lacks 1 commit(s) of main; the test merge passed every local command.
Decided: merged on its own (no merge rule).
Merged #9 into main as ${SQUASH} (head ${f.head}).
DEMO-18: moved to Done, agent and ready labels removed, merged status posted.
https://github.com/acme/widgets/pull/9
https://linear.app/acme/issue/DEMO-18
Hints for you to judge (not blocking):
  - \`shareList\`, removed from src/lists.ts, still appears on main in src/share.ts
  DEMO-16: not affected.
  DEMO-11: not affected.
No deploy check after merges: add [[deploy.target]] with a smoke command (armada doctor lists it)
2 workers in flight (DEMO-11, DEMO-16) — keep watching: armada watch
No runtime guide is installed for Claude Code, so Armada has nothing to archive for DEMO-18 (Claude Code · ws-18): a local session or subagent ends with its task; stop it yourself if it still runs.
Result: merged #9
`);
  expect(f.err()).not.toContain("warning");
  expect(f.linear.get("DEMO-18").statusType).toBe("completed");
  // The throwaway worktree is gone.
  expect(f.git("worktree", "list").split("\n")).toHaveLength(1);
  // Under the merge lock on Armada, given back afterwards; the merge recorded and the worker's session ended.
  // After the merge, events and claims are read together (Promise.all): their order is not part of the contract.
  const paths = f.armada.calls.map((c) => c.path);
  const after = paths.indexOf("workers/end") + 1;
  const released = paths.indexOf("fleet/lease/release");
  paths.splice(after, released - after, ...paths.slice(after, released).sort());
  expect(paths).toEqual([
    "fleet/coordinator",
    "secrets/release",
    "fleet/lease/acquire",
    "fleet/holds",
    "fleet/validations",
    "fleet/inbox/ticket",
    "fleet/holds",
    "fleet/lease/renew",
    "fleet/merge",
    "workers/end",
    "fleet/events/state",
    "fleet/runtime/handles",
    "fleet/runtime/handles",
    "fleet/lease/release",
    "fleet/launch-requests",
    "fleet/job/list",
  ]);
  expect(f.store.leases.size).toBe(0);
  expect(f.store.events.map((e) => [e.ticket, e.kind])).toEqual([["DEMO-18", "merge"]]);
  expect((await f.store.getRuntimeHandle("widgets", "DEMO-18"))?.releasedAt).toBe(NOW.toISOString());
});

test("signed in, Armada down refuses the merge; --no-lock merges anyway and says so", async () => {
  const f = await fixture();
  f.net.armadaDown = true;
  expect(await run(["merge", "9"], f.io)).toBe(1);
  expect(f.err()).toMatch(
    /armada: the merge lock could not be taken \(Armada \(armada\.example\.test\) unreachable: .+\); nothing was merged\nNext: the same armada merge again, or with --no-lock if you are sure no other coordinator merges now\n$/,
  );
  expect(f.ghCalls).toEqual([]);

  expect(await run(["merge", "9", "--no-lock"], f.io)).toBe(0);
  expect(f.merged()).toBe(true);
  expect(f.err()).toContain(
    "armada: warning: merged without the merge lock (--no-lock), merge holds were not checked: make sure no other coordinator merges in widgets now\n",
  );
  expect(f.err()).toMatch(/armada: warning: Armada: could not record the merge \(.+\)\n/);
  expect(f.linear.bodies.at(-1)).toContain(", merged without lock (--no-lock)");
});

test("not signed in, the merge goes on without the lock, with a warning", async () => {
  const f = await fixture({ signedIn: false });
  expect(await run(["merge", "9"], f.io)).toBe(0);
  expect(f.merged()).toBe(true);
  expect(f.err()).toContain(
    "armada: warning: not signed in to Armada (armada login); live activity is not recorded, Linear is; the merge lock was not taken, so make sure no other coordinator merges in widgets now\n",
  );
  expect(f.armada.calls).toEqual([]);
});

test("a merge lock held by another coordinator is waited for, then refused; nothing is merged", async () => {
  const f = await fixture();
  await f.store.acquireLease({
    project: "widgets",
    name: "merge",
    holder: "olive@laptop",
    ttlMs: 30 * 60_000,
    at: NOW,
  });
  expect(await run(["merge", "9"], f.io)).toBe(1);
  expect(f.out() + f.err()).toContain(
    "Waiting for the merge lock held by olive@laptop (until 2026-03-04T10:30:00.000Z)…",
  );
  expect(f.err()).toContain(
    "armada: the merge lock of widgets is still held by olive@laptop (until 2026-03-04T10:30:00.000Z)\nNext: the same armada merge again once that coordinator is done\n",
  );
  expect(f.ghCalls).toEqual([]);
  expect(f.store.leases.get("widgets\nmerge")?.holder).toBe("olive@laptop");
});

test("a refused checklist exits 1 and names each failure", async () => {
  const f = await fixture();
  f.linear.get("DEMO-18").labels = [];
  expect(await run(["merge", "https://github.com/acme/widgets/pull/9", "--dry-run"], f.io)).toBe(1);
  expect(f.err()).toContain(
    "armada: #9 (DEMO-18) cannot be merged:\n  - DEMO-18 has not been handed back: its agent phase is not set, not ready-to-merge\n",
  );
  expect(f.err()).toEndWith("Next: armada inbox --wait, until DEMO-18 is handed back\n");
  expect(f.ghCalls).toEqual([]);
});

test("armada merge --wait updates a head behind main on GitHub, proves the update only brings main in, and merges it", async () => {
  const f = await fixture();
  // The base branch requires heads to be up to date, so the update cannot be replaced by a test merge.
  f.pr.state = "BEHIND";
  expect(await run(["merge", "9", "--wait", "--timeout", "5"], f.io)).toBe(0);
  expect(f.ghCalls).toEqual([
    ["api", "--method", "PUT", "repos/acme/widgets/pulls/9/update-branch", "-f", `expected_head_sha=${f.head}`],
    ["pr", "merge", "9", "--repo", "acme/widgets", "--squash", "--match-head-commit", f.pr.head],
  ]);
  expect(f.pr.head).not.toBe(f.head);
  expect(f.err()).toContain(`armada: Updated the branch of #9 with main (a merge commit on ${f.head.slice(0, 7)}).\n`);
  expect(f.out()).toContain(
    `Checklist passed for #9 (DEMO-18): handed back at ${f.head}, now ${f.pr.head} with only main merged in (1 merge commit), CLEAN`,
  );
  expect(f.linear.bodies.at(-1)).toContain(`head ${f.pr.head}, the handed-back ${f.head} updated with main`);
});

test("armada merge refuses flags that do not go together", async () => {
  const f = await fixture();
  for (const [args, message] of [
    [["--no-ticket", "--ticket", "DEMO-18"], "--no-ticket and --ticket cannot go together"],
    [["--wait", "--dry-run"], "--wait and --dry-run cannot go together"],
    [["--timeout", "5"], "--timeout applies to --wait"],
    [["--wait", "--timeout", "soon"], '--timeout must be a number of minutes, got "soon"'],
  ] as const) {
    expect(await run(["merge", "9", ...args], f.io)).toBe(2);
    expect(f.err()).toContain(message);
  }
  expect(f.ghCalls).toEqual([]);
});

test("CLI accepts --no-ticket --reason and posts its audit comment without ending the worker", async () => {
  const f = await fixture();
  const before = structuredClone(f.linear.get("DEMO-18"));
  expect(await run(["merge", "9", "--no-ticket", "--reason", "config only"], f.io)).toBe(0);
  expect(f.ghCalls).toEqual([
    [
      "pr",
      "comment",
      "9",
      "--repo",
      "acme/widgets",
      "--body",
      `Armada merge --no-ticket at ${f.head}: config only. DEMO-18 stays open; its ticket and worker are left unchanged.`,
    ],
    ["pr", "merge", "9", "--repo", "acme/widgets", "--squash", "--match-head-commit", f.head],
  ]);
  expect(f.linear.get("DEMO-18")).toEqual(before);
  expect(f.linear.writes).toEqual([]);
  expect(f.armada.calls.map((c) => c.path)).not.toContain("workers/end");
  expect(f.store.events.filter((e) => e.kind === "merge")).toEqual([]);
  expect((await f.store.getRuntimeHandle("widgets", "DEMO-18"))?.releasedAt).toBeNull();
  expect(f.store.leases.size).toBe(0);
});

test.each([{ options: [] }, { options: ["--no-archive"] }])(
  "a confirmed merge launches its owned deferred follow-up through the shared Conductor launcher in the same run (%s)",
  async ({ options }) => {
    const f = await fixture({ unblocks: true });
    const readConfig = f.io.readFile;
    f.io.readFile = async (path) => {
      const contents = await readConfig(path);
      return path.endsWith("armada.toml") && contents ? `${contents}\n[policy]\nmax_workers = 2\n` : contents;
    };
    const originalFetch = f.io.fetch;
    const originalExec = f.io.exec;
    if (!originalFetch || !originalExec) throw new Error("missing adapters");
    f.io.env.XDG_CONFIG_HOME = join(f.io.cwd, ".config");
    f.io.fetch = async (url, init) => {
      if (url.endsWith("/fleet/launch-requests"))
        return Response.json({
          result: [
            {
              id: 3,
              ticket: "DEMO-19",
              profile: "backend",
              author: "Ada",
              owned: true,
              blockers: ["DEMO-18"],
              reason: "waits on DEMO-18",
              command: "armada launch DEMO-19 --profile backend",
            },
            {
              id: 4,
              ticket: "DEMO-20",
              profile: "backend",
              author: "Other",
              owned: false,
              blockers: ["DEMO-21"],
              reason: "waits on DEMO-21",
              command: "armada launch DEMO-20 --profile backend",
            },
          ],
        });
      if (url === "https://api.linear.app/graphql" && /query Brief\(/.test(String(init.body)))
        return Response.json({
          data: {
            issue: {
              identifier: "DEMO-19",
              title: "Follow-up DEMO-19",
              url: "https://linear.app/acme/issue/DEMO-19",
              branchName: "feature/demo-19",
              description: "Build the follow-up",
              state: { name: "Backlog", type: "backlog" },
              labels: { nodes: [{ name: "ready-for-agent" }], pageInfo: { hasNextPage: false } },
              parent: { identifier: "DEMO-2", title: "Spec 1 — Widgets", url: "https://linear.app/acme/issue/DEMO-2" },
              comments: { nodes: [], pageInfo: { hasNextPage: false } },
              inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          },
        });
      return originalFetch(url, init);
    };
    const created: string[] = [];
    f.io.exec = async (command, args, options) => {
      if (command !== "conductor") return originalExec(command, args, options);
      const a = args.slice(1);
      if (a[0] === "--version") return { code: 0, stdout: "0.90.1", stderr: "" };
      if (a[0] === "auth") return { code: 0, stdout: "", stderr: "" };
      const result =
        a[0] === "model"
          ? { agents: [{ agent: "codex", models: ["example-model"], efforts: ["high"], fastModeModels: [] }] }
          : {
              workspaceId: "ws-follow",
              sessionId: "s-follow",
              deepLink: "conductor://workspace?id=ws-follow&session=s-follow",
              initialMessage: { messageId: "msg-1", state: "queued" },
            };
      if (a[0] === "workspace" && a[1] === "create") {
        expect(f.merged()).toBe(true);
        expect(f.linear.get("DEMO-18").statusType).toBe("completed");
        expect(options.input).toContain("armada claim DEMO-19");
        created.push("DEMO-19");
      }
      return { code: 0, stdout: JSON.stringify(result), stderr: "" };
    };
    expect(await run(["merge", "9", "--json", ...options], f.io)).toBe(0);
    expect(f.err()).not.toContain("was not launched");
    expect(created).toEqual(["DEMO-19"]);
    expect(JSON.parse(f.out()).deferredLaunches).toMatchObject([
      { ticket: "DEMO-19", status: "launched", output: expect.stringContaining("Launched DEMO-19") },
    ]);
    expect(JSON.parse(f.out()).watch.inFlight).toContain("DEMO-19");
    expect(JSON.parse(f.out()).watch.inFlight).not.toContain("DEMO-20");
    const paths = machinePaths(f.io.env);
    if (!paths) throw new Error("missing watch state");
    expect(await readWatchState(paths, "widgets")).toMatchObject({
      waiting: ["DEMO-20"],
      slots: { taken: 2, max: 2 },
    });
    expect(f.out()).not.toContain("armada_launch_");
  },
);
test("when-green persists intent without merging, deduplicates, lists on a new invocation and removes", async () => {
  const f = await fixture();
  f.pr.state = "BEHIND";
  f.pr.check = { status: "IN_PROGRESS", conclusion: null };
  expect(await run(["merge", "--when-green", "9", "--reason", "Reviewed"], f.io)).toBe(0);
  expect(f.out()).toContain("queued #9 (1st)");
  expect(f.out().trim().split("\n").at(-1)).toBe("Result: not merged (queued for merge; nothing was merged)");
  expect(f.out()).toContain("Next: armada merge --drain (run in the background)");
  expect(f.merged()).toBe(false);
  expect(f.ghCalls).toEqual([]);
  expect(await run(["merge", "--when-green", "9"], f.io)).toBe(0);
  expect(f.out()).toContain("#9 is already queued.");
  const out: string[] = [];
  const freshIo = { ...f.io, stdout: (s: string) => out.push(s) };
  expect(await run(["merge", "queue", "--json"], freshIo)).toBe(0);
  expect(JSON.parse(out.join("")).result).toBe("Result: not merged (queue listed; nothing was merged)");
  expect(JSON.parse(out.join("")).entries).toMatchObject([
    { pr: 9, state: "queued", reason: "Reviewed", headSha: f.head },
  ]);
  expect(await run(["merge", "queue", "remove", "9"], f.io)).toBe(0);
  expect(f.out()).toContain("Removed #9");
  expect(f.out().trim().split("\n").at(-1)).toBe("Result: not merged (queue removal; nothing was merged)");
  expect((await f.store.queueList("widgets", { since: NOW }))[0]?.state).toBe("removed");
  expect(await run(["merge", "queue", "remove", "https://github.com/acme/widgets/pull/2147483648"], f.io)).toBe(2);
  expect(f.err()).toContain("pull request number must be between");
  expect(await run(["merge", "--when-green", "9", "--no-archive"], f.io)).toBe(2);
  expect(await run(["merge", "--when-green", "9", "--no-notify"], f.io)).toBe(2);
});

test.each(["plain", "json", "completion-outage", "recovery-outage", "native-lease-loss", "keep-open"])(
  "drain uses ordinary cleanup and truthful output (%s)",
  async (scenario) => {
    const json = scenario !== "plain";
    const keepOpen = scenario === "keep-open";
    const completionOutage = ["completion-outage", "recovery-outage"].includes(scenario);
    const f = await fixture();
    expect(await run(["merge", "--when-green", "9", ...(keepOpen ? ["--keep-open"] : [])], f.io)).toBe(0);
    const out: string[] = [];
    if (scenario === "native-lease-loss") {
      f.net.confirmMerge = false;
      const exec = f.io.exec!;
      f.io.exec = async (command, args, options) => {
        const result = await exec(command, args, options);
        if (command === "gh" && args[0] === "pr" && args[1] === "merge") {
          const lease = await f.store.getLease("widgets", "merge-queue");
          if (!lease) throw new Error("missing drain lease");
          await f.store.releaseLease({ project: "widgets", name: "merge-queue", holder: lease.holder });
          await f.store.acquireLease({
            project: "widgets",
            name: "merge-queue",
            holder: "peer",
            ttlMs: 600_000,
            at: NOW,
          });
        }
        return result;
      };
    }
    const fetch = f.io.fetch!;
    const io: Io = {
      ...f.io,
      stdout: (line) => out.push(line),
      fetch: async (url, init) =>
        completionOutage && url.endsWith("/fleet/queue/finish")
          ? Response.json({ error: "Armada did not answer" }, { status: 503 })
          : fetch(url, init),
    };
    expect(await run(["merge", "--drain", ...(json ? ["--json"] : [])], io), f.err()).toBe(
      completionOutage || scenario === "native-lease-loss" ? 1 : 0,
    );
    expect(f.merged()).toBe(true);
    if (scenario === "native-lease-loss") {
      const result = JSON.parse(out.join("").trim());
      expect(result.merged).toBe(false);
      expect(result.result).toContain("merge unconfirmed");
      expect(result.result).not.toContain("nothing was merged");
      expect((await f.store.queueList("widgets", { since: NOW }))[0]).toMatchObject({ state: "merging", attempts: 0 });
      expect(f.armada.calls.some((call) => call.path === "workers/end")).toBe(false);
      return;
    }
    expect((await f.store.queueList("widgets", { since: NOW }))[0]).toMatchObject({
      state: completionOutage ? "merging" : "merged",
      ...(!completionOutage ? { mergeCommit: SQUASH } : {}),
    });
    expect(f.armada.calls.some((c) => c.path === "workers/end")).toBe(!keepOpen);
    expect((await f.store.getRuntimeHandle("widgets", "DEMO-18"))?.releasedAt === null).toBe(keepOpen);
    if (keepOpen) {
      expect(f.linear.get("DEMO-18").statusType).toBe("started");
      expect((await f.linear.readTicket("DEMO-18"))?.agentPhase).toBe("implementing");
      expect(out.join("")).toContain("continuation");
    }
    if (json) {
      const objects = out
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(objects).toMatchObject(
        completionOutage
          ? [
              { merged: true, result: "Result: merged #9" },
              { merged: true, error: expect.any(String), result: "Result: merged #9" },
            ]
          : [{ merged: true, result: "Result: merged #9" }, { queue: "empty" }],
      );
    } else {
      expect(out.join("")).toContain("Result: merged #9");
      expect(out.join("")).toContain("queue empty");
    }
    if (completionOutage) {
      io.fetch = fetch;
      if (scenario === "recovery-outage") {
        f.linear.readTicket = async () => {
          throw new LinearError("Linear HTTP 503", true, true);
        };
        io.sleep = async () => {
          throw new Error("drain interrupted during retry wait");
        };
        out.length = 0;
        expect(await run(["merge", "--drain", "--json"], io), f.err()).toBe(1);
        expect(
          out
            .join("")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toMatchObject([{ merged: true, error: expect.any(String) }]);
        expect((await f.store.queueList("widgets", { since: NOW }))[0]).toMatchObject({ state: "queued", attempts: 1 });
        expect(
          (await f.store.openInboxItems({ project: "widgets", recipient: "coordinator" })).some(
            (item) => item.kind === "queue-refused",
          ),
        ).toBe(false);
        return;
      }
      expect(await run(["merge", "--drain", "--json"], io), f.err()).toBe(0);
      expect((await f.store.queueList("widgets", { since: NOW }))[0]).toMatchObject({
        state: "merged",
        mergeCommit: SQUASH,
      });
    }
    expect(await run(["merge", "--drain", "9"], f.io)).toBe(2);
    expect(await run(["merge", "--drain", "--no-lock"], f.io)).toBe(2);
  },
);

test("when-green queues multiple no-ticket PRs in argument order and preserves flags", async () => {
  const f = await fixture();
  expect(
    await run(
      ["merge", "--when-green", "12", "15", "--no-ticket", "--through-hold", "Fix main", "--reason", "Release"],
      f.io,
    ),
  ).toBe(0);
  expect(f.out()).toContain("queued #12 (1st)");
  expect(f.out()).toContain("queued #15 (2nd)");
  expect(
    (await f.store.queueList("widgets", { since: NOW })).map((e) => [
      e.pr,
      e.noTicket,
      e.keepOpen,
      e.throughHold,
      e.reason,
    ]),
  ).toEqual([
    [12, true, false, "Fix main", "Release"],
    [15, true, false, "Fix main", "Release"],
  ]);
  expect(f.merged()).toBe(false);
  expect(f.ghCalls).toEqual([]);
});

test.each([false, true])(
  "setup PR queue requires --no-ticket and drains without Linear writes (noTicket=%s)",
  async (noTicket) => {
    const f = await fixture();
    const fetch = f.io.fetch!;
    f.io.fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (url !== GITHUB_GRAPHQL) return response;
      const body = (await response.json()) as {
        data?: { repository?: { pullRequest?: { headRefName: string } } };
      };
      const pull = body.data?.repository?.pullRequest;
      if (pull) pull.headRefName = "armada/setup";
      return Response.json(body);
    };
    expect(f.merged()).toBe(false);
    expect(await f.store.queueList("widgets", { since: NOW })).toEqual([]);
    expect(f.linear.writes).toEqual([]);
    const options = noTicket ? ["--no-ticket", "--reason", "Repository setup"] : [];
    expect(await run(["merge", "--when-green", "9", ...options], f.io), f.err()).toBe(noTicket ? 0 : 1);
    if (!noTicket) {
      expect(f.err()).toContain("names no ticket");
      expect(f.err()).toContain("--no-ticket");
      expect(await f.store.queueList("widgets", { since: NOW })).toEqual([]);
      expect(f.ghCalls).toEqual([]);
    } else {
      expect((await f.store.queueList("widgets", { since: NOW }))[0]).toMatchObject({
        pr: 9,
        state: "queued",
        ticket: null,
        noTicket: true,
        reason: "Repository setup",
        headSha: f.head,
      });
      expect(f.merged()).toBe(false);
      expect(f.ghCalls).toEqual([]);
      expect(await run(["merge", "--drain"], f.io), f.err()).toBe(0);
      expect((await f.store.queueList("widgets", { since: NOW }))[0]).toMatchObject({
        state: "merged",
        mergeCommit: SQUASH,
      });
      expect(f.out()).toContain("Result: merged #9");
      expect(f.out()).toContain("No ticket: nothing was written to Linear.");
      expect(f.armada.calls.some((c) => c.path === "workers/end")).toBe(false);
    }
    expect(f.merged()).toBe(noTicket);
    expect(f.linear.writes).toEqual([]);
  },
);

// The real adapter talks to a fake native runtime: no Conductor commands or wall-clock waits.
test.each([
  "confirmed",
  "confirmed-json",
  "queue-lease-loss",
  "confirmed-external",
  "failed-external",
  "failed-json",
  "unrecorded",
  "unconfirmed",
  "own",
  "own-workspace",
  "shared",
  "shared-workspace",
  "shared-later",
  "no-archive",
  "dry-run",
  "no-ticket",
  "failed",
  "replaced",
])("merge archives only its confirmed, ended Armada worker (%s)", async (scenario) => {
  const f = await fixture();
  const handle = "ws-18/ses-18";
  const queued = scenario === "queue-lease-loss";
  const json = queued || scenario.endsWith("-json");
  const succeeds = ["confirmed", "confirmed-json", "confirmed-external", "unrecorded"].includes(scenario);
  const projectRoot = f.io.cwd;
  const configPath = join(projectRoot, "fleet config.toml");
  if (scenario.endsWith("-external")) {
    await writeFile(configPath, await readFile(join(projectRoot, "armada.toml"), "utf8"));
    f.io.cwd = tmpdir();
  }
  if (scenario === "unrecorded") {
    const fetch = f.io.fetch as Fetch;
    f.io.fetch = (url, init) =>
      url.endsWith("/fleet/runtime/observe") ? Promise.reject(new TypeError("fetch failed")) : fetch(url, init);
  }
  await f.store.saveRuntimeHandle({
    project: "widgets",
    ticket: "DEMO-18",
    runtime: "Conductor",
    handle,
    branch: BRANCH,
    at: NOW,
  });
  if (scenario === "shared" || scenario === "shared-workspace")
    await f.store.saveRuntimeHandle({
      project: "widgets",
      ticket: "DEMO-11",
      runtime: "Conductor",
      handle: scenario === "shared" ? handle : "ws-18/ses-11",
      branch: null,
      at: NOW,
    });
  if (scenario === "own" || scenario === "own-workspace")
    Object.assign(f.io.env, {
      CONDUCTOR_WORKSPACE_ID: "ws-18",
      CONDUCTOR_SESSION_ID: scenario === "own" ? "ses-18" : "ses-coordinator",
    });
  if (scenario === "unconfirmed") f.net.confirmMerge = false;
  const calls: string[][] = [];
  const exec = f.io.exec as Exec;
  f.io.exec = async (command, args, options) => {
    if (command !== "conductor") return exec(command, args, options);
    expect(options?.cwd).toBe(projectRoot);
    calls.push(args);
    if (queued) {
      const lease = await f.store.getLease("widgets", "merge-queue");
      if (lease && lease.holder !== "peer") {
        await f.store.releaseLease({ project: "widgets", name: "merge-queue", holder: lease.holder });
        await f.store.acquireLease({
          project: "widgets",
          name: "merge-queue",
          holder: "peer",
          ttlMs: 600_000,
          at: NOW,
        });
      }
    }
    if (scenario === "shared-later") {
      await f.store.saveRuntimeHandle({
        project: "widgets",
        ticket: "DEMO-11",
        runtime: "Conductor",
        handle: "ws-18/ses-11",
        branch: null,
        at: NOW,
      });
    }
    // Native runtime output must not leak even when archive fails.
    if (scenario.startsWith("failed"))
      return { code: 4, stdout: "armada_launch_CANARY", stderr: "private runtime output" };
    if (scenario === "replaced") {
      await f.store.saveRuntimeHandle({
        project: "widgets",
        ticket: "DEMO-18",
        runtime: "Conductor",
        handle: "ws-new/ses-new",
        branch: BRANCH,
        at: new Date(NOW.getTime() + 1000),
      });
    }
    const body =
      args[1] === "session"
        ? { sessionId: "ses-18", workspaceId: "ws-18", status: "idle" }
        : args[2] === "archive"
          ? { status: "archived" }
          : { workspaceId: "ws-18", status: "ready" };
    if (args[2] === "archive") {
      expect(f.merged()).toBe(true);
      if (!json) expect(f.out()).toContain("Merged #9");
      expect(f.armada.calls.at(-1)?.path).toBe("fleet/runtime/handles");
    }
    return { code: 0, stdout: JSON.stringify(body), stderr: "" };
  };
  const flags = scenario.endsWith("-external")
    ? ["--config", configPath]
    : scenario === "no-archive"
      ? ["--no-archive"]
      : scenario === "dry-run"
        ? ["--dry-run"]
        : scenario === "no-ticket"
          ? ["--no-ticket", "--reason", "config only"]
          : [];
  if (queued) expect(await run(["merge", "--when-green", "9"], { ...f.io, stdout: () => {} })).toBe(0);
  expect(
    await run(queued ? ["merge", "--drain", "--json"] : ["merge", "9", ...(json ? ["--json"] : []), ...flags], f.io),
  ).toBe(scenario === "unconfirmed" || queued ? 1 : 0);
  if (queued) {
    expect((await f.store.queueList("widgets", { since: NOW }))[0]?.state).toBe("merging");
    expect((await f.store.getLease("widgets", "merge-queue"))?.holder).toBe("peer");
    expect(
      f
        .out()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ merged: true })]));
  }
  expect(calls.filter((args) => args[1] === "workspace" && args[2] === "archive")).toEqual(
    succeeds ? [["--json", "workspace", "archive", "ws-18"]] : [],
  );
  if (json)
    expect(JSON.parse(queued ? f.out().split("\n")[0]! : f.out()).archive).toEqual({
      runtime: "Conductor",
      handle,
      archived: succeeds,
      detail: succeeds
        ? "archived"
        : queued
          ? "the queue was taken over"
          : "Conductor server error during workspace status (exit 4)",
    });
  if (scenario === "unrecorded") {
    expect(f.err()).toContain(
      "is merged and the workspace is archived, but Armada could not record it; run armada stop DEMO-18",
    );
    expect(f.out()).toContain("archived; Armada could not record cleanup");
  }
  if (scenario === "confirmed" || scenario === "confirmed-json") {
    expect(f.err()).not.toContain("warning");
    if (!json) expect(f.out()).toContain("DEMO-18: archived.");
    expect((await f.store.getRuntimeHandle("widgets", "DEMO-18"))?.runtimeState?.state).toBe("gone");
  }
  if (
    [
      "unconfirmed",
      "own",
      "own-workspace",
      "shared",
      "shared-workspace",
      "no-archive",
      "dry-run",
      "no-ticket",
    ].includes(scenario)
  )
    expect(calls).toEqual([]);
  if (scenario.startsWith("failed") || scenario === "replaced" || scenario === "shared-later") {
    expect(f.err()).toContain("#9 is merged, but the workspace of DEMO-18 was not archived");
    expect(f.err()).toContain("run armada stop DEMO-18");
    expect(f.err() + f.out()).not.toContain("CANARY");
    expect(f.err() + f.out()).not.toContain("private runtime output");
    if (scenario === "failed-external") expect(f.err()).toContain(`--config '${configPath}'`);
  }
});

test.each(["not-merged", "no-commit", "no-ticket", "keep-open", "claim-comment", "wrong-ticket"])(
  "afterMerge refuses incomplete archive evidence (%s)",
  async (scenario) => {
    const f = await fixture();
    const stored = await f.store.getRuntimeHandle("widgets", "DEMO-18");
    if (!stored) throw new Error("missing fixture claim");
    const h = {
      ...stored,
      runtime: "Conductor",
      handle: "ws-18/ses-18",
      releasedAt: NOW.toISOString(),
    };
    const outcome: MergeOutcome = {
      merged: scenario !== "not-merged",
      pr: {
        number: 9,
        url: "https://github.com/acme/widgets/pull/9",
        title: "feat: synthetic change",
        base: "main",
        headSha: f.head,
        mergeCommit: scenario === "no-commit" ? null : SQUASH,
      },
      ticket: scenario === "no-ticket" ? null : { id: "DEMO-18", url: "https://linear.app/acme/issue/DEMO-18" },
      lines: [],
      hints: [],
      workers: [],
      workersListed: true,
      unblocked: null,
      warnings: [],
      archive: {
        runtime: "Conductor",
        handle: h.handle,
        guide: null,
        source: scenario === "claim-comment" ? "claim" : "armada",
        claim: scenario === "wrong-ticket" ? { ...h, ticket: "DEMO-11" } : h,
        open: [],
      },
    };
    f.io.exec = async () => {
      throw new Error("must not reach the runtime");
    };
    const result = await afterMerge(f.io, parseConfig(DEMO_TOML), resolveCredentials({ env: f.io.env }), outcome, {
      keepOpen: scenario === "keep-open",
    });
    expect(result.archive?.archived ?? false).toBe(false);
    expect(f.armada.calls).toEqual([]);
    expect(f.err()).not.toContain("must not reach");
    if (scenario === "claim-comment" || scenario === "wrong-ticket")
      expect(f.err()).toContain("run armada stop DEMO-18");
  },
);

test.each([
  "delivered",
  "manual",
  "failed",
  "replaced",
  "linear-pending",
  "linear-pending-special-secret",
  "queue-recovery",
  "queue-unknown",
])("a partial merge retains its worker and continues safely (%s)", async (mode) => {
  const f = await fixture();
  const queued = mode.startsWith("queue-");
  const pending = mode.startsWith("linear-pending");
  const secret = mode === "linear-pending-special-secret" ? 'synthetic"project\\secret' : "synthetic-project-secret";
  f.armada.secrets.set("widgets", new Map([["CUSTOM_KEY", secret]]));
  f.linear.post(
    "DEMO-18",
    `Agent status: ready-to-merge — PR #9, head ${f.head}, CI green; more PRs: the dashboard part ${secret}`,
    "2026-03-04T09:50:00Z",
  );
  if (pending)
    f.linear.updateTicket = async () => {
      throw new Error("Linear unavailable");
    };
  await f.store.saveRuntimeHandle({
    project: "widgets",
    ticket: "DEMO-18",
    runtime: mode === "manual" ? "Claude Code" : "Conductor",
    handle: "ws-18/ses-18",
    branch: BRANCH,
    at: NOW,
  });
  const exec = f.io.exec as Exec;
  const calls: string[][] = [];
  const inputs: (string | undefined)[] = [];
  f.io.exec = async (command, args, options) => {
    if (command !== "conductor") return exec(command, args, options);
    calls.push(args);
    if (args[1] === "message" && args[2] === "create") {
      inputs.push(options?.input);
      expect(f.merged()).toBe(true);
      expect(options?.input).toContain(`git fetch origin && git switch -c ${BRANCH}-2 origin/main`);
      if (mode === "failed" || mode === "queue-unknown")
        return { code: 4, stdout: "armada_launch_CANARY", stderr: "private runtime output" };
      return { code: 0, stdout: JSON.stringify({ messageId: "message-1", state: "queued" }), stderr: "" };
    }
    if (mode === "replaced")
      await f.store.saveRuntimeHandle({
        project: "widgets",
        ticket: "DEMO-18",
        runtime: "Conductor",
        handle: "ws-new/ses-new",
        branch: BRANCH,
        at: new Date(NOW.getTime() + 1000),
      });
    return {
      code: 0,
      stdout: JSON.stringify(
        args[1] === "session"
          ? { sessionId: "ses-18", workspaceId: "ws-18", status: "idle" }
          : { workspaceId: "ws-18", status: "ready" },
      ),
      stderr: "",
    };
  };
  const fetch = f.io.fetch!;
  if (queued) {
    expect(await run(["merge", "--when-green", "9"], { ...f.io, stdout: () => {} })).toBe(0);
    f.io.fetch = async (url, init) =>
      url.endsWith("/fleet/queue/finish")
        ? Response.json({ error: "Armada did not answer" }, { status: 503 })
        : fetch(url, init);
  }
  expect(await run(queued ? ["merge", "--drain", "--json"] : ["merge", "9", "--json"], f.io)).toBe(queued ? 1 : 0);
  const out = JSON.parse(queued ? f.out().split("\n")[0]! : f.out());
  if (queued) {
    expect((await f.store.queueList("widgets", { since: NOW }))[0]?.state).toBe("merging");
    f.io.fetch = fetch;
    expect(await run(["merge", "--drain", "--json"], f.io)).toBe(0);
    expect((await f.store.queueList("widgets", { since: NOW }))[0]?.state).toBe("merged");
  }
  expect(out.keepOpen).toBe(true);
  expect(out.archive).toBeNull();
  expect(out.unblocked).toBeNull();
  expect(f.linear.get("DEMO-18").statusType).toBe("started");
  expect(f.armada.calls.map((c) => c.path)).not.toContain("workers/end");
  expect((await f.store.getRuntimeHandle("widgets", "DEMO-18"))?.releasedAt).toBeNull();
  expect(calls.some((args) => args[2] === "archive")).toBe(false);
  expect(inputs.length).toBe(mode === "delivered" || mode === "failed" || queued || pending ? 1 : 0);
  expect(out.lines.join("\n")).toContain(
    mode === "delivered" || mode === "queue-recovery" || pending ? "continuation delivered" : "Deliver to DEMO-18",
  );
  expect(f.out() + f.err()).not.toContain("CANARY");
  expect(inputs.join("\n") + f.out() + f.err() + f.linear.bodies.join("\n")).not.toContain(secret);
  expect(JSON.stringify(out.continuation)).toContain("«secret CUSTOM_KEY»");
  if (pending) {
    const chore = (await f.store.openInboxItems({ project: "widgets", recipient: "coordinator" })).find(
      (i) => i.kind === "linear-pending",
    );
    expect(chore?.body).toContain("«secret CUSTOM_KEY»");
    expect(chore?.body).not.toContain(secret);
  }
});

test("owner approval requests reject lifecycle overrides they cannot persist", async () => {
  const f = await fixture();
  for (const flag of ["--keep-open", "--close"])
    expect(await run(["merge", "9", "--ask-owner", "--reason", "Owner should check", flag], f.io)).toBe(2);
  expect(f.err()).toContain("--ask-owner only asks the owner");
  expect(await run(["merge", "9", "--when-green", "--close"], f.io)).toBe(2);
  expect(await run(["merge", "9", "--keep-open", "--close"], f.io)).toBe(2);
  expect(await run(["merge", "9", "--no-ticket", "--keep-open"], f.io)).toBe(2);
  expect(f.merged()).toBe(false);
  expect(f.ghCalls).toEqual([]);
  expect(f.linear.writes).toEqual([]);
});

test("Linear failure after merge ends with a pending result, and --finish is idempotent", async () => {
  const f = await fixture();
  const update = f.linear.updateTicket.bind(f.linear);
  f.linear.updateTicket = async () => {
    throw new Error("Linear unavailable");
  };
  expect(await run(["merge", "9", "--no-archive"], f.io)).toBe(0);
  expect(f.merged()).toBe(true);
  expect(f.out().trim().split("\n").at(-1)).toBe("Result: merged #9, Linear pending (armada merge --finish 9)");
  expect((await f.store.getRuntimeHandle("widgets", "DEMO-18"))?.releasedAt).not.toBeNull();
  f.linear.updateTicket = update;
  expect(await run(["merge", "--finish", "9"], f.io)).toBe(0);
  const writes = [...f.linear.writes];
  expect(await run(["merge", "--finish", "9"], f.io)).toBe(0);
  expect(f.linear.writes).toEqual(writes);
  expect(f.out().trim().split("\n").at(-1)).toBe("Result: merged #9");
  expect(f.out().split("Later:").at(-1)).not.toContain("No other worker is in flight.");
});

test.each(
  [
    ["merge", "9", "--dry-run"],
    ["merge", "9", "--no-ticket"],
    ["merge", "--finish", "9"],
    ["merge", "--bad-option"],
  ].map((argv) => ({ argv })),
)("every non-merge path has a final result: %j", async ({ argv }) => {
  const f = await fixture();
  await run(argv, f.io);
  expect(f.merged()).toBe(false);
  expect(f.out().trim().split("\n").at(-1)).toMatch(/^Result: not merged \(.+\)$/);
});

test.each(["checklist", "finish", "usage", "config"])(
  "merge --json remains one result object on %s failures",
  async (failure) => {
    const f = await fixture();
    let args = ["merge", "9", "--json"];
    if (failure === "checklist") f.pr.check.conclusion = "FAILURE";
    if (failure === "finish") args = ["merge", "--finish", "9", "--json"];
    if (failure === "usage") args = ["merge", "9", "--json", "--unknown-option"];
    if (failure === "config") f.io.readFile = async () => null;
    expect(await run(args, f.io)).not.toBe(0);
    const result = JSON.parse(f.out());
    expect(result.merged).toBe(false);
    expect(result.result).toStartWith("Result: not merged (");
  },
);

test.each([false, true])(
  "unknown native merge outcome never asserts nothing merged or archives (json=%s)",
  async (json) => {
    const f = await fixture();
    f.net.confirmMerge = false;
    expect(await run(["merge", "9", ...(json ? ["--json"] : [])], f.io)).toBe(1);
    expect(f.merged()).toBe(true);
    const result = json ? JSON.parse(f.out()).result : f.out().trim().split("\n").at(-1);
    expect(result).toContain("merge unconfirmed");
    expect(result).not.toContain("nothing was merged");
    expect(f.store.events.some((e) => e.kind === "merge")).toBe(false);
    expect((await f.store.getRuntimeHandle("widgets", "DEMO-18"))?.releasedAt).toBeNull();
  },
);

test("GitHub's confirmed merge at a different head is reported merged with pending bookkeeping", async () => {
  const f = await fixture();
  const exec = f.io.exec;
  f.io.exec = async (...args) => {
    if (!exec) throw new Error("fixture needs exec");
    const result = await exec(...args);
    if (f.merged()) f.pr.head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    return result;
  };
  expect(await run(["merge", "9", "--json"], f.io)).toBe(0);
  const result = JSON.parse(f.out());
  expect(result.merged).toBe(true);
  expect(result.result).toBe("Result: merged #9, Armada and Linear pending (armada merge --finish 9)");
  expect(f.err()).toContain("not at the handed-back");
  expect(f.store.events.some((e) => e.kind === "merge")).toBe(false);
  expect((await f.store.getRuntimeHandle("widgets", "DEMO-18"))?.releasedAt).toBeNull();
});

test.each([
  { linearPending: false, keepOpen: false },
  { linearPending: true, keepOpen: false },
  { linearPending: false, keepOpen: true },
  { linearPending: true, keepOpen: true },
])("confirmed merge preserves worker intent before deploy watchers (%j)", async ({ linearPending, keepOpen }) => {
  const f = await fixture();
  const update = f.linear.updateTicket.bind(f.linear);
  if (linearPending)
    f.linear.updateTicket = async () => {
      throw new Error("Linear unavailable");
    };
  const read = f.io.readFile;
  f.io.readFile = async (path) => {
    const contents = await read(path);
    return path.endsWith("armada.toml") && contents
      ? `${contents}\n[[deploy.target]]\nname = "api"\nbranch = "main"\nlive_sha_command = "version"\n`
      : contents;
  };
  let launched: string[] = [];
  let launches = 0;
  f.io.startBackground = async (args) => {
    launches++;
    expect(f.armada.calls.some((c) => c.path === "workers/end")).toBe(!keepOpen);
    launched = args;
    return true;
  };
  expect(await run(["merge", "9", ...(keepOpen ? ["--keep-open"] : [])], f.io), f.err()).toBe(0);
  expect(launched.slice(0, 6)).toEqual(["deploy", "watch", "--sha", SQUASH, "--target", "api"]);
  expect(f.out()).toContain(`Watching the deploy of ${SQUASH} to api`);
  if (linearPending) {
    expect(f.out().trim().split("\n").at(-1)).toBe("Result: merged #9, Linear pending (armada merge --finish 9)");
    f.linear.updateTicket = update;
    expect(await run(["merge", "--finish", "9"], f.io)).toBe(0);
    expect(await run(["merge", "--finish", "9"], f.io)).toBe(0);
  }
  expect(launches).toBe(1);
});
