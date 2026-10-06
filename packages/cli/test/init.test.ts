// armada doctor and armada init on a throwaway repository: a local bare
// repository stands in for GitHub's git side, a fake `gh` for its pull
// requests, and a fake Linear for the labels. Nothing leaves the machine.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configTemplate, GITHUB_GRAPHQL } from "@armada/core";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import { ARMADA_URL, fakeArmada, fakeLinearLabels, NOW, recordedFetch } from "../../core/test/support.ts";
import { version as VERSION } from "../package.json" with { type: "json" };
import { run } from "../src/cli.ts";
import { init } from "../src/init.ts";
import type { Exec, Io } from "../src/io.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface FakePr {
  number: number;
  url: string;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "open" | "merged" | "closed";
  comment?: string;
  isCrossRepository?: boolean;
}

/** The pull-request side of GitHub, as `gh` shows it. */
function fakeGh() {
  const prs: FakePr[] = [];
  const calls: string[][] = [];
  const opt = (args: string[], name: string) => args[args.indexOf(name) + 1] ?? "";
  const run = (args: string[]) => {
    calls.push(args);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    const [a, b] = args;
    if (a === "repo" && b === "view") return ok(JSON.stringify({ name: "widgets", nameWithOwner: "acme/widgets" }));
    if (a === "api") {
      return ok(
        JSON.stringify([
          prs
            .filter((p) => p.state === "open")
            .map((p) => ({
              number: p.number,
              html_url: p.url,
              head: { ref: p.head, repo: { full_name: p.isCrossRepository ? "other/widgets" : "acme/widgets" } },
            })),
        ]),
      );
    }
    if (a === "pr" && b === "close") {
      const pr = prs.find((p) => p.number === Number(args[2]));
      if (!pr) throw new Error("no such pull request");
      pr.state = "closed";
      pr.comment = opt(args, "--comment");
      return ok("");
    }
    if (a === "pr" && b === "list") {
      const open = prs.filter((p) => p.state === "open" && p.head === opt(args, "--head"));
      return ok(
        JSON.stringify(open.map((p) => ({ number: p.number, url: p.url, isCrossRepository: !!p.isCrossRepository }))),
      );
    }
    if (a === "pr" && b === "create") {
      const number = prs.length + 1;
      const url = `https://github.com/acme/widgets/pull/${number}`;
      prs.push({
        number,
        url,
        head: opt(args, "--head"),
        base: opt(args, "--base"),
        title: opt(args, "--title"),
        body: opt(args, "--body"),
        state: "open",
      });
      return ok(`${url}\n`);
    }
    if (a === "pr" && b === "edit") {
      const pr = prs.find((p) => p.number === Number(args[2]));
      if (!pr) return { code: 1, stdout: "", stderr: "no such pull request" };
      pr.title = opt(args, "--title");
      pr.body = opt(args, "--body");
      return ok("");
    }
    return { code: 1, stdout: "", stderr: `fake gh: unexpected ${args.join(" ")}` };
  };
  return { prs, calls, run };
}

