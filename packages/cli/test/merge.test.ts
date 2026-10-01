// armada merge on a throwaway repository: a local bare repository stands in
// for GitHub's git side (the test merge and the base-branch search run real
// git), a fake `gh` takes the merge, and fake APIs answer GitHub and Linear.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Fetch, GITHUB_GRAPHQL } from "@armada/core";
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
import { run } from "../src/cli.ts";
import type { Exec, Io } from "../src/io.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const SQUASH = "5555555555555555555555555555555555555555";
const BRANCH = "feature/demo-18-expire-idle-sessions";
const KEY = "armada_key_CANARY_coordinator";

/** A coordinator's terminal, signed in to the fake Armada with an organization API key unless `signedIn` is false. */
async function fixture({ signedIn = true }: { signedIn?: boolean } = {}) {
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
    `${DEMO_TOML}\n[gates]\nrequired_checks = ["test"]\nlocal_commands = ["test -f src/share.ts", "grep -q shareListByLink src/lists.ts"]\n`,
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

  const linearProgram = recordedFetch().fetch;
  const store = memoryFleet();
  const armada = fakeArmada({ keys: { [KEY]: "coordinator" }, store });
  const net = { armadaDown: false };
  const fetch: Fetch = async (url, init) => {
    if (url.startsWith(`${ARMADA_URL}/`)) {
      if (net.armadaDown) throw new TypeError("fetch failed");
      return armada.fetch(url, init);
    }
    if (url === "https://api.github.com/repos/acme/widgets/pulls/9") return new Response(`${diff}\n`);
    if (url !== GITHUB_GRAPHQL) return linearProgram(url, init);
    const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, string> };
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
            number: 9,
            title: "feat(lists): share a list by link",
            url: "https://github.com/acme/widgets/pull/9",
            state: merged ? "MERGED" : "OPEN",
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: merged ? "UNKNOWN" : pr.state,
            headRefName: BRANCH,
            headRefOid: pr.head,
            baseRefName: "main",
            createdAt: "2026-03-04T08:00:00Z",
            updatedAt: "2026-03-04T09:00:00Z",
            mergedAt: merged ? "2026-03-04T10:00:00Z" : null,
            mergeCommit: merged ? { oid: SQUASH } : null,
            reviewThreads: { totalCount: 1, nodes: [{ isResolved: true }] },
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
    merged: () => merged,
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

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
Tell these workers in flight what landed on main (bring it in, shared files, new checks):
  DEMO-16  shipping  runtime unknown  Reset a forgotten password
  DEMO-11  implementing  Claude Code · ws-11  Send a sign-in link by email
No runtime guide is installed for Claude Code, so Armada has nothing to archive for DEMO-18 (Claude Code · ws-18): a local session or subagent ends with its task; stop it yourself if it still runs.
2 workers in flight (DEMO-11, DEMO-16) — keep watching: armada watch
`);
  expect(f.err()).not.toContain("warning");
  expect(f.linear.get("DEMO-18").statusType).toBe("completed");
  // The throwaway worktree is gone.
  expect(f.git("worktree", "list").split("\n")).toHaveLength(1);
  // Under the merge lock on Armada, given back afterwards; the merge recorded and the worker's session ended.
  expect(f.armada.calls.map((c) => c.path)).toEqual([
    "fleet/coordinator",
    "fleet/lease/acquire",
    "fleet/validations",
    "fleet/lease/renew",
    "fleet/merge",
    "fleet/lease/release",
    "workers/end",
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
    "armada: warning: merged without the merge lock (--no-lock): make sure no other coordinator merges in widgets now\n",
  );
  expect(f.err()).toMatch(/armada: warning: Armada: could not record the merge \(.+\); Linear is up to date\n/);
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
