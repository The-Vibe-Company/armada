// `armada init`: opens one pull request that gives a repository everything
// `armada doctor` checks, creates the missing tracker labels and registers the
// project on Armada (the sign-in's organization). The files are built on a fresh checkout of the default branch, in a
// temporary worktree, so the person's own checkout is never touched. Running it
// again rebuilds the same branch and updates the same pull request.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArmadaConfig,
  CLAUDE_SETTINGS,
  CONFIG_FILE,
  ConfigError,
  compareVersions,
  configTemplate,
  createMissingLabels,
  LINEAR_KEY,
  parseConfig,
  planIsEmpty,
  planSetup,
  readLabels,
  SETUP_PATHS,
  type SetupPlan,
  slugify,
} from "@armada/core";
import { authLogin, loadCredentials } from "./auth.ts";
import { type Exec, httpOptions, type Io, missingKey, UsageError } from "./io.ts";
import { requireSignIn } from "./login.ts";
import { merge } from "./merge.ts";
import { applyPlan, CommandError, fsRepoView, gitRoot, requireExec, sh } from "./repo.ts";
import { liveFleet } from "./worker.ts";

export interface InitOptions {
  armadaVersion: string;
  /** For a repository without armada.toml. */
  programRoot: string | null;
  name: string | null;
  slug: string | null;
  /** Add the Claude Code stop hook: null asks on a terminal, and says yes without one. */
  stopHook: boolean | null;
  /** Wait for the usual merge checks and merge only Armada setup paths. */
  merge?: boolean;
}

const STOP_HOOK_QUESTION =
  "Add the Claude Code stop hook to this repository's .claude/settings.json? A coordinator then cannot end its turn while workers are in flight and no armada watch runs; your user settings are not touched. [Y/n] ";

/** Whether to add the stop hook: the option, else the person's answer, else yes. */
async function wantsStopHook(io: Io, opts: InitOptions): Promise<boolean> {
  if (opts.stopHook !== null) return opts.stopHook;
  if (!io.interactive || !io.prompt) return true;
  const answer = (await io.prompt(STOP_HOOK_QUESTION, { hidden: false }))?.trim().toLowerCase();
  return answer === undefined ? false : answer === "" || answer.startsWith("y");
}

export const initBranch = () => "armada/setup";

/** No wildcard support in gh pr list --head: paginate open PRs and filter their heads. */
async function closeLegacyPulls(exec: Exec, root: string, repo: string, replacement: string): Promise<void> {
  const pages = JSON.parse(
    await sh(exec, root, "gh", ["api", `repos/${repo}/pulls?state=open&per_page=100`, "--paginate", "--slurp"]),
  ) as { number: number; head: { ref: string; repo: { full_name: string } | null } }[][];
  for (const pr of pages.flat()) {
    if (!pr.head.ref.startsWith("armada/init-") || pr.head.repo?.full_name.toLowerCase() !== repo.toLowerCase())
      continue;
    await sh(exec, root, "gh", [
      "pr",
      "close",
      String(pr.number),
      "--repo",
      repo,
      "--comment",
      `Superseded by ${replacement} on armada/setup. Armada updates that pull request across versions.`,
    ]);
  }
}

function assertSetupPaths(paths: string[], firstSetup: boolean): void {
  const outside = paths.filter((path) => {
    if (!path || path.split("/").some((part) => part === "." || part === "..") || path.includes("\\")) return true;
    if (path === CONFIG_FILE) return !firstSetup;
    return !SETUP_PATHS.some((pattern) =>
      pattern.endsWith("/**")
        ? path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2))
        : path === pattern,
    );
  });
  if (outside.length)
    throw new UsageError(
      `init --merge refuses paths outside Armada setup: ${outside.join(", ")}`,
      "review this pull request and merge it yourself",
    );
}

/** The default branch of `origin`, read from the remote itself. */
async function defaultBranch(exec: Exec, root: string): Promise<string> {
  const out = await sh(exec, root, "git", ["ls-remote", "--symref", "origin", "HEAD"]);
  const m = out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
  if (!m?.[1]) throw new CommandError("could not read the default branch of origin");
  return m[1];
}

