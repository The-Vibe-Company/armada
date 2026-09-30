// armada merge on a throwaway repository: a local bare repository stands in
// for GitHub's git side (the test merge and the base-branch search run real
// git), a fake `gh` takes the merge, and fake APIs answer GitHub and Linear.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Fetch, GITHUB_GRAPHQL } from "@armada/core";
import { saveRuntimeHandle } from "../../core/src/turso.ts";
import {
  closeTempTurso,
  DEMO_TOML,
  FakeLinear,
  LABELS,
  NOW,
  recordedFetch,
  tempTurso,
} from "../../core/test/support.ts";
import { run } from "../src/cli.ts";
import type { Exec, Io } from "../src/io.ts";

const dirs: string[] = [];
afterEach(async () => {
  await closeTempTurso();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const SQUASH = "5555555555555555555555555555555555555555";
const BRANCH = "feature/demo-18-expire-idle-sessions";

async function fixture() {
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
  const exec: Exec = async (command, args, { cwd }) => {
    if (command === "gh") {
      ghCalls.push(args);
      merged = true;
      return { code: 0, stdout: "", stderr: "✓ Squashed and merged pull request #9\n" };
    }
    const r = spawnSync(command, args, { cwd, env, encoding: "utf8" });
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  };

  const linearProgram = recordedFetch().fetch;
  const fetch: Fetch = async (url, init) => {
    if (url === "https://api.github.com/repos/acme/widgets/pulls/9") return new Response(`${diff}\n`);
    if (url !== GITHUB_GRAPHQL) return linearProgram(url, init);
    const { query } = JSON.parse(String(init.body)) as { query: string };
    if (/query Compare/.test(query))
      return Response.json({
        data: {
          repository: {
            ref: { target: { oid: base }, compare: { status: "DIVERGED", aheadBy: 1, behindBy: 1 } },
          },
        },
      });
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
            mergeStateStatus: merged ? "UNKNOWN" : "CLEAN",
            headRefName: BRANCH,
            headRefOid: head,
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
                        nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
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

  const turso = await tempTurso();
  for (const [ticket, handle] of [
    ["DEMO-18", "ws-18"],
    ["DEMO-11", "ws-11"],
  ] as const)
    await saveRuntimeHandle(turso.db, {
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
    env: { LINEAR_API_KEY: "lin_test", GITHUB_TOKEN: "gh_test", ARMADA_TURSO_URL: turso.url },
    readFile: (path) => readFile(path, "utf8").catch(() => null),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ghToken: () => null,
    fetch,
    now: () => NOW,
    exec,
    sleep: async () => {},
    linearWriter: () => linear,
  };
  return { io, git, head, linear, ghCalls, out: () => out.join(""), err: () => err.join("") };
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
Merged #9 into main as ${SQUASH} (head ${f.head}).
DEMO-18: moved to Done, agent and ready labels removed, merged status posted.
https://github.com/acme/widgets/pull/9
https://linear.app/acme/issue/DEMO-18
Hints for you to judge (not blocking):
  - \`shareList\`, removed from src/lists.ts, still appears on main in src/share.ts
Tell these workers in flight what landed on main (rebase, shared files, new checks):
  DEMO-16  shipping  runtime unknown  Reset a forgotten password
  DEMO-11  implementing  Claude Code · ws-11  Send a sign-in link by email
No runtime guide is installed for Claude Code, so Armada has nothing to archive for DEMO-18 (Claude Code · ws-18): a local session or subagent ends with its task; stop it yourself if it still runs.
`);
  expect(f.err()).not.toContain("warning");
  expect(f.linear.get("DEMO-18").statusType).toBe("completed");
  // The throwaway worktree is gone.
  expect(f.git("worktree", "list").split("\n")).toHaveLength(1);
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