/** A repository with one commit, pushed to a local bare `origin`, and a machine signed in to Armada with every key set. */
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "armada-init-test-")));
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
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(home, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  await mkdir(work);
  git(work, "init", "--quiet", "--initial-branch=main");
  git(work, "remote", "add", "origin", origin);
  await writeFile(join(work, "README.md"), "# Widgets\n");
  await writeFile(join(work, "bun.lock"), "{}\n");
  // Many repositories ignore .claude/; the setup pull request must still carry its links.
  await writeFile(join(work, ".gitignore"), ".claude/\n");
  git(work, "add", "--all");
  git(work, "commit", "--quiet", "--message", "chore: start");
  git(work, "push", "--quiet", "--set-upstream", "origin", "main");

  const gh = fakeGh();
  const linear = fakeLinearLabels();
  // The project registry is the fleet's, on Armada.
  const registry = memoryFleet();
  const api = fakeArmada({ keys: { armada_coordinator_key: "coordinator" }, store: registry });
  const exec: Exec = async (command, args, { cwd }) => {
    if (command === "gh") return gh.run(args);
    if (command === "python3")
      return {
        code: 0,
        stdout: args[0] === "--version" ? "Python 3.11.0" : "OCR 1.12.1 cached binary verified",
        stderr: "",
      };
    const r = spawnSync(command, args, { cwd, env, encoding: "utf8" });
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
  let out: string[] = [];
  let err: string[] = [];
  const io: Io = {
    cwd: work,
    env: {
      XDG_CONFIG_HOME: join(home, "config"),
      LINEAR_API_KEY: "lin_test",
      ARMADA_API_URL: ARMADA_URL,
      ARMADA_API_KEY: "armada_coordinator_key",
    },
    readFile: (path) => readFile(path, "utf8").catch(() => null),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ghToken: () => null,
    fetch: (url, init) => (url.startsWith(ARMADA_URL) ? api.fetch(url, init) : linear.fetch(url, init)),
    exec,
  };
  /** Runs one command and returns its exit code with everything it printed. */
  const armada = async (...argv: string[]) => {
    out = [];
    err = [];
    const code = await run(argv, io);
    return { code, out: out.join(""), err: err.join("") };
  };
  /** Merges the setup pull request on origin, as GitHub would, and updates the working tree. */
  const merge = (pr: FakePr) => {
    git(work, "fetch", "--quiet", "origin");
    git(work, "merge", "--quiet", "--ff-only", `origin/${pr.head}`);
    git(work, "push", "--quiet", "origin", "main");
    pr.state = "merged";
  };
  const initAt = async (armadaVersion: string, programRoot: string | null = "DEMO-1") => {
    out = [];
    err = [];
    const code = await init(io, { armadaVersion, programRoot, name: null, slug: null, stopHook: false });
    return { code, out: out.join(""), err: err.join("") };
  };
  return { io, work, gh, linear, api, registry, armada, initAt, git, merge };
}

/** Exercise the real merge flow with GitHub reads and the pinned merge faked. */
function enableMerge(f: Awaited<ReturnType<typeof fixture>>) {
  const exec = f.io.exec as Exec;
  const fetch = f.io.fetch;
  const program = recordedFetch();
  const state = { pending: true, merged: false, waits: 0, mergeCalls: [] as string[][] };
  f.io.ghToken = () => "gh_test";
  f.io.now = () => new Date(NOW);
  f.io.sleep = async () => {
    state.waits++;
    state.pending = false;
  };
  f.io.exec = async (command, args, opts) => {
    const pr = f.gh.prs.find((p) => p.head === "armada/setup" && !p.isCrossRepository) as FakePr;
    if (command === "gh" && args[0] === "pr" && args[1] === "diff")
      return { code: 0, stdout: f.git(f.work, "diff", "--name-only", "origin/main...origin/armada/setup"), stderr: "" };
    if (command === "gh" && args[0] === "pr" && args[1] === "merge") {
      state.mergeCalls.push(args);
      expect(args).toContain("--match-head-commit");
      expect(args.at(-1)).toBe(f.git(f.work, "rev-parse", "origin/armada/setup"));
      f.merge(pr);
      state.merged = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "git" && args[0] === "fetch" && args.some((a) => a.startsWith("refs/pull/"))) {
      f.git(f.work, "fetch", "--quiet", "origin");
      f.git(f.work, "push", "--quiet", "origin", `origin/armada/setup:refs/pull/${pr.number}/head`);
    }
    return exec(command, args, opts);
  };
  f.io.fetch = async (url, init) => {
    const pr = f.gh.prs.find((p) => p.head === "armada/setup" && !p.isCrossRepository) as FakePr;
    if (url === GITHUB_GRAPHQL) {
      const { query } = JSON.parse(String(init.body)) as { query: string };
      const head = f.git(f.work, "rev-parse", "origin/armada/setup");
      const base = f.git(f.work, "rev-parse", "origin/main");
      if (/query Compare/.test(query))
        return Response.json({
          data: {
            repository: {
              ref: {
                target: { oid: base },
                compare: { status: head === base ? "IDENTICAL" : "AHEAD", aheadBy: head === base ? 0 : 1, behindBy: 0 },
              },
            },
          },
        });
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              number: pr.number,
              title: pr.title,
              url: pr.url,
              state: state.merged ? "MERGED" : "OPEN",
              isDraft: false,
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              headRefName: pr.head,
              headRefOid: head,
              baseRefName: pr.base,
              createdAt: NOW,
              updatedAt: NOW,
              mergedAt: state.merged ? NOW : null,
              mergeCommit: state.merged ? { oid: head } : null,
              reviewThreads: { totalCount: 0, nodes: [] },
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        state: state.pending ? "PENDING" : "SUCCESS",
                        contexts: {
                          nodes: [
                            {
                              __typename: "CheckRun",
                              name: "test",
                              status: state.pending ? "IN_PROGRESS" : "COMPLETED",
                              conclusion: state.pending ? null : "SUCCESS",
                            },
                          ],
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
    }
    if (url.startsWith("https://api.github.com/repos/"))
      return new Response(f.git(f.work, "diff", "origin/main...origin/armada/setup"));
    if (
      String(init.body).includes("query Labels") ||
      String(init.body).includes("mutation CreateLabel") ||
      url.startsWith(ARMADA_URL)
    )
      return (fetch as NonNullable<Io["fetch"]>)(url, init);
    return program.fetch(url, init);
  };
  return state;
}

describe("armada doctor and armada init", () => {
  test("init refuses without a sign-in to Armada, before it pushes, opens or creates anything", async () => {
    const f = await fixture();
    delete f.io.env.ARMADA_API_KEY;
    const refused = await f.armada("init", "--program-root", "DEMO-1");
    expect(refused.code).toBe(2);
    expect(refused.err).toBe(
      "armada: not signed in to Armada (armada.example.test). A person signs in with `armada login`; a headless coordinator sets ARMADA_API_KEY to an organization API key\nNext: armada login\n",
    );
    expect(f.gh.calls).toEqual([]);
    expect(f.linear.created).toEqual([]);
    expect(f.api.calls).toEqual([]);
    expect(await f.registry.listProjects()).toEqual([]);
    expect(f.git(f.work, "ls-remote", "--heads", "origin").split("\n")).toHaveLength(1);
  });

  test("init replaces legacy PRs once and reuses armada/setup across versions", async () => {
    const f = await fixture();
    for (const [number, head] of [
      [41, "armada/init-0.2.58"],
      [42, "armada/init-0.2.57"],
      [43, "feature/demo-3-widget"],
    ] as const)
      f.gh.prs.push({
        number,
        head,
        url: `https://github.com/acme/widgets/pull/${number}`,
        base: "main",
        title: "chore: old setup",
        body: "",
        state: "open",
      });
    const fork: FakePr = {
      number: 44,
      head: "armada/setup",
      base: "main",
      title: "chore: fork setup",
      body: "fork",
      url: "https://github.com/acme/widgets/pull/44",
      state: "open",
      isCrossRepository: true,
    };
    f.gh.prs.unshift(fork);
    f.git(f.work, "switch", "--quiet", "--create", "armada/init-0.2.58");
    await writeFile(
      join(f.work, "armada.toml"),
      configTemplate({ name: "Existing Widgets", slug: "widgets", programRoot: "DEMO-1", repository: "acme/widgets" }),
    );
    f.git(f.work, "add", "armada.toml");
    f.git(f.work, "commit", "--quiet", "--message", "chore: legacy setup");
    f.git(f.work, "push", "--quiet", "origin", "armada/init-0.2.58");
    f.git(f.work, "switch", "--quiet", "main");
    const replacement = await f.initAt("0.2.60", null);
    expect(replacement.out).toContain("Using armada.toml from armada/init-0.2.58");
    const stable = f.gh.prs.find((p) => p.head === "armada/setup" && !p.isCrossRepository) as FakePr;
    expect(stable).toMatchObject({ state: "open", title: "chore(armada): set up Armada 0.2.60" });
    expect(f.gh.prs.filter((p) => p.head.startsWith("armada/init-")).map((p) => [p.state, p.comment])).toEqual([
      ["closed", `Superseded by ${stable.url} on armada/setup. Armada updates that pull request across versions.`],
      ["closed", `Superseded by ${stable.url} on armada/setup. Armada updates that pull request across versions.`],
    ]);
    expect(f.gh.prs.find((p) => p.number === 43)?.state).toBe("open");
    const firstHead = f.git(f.work, "ls-remote", "origin", "refs/heads/armada/setup");
    await f.initAt("0.2.61");
    expect(f.gh.prs.filter((p) => p.head === "armada/setup" && !p.isCrossRepository)).toEqual([stable]);
    expect(stable.title).toBe("chore(armada): set up Armada 0.2.61");
    expect(fork).toMatchObject({ state: "open", title: "chore: fork setup", body: "fork" });
    expect(f.git(f.work, "ls-remote", "origin", "refs/heads/armada/setup")).not.toBe(firstHead);
    expect(f.gh.calls.filter((c) => c[0] === "pr" && c[1] === "create")).toHaveLength(1);
    expect(f.gh.calls.filter((c) => c[0] === "pr" && c[1] === "close")).toHaveLength(2);
  });

  test.each(["src/app.ts", ".agents/skills-extra/SKILL.md", ".claude/settings.local.json", ".conductor/other.toml"])(
    "init --merge refuses a diff outside setup paths (%s)",
    async (path) => {
      const f = await fixture();
      const exec = f.io.exec as Exec;
      f.io.exec = async (command, args, opts) =>
        command === "gh" && args[0] === "pr" && args[1] === "diff"
          ? { code: 0, stdout: `${path}\n`, stderr: "" }
          : exec(command, args, opts);
      const result = await f.armada("init", "--program-root", "DEMO-1", "--merge");
      expect(result.code).toBe(2);
      expect(result.err).toContain(`init --merge refuses paths outside Armada setup: ${path}`);
      expect(f.gh.calls.some((args) => args[0] === "pr" && args[1] === "merge")).toBe(false);
    },
  );

  test("init --merge waits for checks, permits the first armada.toml and merges the pinned setup head", async () => {
    const f = await fixture();
    const state = enableMerge(f);
    const result = await f.armada("init", "--program-root", "DEMO-1", "--merge");
    expect(result.err).toContain('check "test" is pending');
    expect(result.code).toBe(0);
    expect(state.waits).toBeGreaterThan(0);
    expect(state.mergeCalls).toHaveLength(1);
    expect(result.out).toContain("No ticket: nothing was written to Linear.");
    expect(f.gh.prs[0]?.state).toBe("merged");
  });

  test("init --merge refuses a setup PR retargeted while checks run", async () => {
    const f = await fixture();
    const state = enableMerge(f);
    f.io.sleep = async () => {
      state.waits++;
      state.pending = false;
      (f.gh.prs.find((p) => p.head === "armada/setup") as FakePr).base = "release";
    };
    const result = await f.armada("init", "--program-root", "DEMO-1", "--merge");
    expect(result.code).toBe(2);
    expect(result.err).toContain("init --merge requires armada/setup targeting main");
    expect(state.mergeCalls).toEqual([]);
    expect(f.registry.leases.size).toBe(0);
  });

  test("an empty init plan leaves a manually edited stale setup PR unmerged", async () => {
    const f = await fixture();
    await f.armada("init", "--program-root", "DEMO-1");
    f.merge(f.gh.prs[0] as FakePr);
    f.git(f.work, "switch", "--quiet", "--create", "armada/setup");
    await writeFile(join(f.work, ".conductor/settings.toml"), '[scripts]\nsetup = "echo manual setup change"\n');
    f.git(f.work, "commit", "--quiet", "--all", "--message", "chore: manual setup edit");
    f.git(f.work, "push", "--quiet", "origin", "armada/setup");
    f.git(f.work, "switch", "--quiet", "main");
    const stale: FakePr = {
      number: 2,
      head: "armada/setup",
      base: "main",
      title: "chore: manual setup change",
      body: "",
      url: "https://github.com/acme/widgets/pull/2",
      state: "open",
    };
    f.gh.prs.push(stale);
    const result = await f.armada("init", "--merge");
    expect(result.code).toBe(0);
    expect(result.out).toContain("main already has everything Armada needs; no pull request to open.");
    expect(stale.state).toBe("open");
    expect(f.gh.calls.some((args) => args[0] === "pr" && ["diff", "merge"].includes(args[1] ?? ""))).toBe(false);
  });

  test("init --merge checks both sides of a rename on the exact merge head and gives the lock back on refusal", async () => {
    const f = await fixture();
    const state = enableMerge(f);
    const exec = f.io.exec as Exec;
    f.io.exec = async (command, args, opts) => {
      if (command === "gh" && args[0] === "pr" && args[1] === "diff")
        return { code: 0, stdout: ".agents/skills/notes.md\n", stderr: "" };
      const result = await exec(command, args, opts);
      if (command === "git" && args[0] === "commit") {
        f.git(opts.cwd, "mv", "README.md", ".agents/skills/notes.md");
        f.git(opts.cwd, "commit", "--quiet", "--amend", "--no-edit");
      }
      return result;
    };
    const result = await f.armada("init", "--program-root", "DEMO-1", "--merge");
    expect(result.code).toBe(2);
    expect(result.err).toContain("init --merge refuses paths outside Armada setup: README.md");
    expect(state.mergeCalls).toEqual([]);
    expect(f.registry.leases.size).toBe(0);
  });

  test("init --merge refuses armada.toml once the project is set up", async () => {
    const f = await fixture();
    await f.armada("init", "--program-root", "DEMO-1");
    f.merge(f.gh.prs[0] as FakePr);
    await writeFile(join(f.work, ".agents/skills/armada-worker/SKILL.md"), "an older skill\n");
    f.git(f.work, "commit", "--quiet", "--all", "--message", "chore: old skill");
    f.git(f.work, "push", "--quiet", "origin", "main");
    const exec = f.io.exec as Exec;
    f.io.exec = async (command, args, opts) =>
      command === "gh" && args[0] === "pr" && args[1] === "diff"
        ? { code: 0, stdout: "armada.toml\n", stderr: "" }
        : exec(command, args, opts);
    const result = await f.armada("init", "--merge");
    expect(result.code).toBe(2);
    expect(result.err).toContain("init --merge refuses paths outside Armada setup: armada.toml");
  });

  test("init opens one pull request that makes doctor pass once merged, and running it again updates it", async () => {
    const f = await fixture();

    const before = await f.armada("doctor");
    expect(before.code).toBe(1);
    expect(before.out).toEndWith("Next: armada init, which opens one pull request with the fixes it can make\n");
    expect(before.out).toContain("  error    armada.toml is missing\n");
    expect(before.out).toContain(
      "  error    skill armada-worker is missing from .agents/skills\n           fix: run `armada init`\n",
    );
    expect(before.out).toContain("  error    .conductor/settings.toml is missing\n");

    const noRoot = await f.armada("init");
    expect(noRoot.code).toBe(2);
    expect(noRoot.err).toEndWith("Next: armada init --program-root <ISSUE-ID>\n");
    expect(f.gh.prs).toEqual([]);

    const first = await f.armada("init", "--program-root", "DEMO-1");
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    expect(f.gh.prs).toHaveLength(1);
    const pr = f.gh.prs[0] as FakePr;
    expect(pr).toMatchObject({
      head: "armada/setup",
      base: "main",
      title: `chore(armada): set up Armada ${VERSION}`,
    });
    expect(first.out).toContain(
      `Opened pull request ${pr.url}\nNo ticket owns it: merge it with armada merge ${pr.number} --no-ticket --wait, which waits for its checks\n`,
    );
    // Without a terminal to ask, the stop hook is added, to the repository's settings only.
    expect(first.out).toContain(
      "Adds the Claude Code stop hook to .claude/settings.json: this repository's settings, not your user settings.\n",
    );
    expect(pr.body).toContain("`ARMADA_STOP_HOOK=off` turns it off");
    expect(f.linear.labels.filter((l) => l.isGroup).map((l) => l.name)).toEqual(["Agent phase", "Agent runtime"]);
    expect(first.out).toContain("Registered project widgets on Armada; armada status --all lists it.\n");
    expect(await f.registry.listProjects()).toMatchObject([
      { slug: "widgets", name: "widgets", repository: "acme/widgets", programRoot: "DEMO-1" },
    ]);
    // The person's checkout is left alone: everything happened on the branch.
    expect(f.git(f.work, "status", "--porcelain")).toBe("");
    expect(f.git(f.work, "worktree", "list").split("\n")).toHaveLength(1);

    const second = await f.armada("init");
    expect(second.code).toBe(0);
    expect(second.out).toContain(`Updated pull request ${pr.url}\n`);
    expect(second.out).toContain("armada/setup is already up to date.\n");
    expect(second.out).toContain("Linear labels: all present\n");
    expect(f.gh.prs).toHaveLength(1);

    f.merge(pr);
    const after = await f.armada("doctor");
    expect(after.out).toContain('  ok       signed in to armada.example.test as the API key "coordinator" of Acme\n');
    expect(after.out).toContain("  ok       .claude/settings.json has Armada's stop hook");
    expect(after.out).toContain("GitHub branch rules not checked: no GitHub token");
    expect(after.out).toEndWith("0 errors, 1 warning.\n");
    expect(after.code).toBe(0);

    const third = await f.armada("init");
    expect(third.code).toBe(0);
    expect(third.out).toContain("main already has everything Armada needs; no pull request to open.\n");
    expect(f.gh.prs).toHaveLength(1);
  });

  test("an outdated skill is a doctor warning, and init opens a pull request that updates it", async () => {
    const f = await fixture();
    await f.armada("init", "--program-root", "DEMO-1");
    f.merge(f.gh.prs[0] as FakePr);
    await writeFile(join(f.work, ".agents/skills/armada-worker/SKILL.md"), "an older worker skill\n");
    f.git(f.work, "commit", "--quiet", "--all", "--message", "chore: an older skill");
    f.git(f.work, "push", "--quiet", "origin", "main");

    const doctor = await f.armada("doctor");
    expect(doctor.code).toBe(0);
    expect(doctor.out).toContain(
      `  warning  skill armada-worker differs from the version in Armada ${VERSION}\n           fix: run \`armada init\` to open a pull request that updates it\n`,
    );

    const update = await f.armada("init");
    expect(update.code).toBe(0);
    expect(f.gh.prs).toHaveLength(2);
    expect(f.gh.prs[1]).toMatchObject({ title: `chore(armada): update the Armada setup to ${VERSION}`, state: "open" });
    expect(update.out).toContain("Updates: armada-worker\n");
  });

  test("init asks before adding the stop hook; a no leaves it out and doctor says what it is for", async () => {
    const f = await fixture();
    const asked: string[] = [];
    let answer = "n";
    f.io.interactive = true;
    f.io.prompt = async (question) => {
      asked.push(question);
      return question.startsWith("Add the Claude Code stop hook") ? answer : "";
    };
    const declined = await f.armada("init", "--program-root", "DEMO-1");
    expect(declined.code).toBe(0);
    expect(asked.filter((q) => q.includes("stop hook"))).toEqual([
      "Add the Claude Code stop hook to this repository's .claude/settings.json? A coordinator then cannot end its turn while workers are in flight and no armada watch runs; your user settings are not touched. [Y/n] ",
    ]);
    expect(declined.out).not.toContain("stop hook");
    const pr = f.gh.prs[0] as FakePr;
    f.merge(pr);
    const doctor = await f.armada("doctor");
    expect(doctor.code).toBe(0);
    expect(doctor.out).toContain(
      "  warning  .claude/settings.json has no Armada stop hook, so a Claude Code coordinator can stop watching its fleet without noticing\n",
    );

    // --no-stop-hook does not ask; an empty answer is the default, yes.
    asked.length = 0;
    expect((await f.armada("init", "--no-stop-hook")).out).toContain("no pull request to open");
    expect(asked.filter((q) => q.includes("stop hook"))).toEqual([]);
    answer = "";
    const accepted = await f.armada("init");
    expect(accepted.out).toContain("Adds the Claude Code stop hook to .claude/settings.json");
  });
});
