// `armada merge <pr>`: the coordinator merges a handed-back pull request.
// GitHub is read through the GraphQL API; the merge itself and the local
// checks go through `gh` and `git`, run without a shell by `io.exec`.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AGENTS_SKILLS_DIR,
  type ArmadaConfig,
  askOwnerToMerge,
  buildModel,
  buildStatus,
  CLAUDE_SKILLS_DIR,
  type Credentials,
  createLinearWriter,
  fetchCommit,
  fetchComparison,
  fetchMergePull,
  fetchPreview,
  fetchPullDiff,
  LINEAR_KEY,
  type LocalRepo,
  MERGE_WAIT_DEFAULT_MS,
  type MergeAttempt,
  type MergeContext,
  type MergeForge,
  type MergeOutcome,
  mergePullRequest,
  parsePullRequestUrl,
  readStatusSources,
  shellWord,
  type TestMergeResult,
  unblockedBy,
} from "@armada/core";
import { type Exec, type Io, missingKey, UsageError } from "./io.ts";
import { coordinatorHandle, rearmFor, remember, watchOf } from "./watch.ts";
import { endWorkerSessions, liveFleet, type WorkerArgs } from "./worker.ts";

/** A GitHub 5xx or a network failure, as gh reports them. */
const TRANSIENT =
  /\bHTTP 5\d\d\b|\b5\d\d (?:Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error)\b|Bad Gateway|Service Unavailable|Gateway Time-?out|ECONNRESET|ETIMEDOUT|connection reset|i\/o timeout|TLS handshake timeout/i;

const tail = (text: string, lines = 30) => text.trimEnd().split("\n").slice(-lines).join("\n");

/** Runs one `gh` call that changes GitHub; a 5xx or a network failure is transient. */
async function ghAttempt(exec: Exec, cwd: string, args: string[]): Promise<MergeAttempt> {
  try {
    const r = await exec("gh", args, { cwd });
    const message = tail(`${r.stderr}\n${r.stdout}`.trim(), 5) || `gh exited with ${r.code}`;
    return { ok: r.code === 0, message, transient: r.code !== 0 && TRANSIENT.test(message) };
  } catch (err) {
    return {
      ok: false,
      message: `cannot run gh: ${err instanceof Error ? err.message : String(err)}`,
      transient: false,
    };
  }
}

/** `gh pr merge <n> --squash --match-head-commit <sha>`; never `--delete-branch`, which removes other agents' worktrees. */
export function ghMerge(exec: Exec, cwd: string, repository: string): MergeForge["merge"] {
  return (number, sha) =>
    ghAttempt(exec, cwd, ["pr", "merge", String(number), "--repo", repository, "--squash", "--match-head-commit", sha]);
}

/**
 * GitHub's "update branch" through `gh api`: merges the base into the head with
 * a merge commit (no force-push), refused by GitHub if the head is no longer `sha`.
 */
