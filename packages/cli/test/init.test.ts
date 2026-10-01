// armada doctor and armada init on a throwaway repository: a local bare
// repository stands in for GitHub's git side, a fake `gh` for its pull
// requests, and a fake Linear for the labels. Nothing leaves the machine.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import { ARMADA_URL, fakeArmada, fakeLinearLabels } from "../../core/test/support.ts";
import { version as VERSION } from "../package.json" with { type: "json" };
import { run } from "../src/cli.ts";
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
  state: "open" | "merged";
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
    if (a === "pr" && b === "list") {
      const open = prs.filter((p) => p.state === "open" && p.head === opt(args, "--head"));
      return ok(JSON.stringify(open.map((p) => ({ number: p.number, url: p.url }))));
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
  return { io, work, gh, linear, api, registry, armada, git, merge };
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
      head: `armada/init-${VERSION}`,
      base: "main",
      title: `chore(armada): set up Armada ${VERSION}`,
    });
    expect(first.out).toContain(`Opened pull request ${pr.url}\n`);
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
    expect(second.out).toContain(`armada/init-${VERSION} is already up to date.\n`);
    expect(second.out).toContain("Linear labels: all present\n");
    expect(f.gh.prs).toHaveLength(1);

    f.merge(pr);
    const after = await f.armada("doctor");
    expect(after.out).toContain('  ok       signed in to armada.example.test as the API key "coordinator" of Acme\n');
    expect(after.out).toEndWith("Everything Armada needs is in place.\n");
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
});
