// `armada merge <pr>`: the coordinator merges a handed-back pull request.
// GitHub is read through the GraphQL API; the merge itself and the local
// checks go through `gh` and `git`, run without a shell by `io.exec`.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ArmadaConfig,
  type Credentials,
  createLinearWriter,
  fetchComparison,
  fetchMergePull,
  fetchPullDiff,
  LINEAR_KEY,
  type LocalRepo,
  loadStatus,
  type MergeAttempt,
  type MergeContext,
  type MergeForge,
  type MergeOutcome,
  mergePullRequest,
  missingKeyMessage,
  parsePullRequestUrl,
  type TestMergeResult,
} from "@armada/core";
import { type Exec, type Io, UsageError } from "./io.ts";
import { openLive, type WorkerArgs } from "./worker.ts";

/** A GitHub 5xx or a network failure, as gh reports them. */
const TRANSIENT =
  /\bHTTP 5\d\d\b|\b5\d\d (?:Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error)\b|Bad Gateway|Service Unavailable|Gateway Time-?out|ECONNRESET|ETIMEDOUT|connection reset|i\/o timeout|TLS handshake timeout/i;

const tail = (text: string, lines = 30) => text.trimEnd().split("\n").slice(-lines).join("\n");

/** `gh pr merge <n> --squash --match-head-commit <sha>`; never `--delete-branch`, which removes other agents' worktrees. */
export function ghMerge(exec: Exec, cwd: string, repository: string): MergeForge["merge"] {
  return async (number, sha): Promise<MergeAttempt> => {
    const args = ["pr", "merge", String(number), "--repo", repository, "--squash", "--match-head-commit", sha];
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
  };
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

function render(o: MergeOutcome): string {
  const out = [...o.lines, o.pr.url, o.ticket.url];
  if (o.hints.length) out.push("Hints for you to judge (not blocking):", ...o.hints.map((h) => `  - ${h}`));
  if (!o.merged) return `${out.join("\n")}\n`;
  if (!o.workers.length) out.push("No other worker is in flight.");
  else {
    out.push(`Tell these workers in flight what landed on ${o.pr.base} (rebase, shared files, new checks):`);
    for (const w of o.workers)
      out.push(
        `  ${w.ticket}  ${w.phase}  ${[w.runtime, w.handle].filter(Boolean).join(" · ") || "runtime unknown"}  ${w.title}`,
      );
  }
  const a = o.archive;
  if (a)
    out.push(
      `Archive the worker's workspace of ${o.ticket.id} (${[a.runtime, a.handle].filter(Boolean).join(" · ") || "session unknown"}) with the "Stop and archive" section of ${a.guide ? `the ${a.guide} skill` : "its runtime guide"}.`,
    );
  return `${out.join("\n")}\n`;
}

export async function merge(io: Io, config: ArmadaConfig, credentials: Credentials, a: WorkerArgs, configPath: string) {
  const [arg, ...extra] = a.rest;
  if (extra.length) throw new UsageError(`unexpected argument ${extra[0]}`);
  const number = prNumber(arg, config.github.repository);
  if (!credentials.linearApiKey) throw new UsageError(missingKeyMessage(LINEAR_KEY));
  const token = credentials.githubToken;
  if (!token) throw new UsageError("armada merge reads GitHub: set GITHUB_TOKEN or run `gh auth login`");
  const exec = io.exec;
  if (!exec) throw new UsageError("armada merge needs to run git and gh");
  const linearApiKey = credentials.linearApiKey;
  const repoDir = dirname(configPath);
  const fetchOpt = io.fetch ? { fetch: io.fetch } : {};
  const gh = { token, repository: config.github.repository, ...fetchOpt };
  const linearOpts = { apiKey: linearApiKey, labels: config.tracker.labels, ...fetchOpt };
  const now = io.now ?? (() => new Date());
  const turso: { live: ReturnType<typeof openLive> | null } = { live: null };
  const ctx: MergeContext = {
    config,
    linear: io.linearWriter ? io.linearWriter(linearOpts) : createLinearWriter(linearOpts),
    forge: {
      readPull: (n) => fetchMergePull({ ...gh, number: n }),
      compare: (base, head) => fetchComparison({ ...gh, base, head }),
      diff: (n) => fetchPullDiff({ ...gh, number: n }),
      merge: ghMerge(exec, repoDir, config.github.repository),
    },
    repo: gitRepo(exec, repoDir),
    turso: () => {
      turso.live ??= openLive(credentials);
      return turso.live;
    },
    inFlight: async () =>
      (await loadStatus(config, { linearApiKey, githubToken: null, ...fetchOpt, now })).inFlight.map((t) => ({
        id: t.id,
        title: t.title,
        phase: t.phase,
        runtime: t.runtime,
      })),
    holder: `${io.env.USER || "coordinator"}@${hostname()} ${randomUUID().slice(0, 8)}`,
    now,
    sleep: io.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
    progress: (line) => io.stderr(`armada: ${line}\n`),
  };
  try {
    const o = await mergePullRequest(ctx, {
      pr: number,
      ticket: a.options.ticket ?? null,
      dryRun: !!a.options["dry-run"],
    });
    io.stdout(a.json ? `${JSON.stringify(o, null, 2)}\n` : render(o));
    for (const w of o.warnings) io.stderr(`armada: warning: ${w}\n`);
    return 0;
  } finally {
    (await turso.live)?.db?.close();
  }
}
