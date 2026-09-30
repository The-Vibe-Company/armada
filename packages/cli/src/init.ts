// `armada init`: opens one pull request that gives a repository everything
// `armada doctor` checks, creates the missing tracker labels and registers the
// project. The files are built on a fresh checkout of the default branch, in a
// temporary worktree, so the person's own checkout is never touched. Running it
// again rebuilds the same branch and updates the same pull request.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArmadaConfig,
  CONFIG_FILE,
  ConfigError,
  type Credentials,
  configTemplate,
  createMissingLabels,
  LINEAR_KEY,
  missingKeyMessage,
  openTurso,
  parseConfig,
  planIsEmpty,
  planSetup,
  readLabels,
  type SetupPlan,
  STORED_KEYS,
  slugify,
  upsertProject,
} from "@armada/core";
import { authLogin, loadCredentials } from "./auth.ts";
import { type Exec, type Io, UsageError } from "./io.ts";
import { applyPlan, CommandError, fsRepoView, gitRoot, requireExec, sh } from "./repo.ts";

export interface InitOptions {
  armadaVersion: string;
  /** For a repository without armada.toml. */
  programRoot: string | null;
  name: string | null;
  slug: string | null;
}

export const initBranch = (version: string) => `armada/init-${version}`;

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
      if (err instanceof ConfigError) throw new UsageError(`${err.message}\nFix it, then run armada init again.`);
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
  const branch = initBranch(opts.armadaVersion);
  if (!opts.programRoot && (await sh(exec, root, "git", ["ls-remote", "origin", `refs/heads/${branch}`]))) {
    await sh(exec, root, "git", ["fetch", "--quiet", "origin", branch]);
    const shown = await exec("git", ["show", `FETCH_HEAD:${CONFIG_FILE}`], { cwd: root });
    if (shown.code === 0)
      return { config: parse(shown.stdout, `${CONFIG_FILE} on ${branch}`), text: shown.stdout, source: branch };
  }
  if (!opts.programRoot)
    throw new UsageError(
      `${CONFIG_FILE} is missing. Run armada init --program-root <ISSUE-ID> with the Linear issue at the root of the program, or add ${CONFIG_FILE} (see README).`,
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
    "",
    "Once merged, `armada doctor` passes on the default branch.",
    "",
    "Opened by `armada init`. Running it again rebuilds this branch from the default branch and updates this pull request, so commits pushed here by hand are replaced.",
  ];
  return { title, body: lines.join("\n") };
}

export async function init(io: Io, opts: InitOptions): Promise<number> {
  const exec = requireExec(io);
  const tursoKey = STORED_KEYS.find((k) => k.name === "tursoUrl") ?? LINEAR_KEY;
  const required = (c: Credentials) => [c.linearApiKey ? null : LINEAR_KEY, c.tursoUrl ? null : tursoKey];
  // Ask for missing keys on a terminal. Without one, go on when the keys init
  // needs are set: a Turso token is optional (a local file database has none).
  if (io.interactive || required((await loadCredentials(io)).credentials).some(Boolean)) {
    const login = await authLogin(io);
    if (login !== 0) return login;
  }
  const { credentials } = await loadCredentials(io);
  const missing = required(credentials).find(Boolean);
  if (missing) throw new UsageError(missingKeyMessage(missing));
  const linearApiKey = credentials.linearApiKey ?? "";
  const tursoUrl = credentials.tursoUrl ?? "";

  const root = await gitRoot(exec, io.cwd);
  if (!root) throw new UsageError(`${io.cwd} is not inside a git repository`);
  const base = await defaultBranch(exec, root);
  await sh(exec, root, "git", ["fetch", "--quiet", "origin", base]);
  const baseSha = await sh(exec, root, "git", ["rev-parse", "FETCH_HEAD"]);
  const checkout = await realpath(await mkdtemp(join(tmpdir(), "armada-init-")));
  try {
    await sh(exec, root, "git", ["worktree", "add", "--quiet", "--detach", checkout, baseSha]);
    const { config, text, source } = await resolveConfig(exec, root, checkout, opts);
    const view = fsRepoView(checkout);
    const plan = await planSetup(view, { armadaVersion: opts.armadaVersion, configText: text });
    const log = (line: string) => io.stdout(`${line}\n`);
    log(`Armada ${opts.armadaVersion} · ${config.github.repository} · ${config.tracker.programRoot}`);
    if (source !== "default branch" && source !== "new")
      log(
        `Using ${CONFIG_FILE} from ${source === "working tree" ? "the working tree" : source}; the pull request adds it.`,
      );

    // 1. Tracker labels.
    const linear = { apiKey: linearApiKey, ...(io.fetch ? { fetch: io.fetch } : {}) };
    const created = await createMissingLabels(await readLabels(config, linear), linear);
    log(created.length ? `Created Linear labels: ${created.join(", ")}` : "Linear labels: all present");

    // 2. The pull request.
    if (planIsEmpty(plan)) log(`${base} already has everything Armada needs; no pull request to open.`);
    else {
      const branch = initBranch(opts.armadaVersion);
      await applyPlan(checkout, plan);
      // Exactly the planned paths, even where the repository's .gitignore covers them (.claude/ often is).
      const paths = [...plan.writes.map((w) => w.path), ...plan.links.map((l) => l.path), ...plan.removes];
      await sh(exec, checkout, "git", ["add", "--all", "--force", "--", ...paths]);
      const { title, body } = prText(plan, opts.armadaVersion);
      // No hooks: they belong to the project's own commits; the pull request's CI checks these files.
      await sh(exec, checkout, "git", ["commit", "--quiet", "--no-verify", "--message", title]);
      // The branch belongs to armada init: it is rebuilt from the default branch on every run,
      // and pushed only when its content changed, so a rerun does not restart CI for nothing.
      if (await branchIsCurrent(exec, checkout, branch, baseSha)) log(`${branch} is already up to date.`);
      else await sh(exec, checkout, "git", ["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${branch}`]);
      const repo = config.github.repository;
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
          "number,url",
        ])) || "[]",
      ) as { number: number; url: string }[];
      const existing = open[0];
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
        log(`Opened pull request ${url.split("\n").pop()}`);
      }
      if (plan.installed.length) log(`Installs: ${plan.installed.join(", ")}`);
      if (plan.updated.length) log(`Updates: ${plan.updated.join(", ")}`);
    }

    // 3. The project registry.
    const db = await openTurso({ url: tursoUrl, token: credentials.tursoToken });
    try {
      const project = {
        slug: config.project.slug,
        name: config.project.name,
        repository: config.github.repository,
        programRoot: config.tracker.programRoot,
      };
      await upsertProject(db, project, io.now?.() ?? new Date());
    } finally {
      db.close();
    }
    log(`Registered project ${config.project.slug}; armada status --all lists it.`);
    return 0;
  } finally {
    await exec("git", ["worktree", "remove", "--force", checkout], { cwd: root }).catch(() => null);
    await rm(checkout, { recursive: true, force: true });
  }
}