export function ghUpdateBranch(exec: Exec, cwd: string, repository: string): MergeForge["updateBranch"] {
  return (number, sha) =>
    ghAttempt(exec, cwd, [
      ...["api", "--method", "PUT", `repos/${repository}/pulls/${number}/update-branch`],
      ...["-f", `expected_head_sha=${sha}`],
    ]);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The project's checkout: git fetch, git grep, and a test merge in a throwaway worktree. */
export function gitRepo(exec: Exec, cwd: string): LocalRepo {
  const git = async (args: string[], dir = cwd) => {
    const r = await exec("git", args, { cwd: dir });
    return r;
  };
  const must = async (args: string[], dir = cwd) => {
    const r = await git(args, dir);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${tail(r.stderr || r.stdout, 5)}`);
    return r;
  };
  return {
    async grepWords({ branch, rev, words }) {
      await must(["fetch", "--quiet", "origin", branch]);
      const r = await git(["grep", "-I", "-n", "-w", "-F", ...words.flatMap((w) => ["-e", w]), rev, "--"]);
      // Exit 1 means no match.
      if (r.code > 1) throw new Error(`git grep failed: ${tail(r.stderr, 5)}`);
      const uses = new Map<string, string[]>();
      const tests = words.map((w) => [w, new RegExp(`(?<![\\w$])${escapeRe(w)}(?![\\w$])`)] as const);
      for (const line of r.stdout.split("\n")) {
        const m = line.match(new RegExp(`^${escapeRe(rev)}:(.+?):\\d+:(.*)$`));
        if (!m?.[1]) continue;
        const [file, text = ""] = [m[1], m[2]];
        for (const [w, re] of tests) {
          if (!re.test(text)) continue;
          const files = uses.get(w) ?? [];
          if (!files.includes(file)) uses.set(w, [...files, file]);
        }
      }
      return uses;
    },
    async mergeTree({ branch, number, ours, theirs }) {
      // One fetch brings every commit of the head: later steps of the same lineage find them here.
      const present = async (sha: string) => (await git(["cat-file", "-e", `${sha}^{commit}`])).code === 0;
      if (!(await present(ours)) || !(await present(theirs)))
        await must(["fetch", "--quiet", "origin", branch, `refs/pull/${number}/head`]);
      const r = await git(["merge-tree", "--write-tree", "--no-messages", ours, theirs]);
      // Exit 1 means the merge conflicts.
      if (r.code === 1) return null;
      if (r.code !== 0) throw new Error(`git merge-tree failed: ${tail(r.stderr || r.stdout, 5)}`);
      return r.stdout.split("\n")[0]?.trim() || null;
    },
    async testMerge({ branch, base, head, number, commands }): Promise<TestMergeResult> {
      await must(["fetch", "--quiet", "origin", branch, `refs/pull/${number}/head`]);
      const dir = join(tmpdir(), `armada-merge-${number}-${randomUUID().slice(0, 8)}`);
      const remove = async () => {
        await git(["worktree", "remove", "--force", dir]);
        await git(["worktree", "prune"]);
        await rm(dir, { recursive: true, force: true });
      };
      const added = await git(["worktree", "add", "--detach", dir, base]);
      if (added.code !== 0) {
        await remove();
        return { ok: false, step: "git worktree add", output: tail(added.stderr) };
      }
      try {
        // The machine's signing and hooks have no say in a throwaway merge.
        const merged = await git(
          [
            ...["-c", "user.name=Armada", "-c", "user.email=armada@localhost", "-c", "commit.gpgsign=false"],
            ...["merge", "--no-ff", "--no-edit", "--no-verify", head],
          ],
          dir,
        );
        if (merged.code !== 0)
          return {
            ok: false,
            step: `git merge ${head.slice(0, 7)}`,
            output: tail(`${merged.stdout}\n${merged.stderr}`),
          };
        for (const command of commands) {
          const r = await exec("sh", ["-c", command], { cwd: dir });
          if (r.code !== 0) return { ok: false, step: command, output: tail(`${r.stdout}\n${r.stderr}`) };
        }
        return { ok: true };
      } finally {
        await remove().catch(() => {});
      }
    },
  };
}

/** `<n>`, `#<n>` or the pull request URL in the project repository. */
export function prNumber(arg: string | undefined, repository: string): number {
  if (!arg) throw new UsageError("merge needs a pull request: armada merge <number or URL>");
  const trimmed = arg.trim().replace(/^#/, "");
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const pr = parsePullRequestUrl(trimmed);
  if (!pr) throw new UsageError(`"${arg}" is not a pull request number or URL`);
  if (pr.repo.toLowerCase() !== repository.toLowerCase())
    throw new UsageError(`${pr.url} is not in the project repository ${repository}`);
  return pr.number;
}

/** `--timeout` of `merge --wait`, in minutes. */
function waitMinutes(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--timeout must be a number of minutes, got "${raw}"`);
  return n;
}

function render(o: MergeOutcome): string {
  const out = [...o.lines, o.pr.url, ...(o.ticket ? [o.ticket.url] : [])];
  if (o.hints.length) out.push("Hints for you to judge (not blocking):", ...o.hints.map((h) => `  - ${h}`));
  if (!o.merged) return `${out.join("\n")}\n`;
  if (o.ticket && o.unblocked) {
    const { ready, parked, nowWaitsOn } = o.unblocked;
    const tickets = [...ready.map((t) => `${t.id} (${t.reason})`), ...parked.map((id) => `${id} (parked)`)];
    if (tickets.length) out.push(`Unblocked by ${o.ticket.id}: ${tickets.join(", ")}`);
    for (const t of ready) if (t.launch) out.push(`  ${t.launch}${t.route ? ` (${t.route.why})` : ""}`);
    for (const t of nowWaitsOn) out.push(`${t.id} now waits only on ${t.on.join(", ")}`);
  }
  if (!o.workers.length) out.push("No other worker is in flight.");
  else {
    out.push(`Tell these workers in flight what landed on ${o.pr.base} (bring it in, shared files, new checks):`);
    for (const w of o.workers)
      out.push(
        `  ${w.ticket}  ${w.phase}  ${[w.runtime, w.handle].filter(Boolean).join(" · ") || "runtime unknown"}  ${w.title}`,
      );
  }
  const a = o.archive;
  if (a && o.ticket) {
    const who = `${o.ticket.id} (${[a.runtime, a.handle].filter(Boolean).join(" · ") || "session unknown"})`;
    out.push(
      a.guide
        ? `Archive the worker's workspace of ${who} with the "Stop and archive" section of the ${a.guide} skill.`
        : `No runtime guide is installed for ${a.runtime ?? "the worker's runtime"}, so Armada has nothing to archive for ${who}: a local session or subagent ends with its task; stop it yourself if it still runs.`,
    );
  }
  return `${out.join("\n")}\n`;
}

export async function merge(io: Io, config: ArmadaConfig, credentials: Credentials, a: WorkerArgs, configPath: string) {
  const [arg, ...extra] = a.rest;
  if (extra.length) throw new UsageError(`unexpected argument ${extra[0]}`);
  const number = prNumber(arg, config.github.repository);
  const noTicket = !!a.options["no-ticket"];
  if (noTicket && a.options.ticket) throw new UsageError("--no-ticket and --ticket cannot go together");
  const wait = !!a.options.wait;
  const askOwner = a.options["ask-owner"] === "true";
  if (askOwner && (wait || a.options["dry-run"] || noTicket || a.options["no-lock"]))
    throw new UsageError("--ask-owner only asks the owner: it goes with --reason (and --ticket), nothing else");
  if (askOwner && !a.options.reason?.trim())
    throw new UsageError(
      `--ask-owner needs --reason: armada merge ${number} --ask-owner --reason "<why the owner must see it>"`,
    );
  if (wait && a.options["dry-run"]) throw new UsageError("--wait and --dry-run cannot go together");
  if (!wait && a.options.timeout !== undefined) throw new UsageError("--timeout applies to --wait");
  const timeoutMs = a.options.timeout === undefined ? MERGE_WAIT_DEFAULT_MS : waitMinutes(a.options.timeout) * 60_000;
  if (!credentials.linearApiKey) throw missingKey(LINEAR_KEY);
  const token = credentials.githubToken;
  if (!token) throw new UsageError("armada merge reads GitHub: set GITHUB_TOKEN", "gh auth login");
  const exec = io.exec;
  if (!exec) throw new UsageError("armada merge needs to run git and gh");
  const linearApiKey = credentials.linearApiKey;
  const repoDir = dirname(configPath);
  const fetchOpt = io.fetch ? { fetch: io.fetch } : {};
  const gh = { token, repository: config.github.repository, ...fetchOpt };
  const linearOpts = { apiKey: linearApiKey, labels: config.tracker.labels, ...fetchOpt };
  const now = io.now ?? (() => new Date());
  const live = liveFleet(io, config, credentials);
  const ctx: MergeContext = {
    config,
    linear: io.linearWriter ? io.linearWriter(linearOpts) : createLinearWriter(linearOpts),
    forge: {
      readPull: (n) => fetchMergePull({ ...gh, number: n }),
      compare: (base, head) => fetchComparison({ ...gh, base, head }),
      diff: (n) => fetchPullDiff({ ...gh, number: n }),
      merge: ghMerge(exec, repoDir, config.github.repository),
      comment: async (number, body) => {
        const result = await ghAttempt(exec, repoDir, [
          "pr",
          "comment",
          String(number),
          "--repo",
          config.github.repository,
          "--body",
          body,
        ]);
        if (!result.ok) throw new Error(result.message);
      },
      commit: (sha) => fetchCommit({ ...gh, sha }),
      updateBranch: ghUpdateBranch(exec, repoDir, config.github.repository),
      preview: (sha) => fetchPreview({ ...gh, sha }),
    },
    appUrl: credentials.armadaSignIn ? credentials.armadaApi.url : null,
    repo: gitRepo(exec, repoDir),
    // Signed in, the merge lock is required: two coordinators merge one after the other.
    lockRequired: !!credentials.armadaSignIn,
    fleet: async () => live,
    afterRead: async (ticket) => {
      const sources = await readStatusSources(config, { linearApiKey, githubToken: null, ...fetchOpt, now });
      const status = buildStatus({ config, ...sources, now: now() });
      const unblocked = ticket
        ? unblockedBy(buildModel(sources.program.issues, sources.program.rootId), ticket, {
            ready: config.tracker.readyLabel,
            parked: config.tracker.parkedLabel,
          })
        : null;
      return {
        inFlight: status.inFlight,
        unblocked: unblocked
          ? {
              ready: unblocked.ready.map((c) => {
                const route = status.frontier.find((t) => t.id === c.issue.id)?.route ?? null;
                const reason = c.readyForAgent
                  ? ("ready for an agent" as const)
                  : c.issue.labels.includes(config.tracker.readyLabel)
                    ? ("in triage" as const)
                    : ("no ready label" as const);
                return {
                  id: c.issue.id,
                  readyForAgent: c.readyForAgent,
                  reason,
                  route,
                  launch: c.readyForAgent
                    ? `armada brief ${shellWord(c.issue.id)} --prompt${route ? ` --profile ${shellWord(route.profile)}` : ""}`
                    : null,
                };
              }),
              parked: unblocked.parked.map((i) => i.id),
              nowWaitsOn: unblocked.nowWaitsOn,
            }
          : null,
      };
    },
    holder: `${io.env.USER || "coordinator"}@${hostname()} ${randomUUID().slice(0, 8)}`,
    now,
    sleep: io.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
    progress: (line) => io.stderr(`armada: ${line}\n`),
    installedSkill: async (name) => {
      for (const dir of [AGENTS_SKILLS_DIR, CLAUDE_SKILLS_DIR])
        if ((await io.readFile(join(repoDir, dir, name, "SKILL.md"))) !== null) return true;
      return false;
    },
  };
  if (askOwner) {
    const asked = await askOwnerToMerge(ctx, {
      pr: number,
      ticket: a.options.ticket ?? null,
      reason: a.options.reason ?? "",
    });
    const project = config.project.slug;
    const next = await rearmFor(io, project, {
      inFlight: (await watchOf(io, project)).state?.inFlight ?? null,
      open: null,
    });
    io.stdout(a.json ? `${JSON.stringify({ ...asked, watch: next }, null, 2)}\n` : `${render(asked)}${next.line}\n`);
    for (const w of asked.warnings) io.stderr(`armada: warning: ${w}\n`);
    return 0;
  }
  const o = await mergePullRequest(ctx, {
    pr: number,
    ticket: a.options.ticket ?? null,
    noTicket,
    wait: wait ? { timeoutMs } : null,
    dryRun: !!a.options["dry-run"],
    noLock: !!a.options["no-lock"],
    reason: a.options.reason ?? null,
  });
  // The workers still in flight, for the re-arm line: listed after a merge, else the last known ones.
  const project = config.project.slug;
  const coordinator = coordinatorHandle(io);
  const known = (await watchOf(io, project)).state?.inFlight ?? null;
  const inFlight = o.workersListed
    ? o.workers
        .filter((w) => !coordinator || w.handle !== coordinator)
        .map((w) => w.ticket)
        .sort((x, y) => x.localeCompare(y, "en", { numeric: true }))
    : o.merged && known
      ? known.filter((t) => t !== o.ticket?.id)
      : known;
  if (o.merged) await remember(io, project, { inFlight, readAt: (io.now ?? (() => new Date()))().toISOString() });
  const next = await rearmFor(io, project, { inFlight, open: null });
  io.stdout(a.json ? `${JSON.stringify({ ...o, watch: next }, null, 2)}\n` : `${render(o)}${next.line}\n`);
  for (const w of o.warnings) io.stderr(`armada: warning: ${w}\n`);
  if (o.merged && o.ticket) await endWorkerSessions(io, config, credentials, o.ticket.id, "merged", a.json);
  return 0;
}