/** armada.toml for the pull request: the default branch's, else the working tree's, else a new one. */
async function resolveConfig(
  exec: Exec,
  root: string,
  checkout: string,
  opts: InitOptions,
): Promise<{ config: ArmadaConfig; text: string | null; source: string }> {
  const parse = (text: string, where: string) => {
    try {
      return parseConfig(text, where);
    } catch (err) {
      if (err instanceof ConfigError) throw new UsageError(err.message, "armada init again once the file is fixed");
      throw err;
    }
  };
  const onDefault = await fsRepoView(checkout).readFile(CONFIG_FILE);
  if (onDefault !== null)
    return { config: parse(onDefault, `${CONFIG_FILE} on the default branch`), text: null, source: "default branch" };
  const local = await fsRepoView(root).readFile(CONFIG_FILE);
  if (local !== null && !opts.programRoot)
    return { config: parse(local, join(root, CONFIG_FILE)), text: local, source: "working tree" };
  // A previous run's pull request, not merged yet: keep the file it proposes.
  if (!opts.programRoot) {
    const refs = await sh(exec, root, "git", ["ls-remote", "origin", "refs/heads/armada/init-*"]);
    const legacy = refs
      .split("\n")
      .flatMap((line) => {
        const branch = line.split("\t")[1]?.replace(/^refs\/heads\//, "");
        return branch ? [branch] : [];
      })
      .sort((a, b) => compareVersions(b.slice("armada/init-".length), a.slice("armada/init-".length)));
    for (const branch of [initBranch(), ...legacy]) {
      if (!(await sh(exec, root, "git", ["ls-remote", "origin", `refs/heads/${branch}`]))) continue;
      await sh(exec, root, "git", ["fetch", "--quiet", "origin", branch]);
      const shown = await exec("git", ["show", `FETCH_HEAD:${CONFIG_FILE}`], { cwd: root });
      if (shown.code === 0)
        return { config: parse(shown.stdout, `${CONFIG_FILE} on ${branch}`), text: shown.stdout, source: branch };
    }
  }
  if (!opts.programRoot)
    throw new UsageError(
      `${CONFIG_FILE} is missing, and armada init needs the Linear issue at the root of the program to write one`,
      "armada init --program-root <ISSUE-ID>",
    );
  const repo = JSON.parse(await sh(exec, root, "gh", ["repo", "view", "--json", "name,nameWithOwner"])) as {
    name: string;
    nameWithOwner: string;
  };
  const name = opts.name ?? repo.name;
  const text = configTemplate({
    name,
    slug: opts.slug ?? slugify(name),
    programRoot: opts.programRoot,
    repository: repo.nameWithOwner,
  });
  return { config: parse(text, `the new ${CONFIG_FILE}`), text, source: "new" };
}

/** True when origin's `branch` is one commit on `baseSha` with the same files as HEAD. */
async function branchIsCurrent(exec: Exec, checkout: string, branch: string, baseSha: string): Promise<boolean> {
  if (!(await sh(exec, checkout, "git", ["ls-remote", "origin", `refs/heads/${branch}`]))) return false;
  await sh(exec, checkout, "git", ["fetch", "--quiet", "origin", branch]);
  const [remoteTree, remoteParent, tree] = await Promise.all([
    sh(exec, checkout, "git", ["rev-parse", "FETCH_HEAD^{tree}"]),
    sh(exec, checkout, "git", ["rev-parse", "FETCH_HEAD^"]),
    sh(exec, checkout, "git", ["rev-parse", "HEAD^{tree}"]),
  ]);
  return remoteTree === tree && remoteParent === baseSha;
}

function prText(plan: SetupPlan, version: string) {
  const title = plan.installed.length
    ? `chore(armada): set up Armada ${version}`
    : `chore(armada): update the Armada setup to ${version}`;
  const lines = [
    `Adds what \`armada doctor\` checks, so Armada ${version} can run agents on this repository.`,
    "",
    ...plan.writes.map((w) => `- write \`${w.path}\``),
    ...plan.links.map((l) => `- link \`${l.path}\` → \`${l.target}\``),
    ...plan.removes.map((p) => `- remove \`${p}\``),
    ...(plan.stopHook
      ? [
          "",
          `The Claude Code stop hook in \`${CLAUDE_SETTINGS}\` keeps a coordinator from ending its turn while workers are in flight and no \`armada watch\` runs. It blocks only in the checkout where \`armada watch\` ran, never a worker's session, and \`ARMADA_STOP_HOOK=off\` turns it off.`,
        ]
      : []),
    "",
    "Once merged, `armada doctor` passes on the default branch.",
    "",
    "Opened by `armada init`. Running it again rebuilds this branch from the default branch and updates this pull request, so commits pushed here by hand are replaced.",
  ];
  return { title, body: lines.join("\n") };
}

/** No ticket owns the setup pull request, so the coordinator merges it with --no-ticket. */
const mergeHint = (n: number) =>
  `No ticket owns it: merge it with armada merge ${n} --no-ticket --wait, which waits for its checks`;

export async function init(io: Io, opts: InitOptions): Promise<number> {
  const exec = requireExec(io);
  const first = (await loadCredentials(io)).credentials;
  // The project is registered on Armada, for the organization this terminal signs in to.
  requireSignIn(first);
  // Ask for missing keys on a terminal. Without one, go on when the Linear key is set.
  if (io.interactive || !first.linearApiKey) {
    const login = await authLogin(io);
    if (login !== 0) return login;
  }
  const { credentials } = await loadCredentials(io);
  if (!credentials.linearApiKey) throw missingKey(LINEAR_KEY);
  const linearApiKey = credentials.linearApiKey;

  const root = await gitRoot(exec, io.cwd);
  if (!root)
    throw new UsageError(
      `${io.cwd} is not inside a git repository`,
      "armada init again from the checkout of the repository to set up",
    );
  const base = await defaultBranch(exec, root);
  await sh(exec, root, "git", ["fetch", "--quiet", "origin", base]);
  const baseSha = await sh(exec, root, "git", ["rev-parse", "FETCH_HEAD"]);
  const checkout = await realpath(await mkdtemp(join(tmpdir(), "armada-init-")));
  try {
    await sh(exec, root, "git", ["worktree", "add", "--quiet", "--detach", checkout, baseSha]);
    const { config, text, source } = await resolveConfig(exec, root, checkout, opts);
    const view = fsRepoView(checkout);
    const firstSetup = (await view.readFile(CONFIG_FILE)) === null;
    let plan = await planSetup(view, {
      armadaVersion: opts.armadaVersion,
      configText: text,
      stopHook: opts.stopHook !== false,
    });
    // Asked only when the hook is missing: a declined hook is left out of this pull request.
    if (plan.stopHook && !(await wantsStopHook(io, opts)))
      plan = await planSetup(view, { armadaVersion: opts.armadaVersion, configText: text, stopHook: false });
    const log = (line: string) => io.stdout(`${line}\n`);
    log(`Armada ${opts.armadaVersion} · ${config.github.repository} · ${config.tracker.programRoot}`);
    if (source !== "default branch" && source !== "new")
      log(
        `Using ${CONFIG_FILE} from ${source === "working tree" ? "the working tree" : source}; the pull request adds it.`,
      );

    // 1. Tracker labels.
    const linear = { apiKey: linearApiKey, ...httpOptions(io) };
    const created = await createMissingLabels(await readLabels(config, linear), linear);
    log(created.length ? `Created Linear labels: ${created.join(", ")}` : "Linear labels: all present");

    // 2. The pull request.
    const branch = initBranch();
    const repo = config.github.repository;
    let pull: { number: number; url: string } | undefined;
    if (planIsEmpty(plan)) {
      log(`${base} already has everything Armada needs; no pull request to open.`);
    } else {
      const open = JSON.parse(
        (await sh(exec, root, "gh", [
          "pr",
          "list",
          "--repo",
          repo,
          "--head",
          branch,
          "--state",
          "open",
          "--json",
          "number,url,isCrossRepository",
        ])) || "[]",
      ) as { number: number; url: string; isCrossRepository: boolean }[];
      const existing = open.find((pull) => !pull.isCrossRepository);
      await applyPlan(checkout, plan);
      // Exactly the planned paths, even where the repository's .gitignore covers them (.claude/ often is).
      const paths = [...plan.writes.map((w) => w.path), ...plan.links.map((l) => l.path), ...plan.removes];
      await sh(exec, checkout, "git", ["add", "--all", "--force", "--", ...paths]);
      const { title, body } = prText(plan, opts.armadaVersion);
      // No hooks: they belong to the project's own commits; the pull request's CI checks these files.
      await sh(exec, checkout, "git", ["commit", "--quiet", "--no-verify", "--message", title]);
      // Only push when content changed, so a rerun does not restart CI for nothing.
      if (await branchIsCurrent(exec, checkout, branch, baseSha)) log(`${branch} is already up to date.`);
      else await sh(exec, checkout, "git", ["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${branch}`]);
      if (existing) {
        await sh(exec, root, "gh", [
          "pr",
          "edit",
          String(existing.number),
          "--repo",
          repo,
          "--title",
          title,
          "--body",
          body,
        ]);
        log(`Updated pull request ${existing.url}`);
        pull = existing;
      } else {
        const url = await sh(exec, root, "gh", [
          "pr",
          "create",
          "--repo",
          repo,
          "--base",
          base,
          "--head",
          branch,
          "--title",
          title,
          "--body",
          body,
        ]);
        const opened = url.split("\n").pop() ?? "";
        log(`Opened pull request ${opened}`);
        const number = opened.match(/\/pull\/(\d+)/)?.[1];
        if (!number) throw new CommandError("could not read the opened setup pull request number");
        pull = { number: Number(number), url: opened };
      }
    }
    if (pull) {
      await closeLegacyPulls(exec, root, repo, pull.url);
      if (opts.merge) {
        const changed = await sh(exec, root, "gh", ["pr", "diff", String(pull.number), "--repo", repo, "--name-only"]);
        assertSetupPaths(changed ? changed.split("\n") : [], firstSetup);
        await merge(
          io,
          config,
          credentials,
          {
            rest: [String(pull.number)],
            options: { "no-ticket": "true", wait: "true" },
            json: false,
          },
          join(root, CONFIG_FILE),
          {
            readPull: (pull) => {
              if (pull.headRef !== branch || pull.baseRef !== base)
                throw new UsageError(
                  `init --merge requires ${branch} targeting ${base}; #${pull.number} is ${pull.headRef} targeting ${pull.baseRef}`,
                  "restore the setup pull request's branches and run armada init --merge again",
                );
            },
            beforeMerge: async (number, sha) => {
              // Check the immutable merge head, including both sides of renames. Main may have moved while CI ran.
              await sh(exec, checkout, "git", ["fetch", "--quiet", "origin", base, `refs/pull/${number}/head`]);
              const currentBase = await sh(exec, checkout, "git", ["rev-parse", "FETCH_HEAD"]);
              const configOnBase = await sh(exec, checkout, "git", [
                "ls-tree",
                "--name-only",
                currentBase,
                "--",
                CONFIG_FILE,
              ]);
              const diff = await sh(exec, checkout, "git", [
                "diff",
                "--name-only",
                "--no-renames",
                "-z",
                `${currentBase}...${sha}`,
              ]);
              assertSetupPaths(diff.split("\0").filter(Boolean), firstSetup && !configOnBase);
            },
          },
        );
      } else log(mergeHint(pull.number));
      if (plan.installed.length) log(`Installs: ${plan.installed.join(", ")}`);
      if (plan.updated.length) log(`Updates: ${plan.updated.join(", ")}`);
      if (plan.stopHook)
        log(
          `Adds the Claude Code stop hook to ${CLAUDE_SETTINGS}: this repository's settings, not your user settings.`,
        );
    }

    // 3. The project registry, on Armada.
    const { fleet, warning } = liveFleet(io, config, credentials);
    if (!fleet) throw new UsageError(`the project could not be registered: ${warning}`, "armada whoami");
    await fleet.register();
    log(`Registered project ${config.project.slug} on Armada; armada status --all lists it.`);
    return 0;
  } finally {
    await exec("git", ["worktree", "remove", "--force", checkout], { cwd: root }).catch(() => null);
    await rm(checkout, { recursive: true, force: true });
  }
}
