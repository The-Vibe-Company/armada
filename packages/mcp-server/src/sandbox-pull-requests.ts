import {
  PUSH_LEDGER_FILE,
  PUSH_LEDGER_HOOKS,
  PUSH_LEDGER_MARKER,
  pushLedgerInstall,
  type SandboxPullRequest,
} from "@armada/core";
import {
  type ExecRequest,
  type ExecResult,
  type GitHubResolveDeps,
  resolveGitHubAccess,
  type Sql,
} from "@armada/core/server";
import { z } from "zod";
import type { Job, JobKind, JobResult } from "./jobs/runner.ts";
import { type createJobsStore, rescheduleRecurringJob, withJobLease } from "./jobs/store.ts";
import { prScanExpediteEpoch, upsertLangfusePrLinkedScores } from "./langfuse.ts";
import {
  clearPullRequestMergeProof,
  commitPullRequestScan,
  markPullRequestScanUntracked,
  PULL_REQUEST_SCAN_ELIGIBLE,
  type PullRequestIdentity,
  type PullRequestScanTarget,
  retainPullRequestScan,
} from "./sandbox-lifecycle.ts";

const repoName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const repoUrl =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i;
const prUrl = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/i;
const repos = z
  .array(z.object({ url: z.string(), dir: z.string().min(1), branch: z.string().optional() }))
  .min(1)
  .max(16);
const githubPull = z.object({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable(),
  // Absent means unknown: such a closed PR is treated as closed after launch.
  closed_at: z.string().nullable().optional(),
  head: z.object({
    ref: z.string().min(1),
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
});
const githubCompare = z.object({ status: z.enum(["ahead", "behind", "identical", "diverged"]) });

const launchBranch = /^(?!-)[A-Za-z0-9._/-]{1,255}$/;
const maxBranches = 32;
const maxKnownPulls = 64;
const maxPushesPerBranch = 16;
// Ancestry lookups per scan for pull requests whose head moved past a push.
const maxLineageChecks = 32;

// A local branch name or matching SHA alone also describes a checkout made by
// another sandbox. Only pushes qualify for discovery: the launch-installed
// ledger (which survives a pruned or deleted tracking ref) and reflog records
// written by a push. Output lists confirmed pushes newest first, in the
// ledger's single chronological order (reflog pushes it lacks, which already
// void coverage, follow). An attempt no tracking update confirmed (rejected,
// or accepted but its tracking update failed) never counts as a push. It prints
// `~\t<branch>\t<sha>` once a later confirmed push to the same branch
// superseded it, `?\t<branch>\t<sha>` while unresolved, and `!pending` while one
// is younger than ten minutes and may still be in flight. A ledger
// gap (a push to a URL or another remote, or an origin update without a
// reflog entry) or a reflog push the ledger lacks prints `!untracked`. A
// missing hook (a tool such as husky can move core.hooksPath) prints
// `!unproven`, leaves a ledger gap for later reads and is reinstalled when the
// path is free. Either way pushes may have escaped the ledger, so the worker
// never proves coverage again. The absence of a gap is not proof on its own:
// `!uncovered` reports a local branch tip or HEAD that no confirmed push and
// not the launch branch contains, whether unpushed or pushed past the hooks.
export const readPushEvidence = `hooks="$(git rev-parse --git-path hooks)" || exit 1
ledger="$(git rev-parse --git-common-dir)/${PUSH_LEDGER_FILE}" || exit 1
for name in ${PUSH_LEDGER_HOOKS.join(" ")}; do
  if [ ! -x "$hooks/$name" ] || [ "$(sed -n 2p "$hooks/$name")" != '${PUSH_LEDGER_MARKER}' ]; then missing=1; fi
done
if [ -n "$missing" ]; then
  echo '!unproven'
  # Record the loss in the ledger before restoring the hooks: if this scan is
  # abandoned, the next read still reports it.
  printf '%s\\t!gap\\n' "$(date +%s)" >>"$ledger" || exit 1
  ${pushLedgerInstall}
fi
entries=$(if [ -f "$ledger" ]; then cat "$ledger"; fi) || exit 1
logs=$(git reflog show --all --date=unix --format='%gD%x09%gs%x09%H') || exit 1
# Coverage is affirmative: every local line of work (each branch tip, each
# worktree's HEAD, and each detached HEAD left behind since launch) must be
# contained in a confirmed push or in the launch branch as fetched ($3, else
# origin/HEAD). A commit that left by an unrecorded push (a URL with
# --no-verify) is still on one of them. Up to eight uncovered tips print as
# ^<tab><sha>, more as !uncovered; either withholds the stop.
if [ -n "$3" ]; then base="refs/remotes/origin/$3"; else base=refs/remotes/origin/HEAD; fi
covered=$({ if [ -n "$entries" ]; then printf '%s\\n' "$entries" | awk -F '\\t' -v since="$1" 'NF == 3 && $2 !~ /^!/ && $1 + 0 >= since { print "^" $3 }'; fi
  if sha=$(git rev-parse -q --verify "$base^{commit}"); then echo "^$sha"; fi; }) || exit 1
tips=$(git for-each-ref --format='%(objectname)' refs/heads) || exit 1
worktrees=$(git worktree list --porcelain) || exit 1
tips="$tips $(printf '%s\\n' "$worktrees" | sed -n 's/^HEAD \\([0-9a-f]*[1-9a-f][0-9a-f]*\\)$/\\1/p')"
if git rev-parse -q --verify HEAD >/dev/null; then
  left=$(git reflog show HEAD --date=unix --format='%gd%x09%gs') || exit 1
  tips="$tips $(printf '%s\\n' "$left" | awk -F '\\t' -v since="$1" '{ t = $1; sub(/^.*@\\{/, "", t) }
    t + 0 >= since && $2 ~ /^checkout: moving from [0-9a-f]+ to / { split($2, w, " "); if (length(w[4]) == 40) print w[4] }')"
fi
for tip in $tips; do
  case " $checked " in *" $tip "*) continue ;; esac
  checked="$checked $tip"
  ahead=$(printf '%s\\n' "$covered" | grep . | git rev-list --ignore-missing -n 1 --stdin "$tip") || exit 1
  if [ -n "$ahead" ]; then uncovered="$uncovered $tip"; fi
done
{ if [ -n "$entries" ]; then printf '%s\\n' "$entries" | awk '{ print "L\\t" $0 }'; fi; printf '%s\\n' "$logs"; } |
awk -v since="$1" -v now="$(date +%s)" -v uncovered="$uncovered" -F '\\t' '$1 == "L" {
    if ($2+0 < since) next
    s++
    if (NF == 3 && $3 == "!gap") gap=1
    else if (NF == 6 && $3 == "!push") { key=$5 "\\t" $6; if (!(key in listed)) { listed[key]=1; order[++a]=key; abranch[key]=$5 }; attempt[key]=$2; aseq[key]=s }
    else if (NF == 4) { key=$3 "\\t" $4; n++; lkey[n]=key; ledger[key]=1; delete attempt[key]; cseq[$3]=s }
    next
  }
  $1 ~ /^refs\\/remotes\\/origin\\// && $2 == "update by push" {
    timestamp=$1
    sub(/^.*@\\{/, "", timestamp)
    if (timestamp+0 < since) next
    sub(/@\\{[^@]*\\}$/, "", $1)
    sub(/^refs\\/remotes\\/origin\\//, "", $1)
    m++; rkey[m]=$1 "\\t" $3
  }
  END {
    if (gap) print "!untracked"
    for (i=1; i<=m; i++) if (!ledger[rkey[i]]) print "!untracked"
    for (i=1; i<=a; i++) if ((order[i] in attempt) && cseq[abranch[order[i]]] <= aseq[order[i]] && attempt[order[i]] + 600 > now) pending=1
    if (pending) print "!pending"
    k = split(uncovered, tip, " ")
    if (k > 8) print "!uncovered"
    else for (i=1; i<=k; i++) print "^\\t" tip[i]
    for (i=n; i>=1; i--) if (!seen[lkey[i]]++) print lkey[i]
    for (i=1; i<=m; i++) if (!seen[rkey[i]]++) print rkey[i]
    for (i=1; i<=a; i++) if (order[i] in attempt) print (cseq[abranch[order[i]]] > aseq[order[i]] ? "~" : "?") "\\t" order[i]
  }'`;
const readPushes = `remote=$(git remote get-url --push --all origin) || exit 1
case "$remote" in
  "https://github.com/$2"|"https://github.com/$2.git"|"git@github.com:$2"|"git@github.com:$2.git"|"ssh://git@github.com/$2"|"ssh://git@github.com/$2.git") ;;
  *) exit 1 ;;
esac
${readPushEvidence}`;

const scanKind = "pr_scan";
const scanKey = "periodic";
const maxAttempts = 3;

export function createPullRequestScanJob(
  sql: Sql,
  jobs: Pick<ReturnType<typeof createJobsStore>, "enqueue">,
  github: GitHubResolveDeps,
  exec: (target: PullRequestScanTarget, request: ExecRequest) => Promise<ExecResult>,
  now = Date.now,
  options: { langfuseFetch?: typeof fetch; logError?: (line: string) => void } = {},
) {
  const retryAfter = (minutes: number) => new Date(now() + minutes * 60_000);
  let nextSeed = 0;
  let nextScan = 0;
  let seenExpediteEpoch = prScanExpediteEpoch();
  async function prepare() {
    const currentExpediteEpoch = prScanExpediteEpoch();
    if (currentExpediteEpoch !== seenExpediteEpoch) {
      seenExpediteEpoch = currentExpediteEpoch;
      nextSeed = Math.min(nextSeed, now());
      nextScan = Math.min(nextScan, now());
    }
    if (now() >= nextSeed) {
      const { rows } = await sql.query<{ id: string; org_id: string; generation: string }>(
        `select s.id,s.org_id,s.lifecycle_generation::text as generation ${PULL_REQUEST_SCAN_ELIGIBLE}
         and not exists(select 1 from public.jobs j where j.kind=$1
           and j.sandbox_id=s.id and j.generation=s.lifecycle_generation)
         order by s.id limit 32`,
        [scanKind],
      );
      for (const row of rows)
        await jobs.enqueue(scanKind, row.id, Number(row.generation), scanKey, null, { orgId: row.org_id, maxAttempts });
      nextSeed = now() + 15_000;
    }
    return now() >= nextScan;
  }

  async function check(job: Job, signal: AbortSignal, canDispatch: () => Promise<boolean>) {
    // Invalidate proof before observing remote state. A later holder can safely repeat the read.
    const row = await withJobLease(
      sql,
      job,
      async (tx) => (await clearPullRequestMergeProof(tx, job.sandbox_id, job.generation)).rows[0],
    );
    if (!row) return null;
    nextScan = now() + 15_000;
    try {
      const configured = repos.parse(row.repositories);
      const scan = row.pull_request_scan ?? { pushes: {}, discovered: [] };
      const branches = new Map<string, Map<string, string[]>>();
      // Unconfirmed push attempts: never evidence, but a pull request still
      // unmerged at one of them may be work of this sandbox.
      const attempted = new Map<string, Map<string, string[]>>();
      // Attempts no later confirmed push to their branch superseded: a rejected
      // push, or an accepted one whose tracking update failed (a held ref lock,
      // a killed process). Only the commit's absence from GitHub tells them apart.
      const unresolved = new Set<string>();
      let pending = false;
      let uncovered = false;
      // GitHub's head filter receives the owner as configured, not lowercased.
      const owners = new Map<string, string>();
      for (const repo of configured) {
        signal.throwIfAborted();
        const remote = repoUrl.exec(repo.url)?.[1];
        const repository = remote?.toLowerCase();
        if (
          !remote ||
          !repository ||
          !repoName.test(repository) ||
          !/^[a-zA-Z0-9._-]+$/.test(repo.dir) ||
          [".", ".."].includes(repo.dir)
        )
          return;
        // The timestamp comes from PostgreSQL, but pass it as data even here.
        const since = Math.ceil(new Date(row.created_at).getTime() / 1000);
        if (!Number.isSafeInteger(since)) return;
        const names = branches.get(repository) ?? new Map(scan.pushes[repository] ?? []);
        branches.set(repository, names);
        owners.set(repository, remote.slice(0, remote.indexOf("/")));
        if (!row.active) continue;
        if (!(await canDispatch())) return;
        const result = await exec(row, {
          sandboxId: row.provider_sandbox_id,
          // The launch branch counts as integrated work; without a usable name
          // the reader falls back to origin/HEAD.
          command: `set -- '${since}' '${remote}' '${repo.branch && launchBranch.test(repo.branch) ? repo.branch : ""}'; ${readPushes}`,
          cwd: `/home/user/${repo.dir}`,
          timeoutSeconds: 5,
          signal,
        });
        if (result.detached || result.exitCode !== 0 || result.truncated || result.timedOut) return;
        const lines = result.stdout.trimEnd() ? result.stdout.trimEnd().split("\n") : [];
        // Reinstalling a missing hook restores future evidence, but a push
        // made meanwhile and then pruned leaves no trace. The loss is sticky and
        // persisted before anything else can abandon this scan, because the
        // next read no longer reports it.
        if (lines.some((line) => line === "!untracked" || line === "!unproven")) {
          scan.untracked = true;
          const sticky = await withJobLease(sql, job, (tx) => markPullRequestScanUntracked(tx, row.id));
          if (!sticky?.rows.length) return;
        }
        const pushed = new Map<string, string[]>();
        for (const line of lines) {
          if (line === "!untracked" || line === "!unproven") continue;
          if (line === "!pending") {
            pending = true;
            continue;
          }
          // Local work no confirmed push carries: unmerged work, or a push
          // that escaped the ledger. It vetoes this scan's stop.
          if (line === "!uncovered" || /^\^\t[a-f0-9]{40}$/.test(line)) {
            uncovered = true;
            continue;
          }
          // Neither `?` nor `~` can start a Git branch name.
          const attempt = line.startsWith("?\t") || line.startsWith("~\t");
          const [ref, sha, extra] = (attempt ? line.slice(2) : line).split("\t");
          if (!ref || ref.length > 255 || /\s/.test(ref) || [...ref].some((char) => char.charCodeAt(0) < 32)) return;
          if (!sha || !/^[a-f0-9]{40}$/.test(sha) || extra !== undefined) return;
          if (attempt) {
            const refs = attempted.get(repository) ?? new Map<string, string[]>();
            attempted.set(repository, refs);
            refs.set(ref, [...(refs.get(ref) ?? []), sha]);
            if (line.startsWith("?")) unresolved.add(`${repository}\t${sha}`);
            continue;
          }
          pushed.set(ref, [...(pushed.get(ref) ?? []), sha]);
        }
        // This read is newer than the retained evidence; a re-pushed SHA moves first.
        for (const [ref, shas] of pushed) names.set(ref, [...new Set([...shas, ...(names.get(ref) ?? [])])]);
        scan.heads = {
          ...scan.heads,
          [repository]: {
            ...scan.heads?.[repository],
            [repo.dir]: Object.fromEntries([...pushed].map(([ref, shas]) => [ref, shas[0] as string])),
          },
        };
      }
      // Each checkout's own latest push per branch. Checkouts of one repository
      // keep separate ledgers with no order between them, so any of these may be
      // the branch's latest push, and every one must be at a pull request head.
      const heads = new Map<string, Map<string, Set<string>>>();
      for (const [repository, dirs] of Object.entries(scan.heads ?? {})) {
        const latest = heads.get(repository) ?? new Map<string, Set<string>>();
        heads.set(repository, latest);
        for (const refs of Object.values(dirs))
          for (const [ref, sha] of Object.entries(refs)) latest.set(ref, (latest.get(ref) ?? new Set()).add(sha));
      }
      // Retain push evidence when Git prunes a tracking ref or expires its reflog.
      scan.pushes = Object.fromEntries([...branches].map(([repo, names]) => [repo, [...names]]));
      const retained = await withJobLease(sql, job, (tx) =>
        retainPullRequestScan(tx, row.id, JSON.stringify(scan), row.lifecycle_generation),
      );
      if (!retained?.rows.length) return;
      const numbers = new Map<string, PullRequestIdentity>();
      const discovered = new Map<string, PullRequestIdentity>();
      const urlFor = ({ repository, number }: PullRequestIdentity) => `https://github.com/${repository}/pull/${number}`;
      for (const identity of scan.discovered) {
        numbers.set(urlFor(identity), identity);
        discovered.set(urlFor(identity), identity);
      }
      // A report this scan cannot verify (malformed, or outside the launch
      // grant) vetoes the stop without hiding the authorized pull requests.
      let complete = true;
      const selected =
        configured.length === 1 ? configured[0] : configured.find(({ dir }) => dir === row.repository_dir);
      const defaultRepo = selected && repoUrl.exec(selected.url)?.[1]?.toLowerCase();
      for (const report of Object.values(row.pull_request_reports)) {
        const match = report.prUrl ? prUrl.exec(report.prUrl) : undefined;
        const repository = match?.[1]?.toLowerCase() ?? defaultRepo;
        const number = match ? Number(match[2]) : report.prNumber;
        if (
          !repository ||
          !branches.has(repository) ||
          !number ||
          !Number.isSafeInteger(number) ||
          number < 1 ||
          (report.prUrl && !match) ||
          (report.prNumber !== undefined && report.prNumber !== number)
        ) {
          complete = false;
          continue;
        }
        const identity = { repository, number };
        numbers.set(urlFor(identity), identity);
      }
      // Confirmed pushes and unconfirmed attempts share one lookup per branch.
      const lookups = new Map<string, Map<string, { shas: string[]; attempts: string[] }>>();
      for (const [source, attempts] of [
        [branches, false],
        [attempted, true],
      ] as const) {
        for (const [repository, refs] of source) {
          const lookup = lookups.get(repository) ?? new Map<string, { shas: string[]; attempts: string[] }>();
          lookups.set(repository, lookup);
          for (const [ref, shas] of refs) {
            const entry = lookup.get(ref) ?? { shas: [], attempts: [] };
            lookup.set(ref, entry);
            if (attempts) entry.attempts = shas;
            else entry.shas = shas;
          }
        }
      }
      const branchCount = [...lookups.values()].reduce((sum, refs) => sum + refs.size, 0);
      if (branchCount > maxBranches || numbers.size > maxKnownPulls) return;
      // Dropping an older push could hide its closed PR, so too many is
      // incomplete. The newest pushes are still looked up: retained evidence
      // only grows, and returning here would freeze the listed states for good.
      if (unresolved.size > maxPushesPerBranch) complete = false;
      for (const refs of lookups.values())
        for (const entry of refs.values())
          if (entry.shas.length > maxPushesPerBranch || entry.attempts.length > maxPushesPerBranch) {
            complete = false;
            entry.shas = entry.shas.slice(0, maxPushesPerBranch);
            entry.attempts = entry.attempts.slice(0, maxPushesPerBranch);
          }
      const found = new Map<string, SandboxPullRequest>();
      const checkedAt = new Date(now()).toISOString();
      const launchedAt = Date.parse(row.created_at);
      if (numbers.size || branchCount) {
        if (!(await canDispatch())) return;
        signal.throwIfAborted();
        const request = github.fetch ?? fetch;
        const access = await resolveGitHubAccess({ ...github, caller: "managed_runtime" }, row.owner_id);
        if (
          access.status !== "connected" ||
          String(access.identity.id) !== row.github_id ||
          access.connectionEpoch !== row.connection_epoch
        )
          return;
        const token = access.token;
        let requests = 0;
        let lineageChecks = 0;
        // `paged`: only the response's status matters, not a complete page.
        async function get(repository: string, path: string, missing = false, paged = false) {
          if (!repoName.test(repository) || !branches.has(repository))
            throw Error("Repository is outside the sandbox grant.");
          // A large scan costs capacity from subsequent scans, even on failure.
          nextScan = Math.max(nextScan, now() + ++requests * 1000);
          signal.throwIfAborted();
          if (!(await canDispatch())) throw Error("PR scan dispatch no longer authorized.");
          signal.throwIfAborted();
          const response = await request(`https://api.github.com/repos/${repository}${path}`, {
            signal,
            redirect: "error",
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/vnd.github+json",
            },
          });
          // An unknown commit is an answer, not a failed observation.
          if (missing && (response.status === 404 || response.status === 422)) return undefined;
          if (!response.ok || (!paged && response.headers.get("link")?.includes('rel="next"')))
            throw Error("Incomplete pull request observation.");
          return response.json();
        }
        // Whether a pushed commit is in a pull request's head history. An unknown
        // commit (say, garbage-collected after a force push) is not.
        async function contains(repository: string, pushed: string, head: string) {
          const body = await get(repository, `/compare/${pushed}...${head}?per_page=1`, true, true);
          if (body === undefined) return false;
          const { status } = githubCompare.parse(body);
          return status === "ahead" || status === "identical";
        }
        function record(repository: string, pull: z.infer<typeof githubPull>) {
          if (pull.base.repo.full_name.toLowerCase() !== repository) throw Error("Pull request repository changed.");
          const url = `https://github.com/${repository}/pull/${pull.number}`;
          found.set(url, {
            repository,
            url,
            number: pull.number,
            headBranch: pull.head.ref,
            checkedAt,
            state: pull.merged_at ? "merged" : pull.state,
          });
        }
        const known = [...numbers.values()];
        for (let offset = 0; offset < known.length; offset += 8) {
          const batch = await Promise.allSettled(
            known.slice(offset, offset + 8).map(async ({ repository, number }) => {
              const pull = githubPull.parse(await get(repository, `/pulls/${number}`));
              if (pull.number !== number) throw Error("Pull request number changed.");
              record(repository, pull);
              // Discovery already excludes PRs closed before launch; a report
              // naming one cannot be this sandbox's work and withholds the stop.
              if (pull.state !== "open" && Date.parse(pull.closed_at ?? "") < launchedAt) complete = false;
            }),
          );
          for (const result of batch) if (result.status === "rejected") throw result.reason;
        }
        for (const [headRepository, refs] of lookups) {
          for (const [ref, { shas, attempts }] of refs) {
            const params = new URLSearchParams({
              state: "all",
              head: `${owners.get(headRepository)}:${ref}`,
              per_page: "100",
            });
            let named = false;
            // Retained evidence alone (no checkout read this branch) has one order.
            const latest = heads.get(headRepository)?.get(ref) ?? new Set(shas.slice(0, 1));
            const matched = new Set<string>();
            const batch = await Promise.allSettled(
              [...branches.keys()].map(async (repository) => ({
                repository,
                pulls: z
                  .array(githubPull)
                  .max(100)
                  .parse(await get(repository, `/pulls?${params}`)),
              })),
            );
            for (const result of batch) {
              if (result.status === "rejected") throw result.reason;
              const { repository, pulls } = result.value;
              for (const pull of pulls) {
                if (pull.head.repo?.full_name.toLowerCase() !== headRepository || pull.head.ref !== ref) continue;
                // A pull request closed before launch froze its head before any
                // push from here, even when a recreated branch reaches that same
                // commit again: it is never this sandbox's work.
                const closedBeforeLaunch = pull.state !== "open" && Date.parse(pull.closed_at ?? "") < launchedAt;
                // Only an open or post-launch PR makes the branch PR-bearing; a
                // branch with only pre-launch history stays a scratch push.
                if (!closedBeforeLaunch) named = true;
                if (!closedBeforeLaunch && shas.includes(pull.head.sha)) {
                  // A PR at any pushed commit is this sandbox's work, so an
                  // earlier closed-unmerged PR still vetoes the stop.
                  const identity = { repository, number: pull.number };
                  discovered.set(urlFor(identity), identity);
                  record(repository, pull);
                  if (latest.has(pull.head.sha)) matched.add(pull.head.sha);
                  continue;
                }
                // Someone may have advanced the head past this sandbox's push
                // before the first scan (a reviewer's commit, then the merge).
                // A pull request that was still open at launch and whose head
                // history holds a push is this sandbox's work.
                if (!closedBeforeLaunch) {
                  let associated = false;
                  // Latest pushes first: one inside the head is merged with it.
                  for (const pushed of new Set([...latest, ...shas])) {
                    if (associated && !latest.has(pushed)) break;
                    if (++lineageChecks > maxLineageChecks) {
                      // Ambiguous: the relationship stays unproven, so no stop.
                      complete = false;
                      break;
                    }
                    if (!(await contains(headRepository, pushed, pull.head.sha))) continue;
                    associated = true;
                    if (latest.has(pushed)) matched.add(pushed);
                  }
                  if (associated) {
                    const identity = { repository, number: pull.number };
                    discovered.set(urlFor(identity), identity);
                    record(repository, pull);
                    continue;
                  }
                }
                if (
                  pull.state === "open" ||
                  (!pull.merged_at && (attempts.includes(pull.head.sha) || !closedBeforeLaunch))
                ) {
                  // A moved open head blocks stopping without becoming work of
                  // this sandbox. So does an unmerged PR at an unconfirmed
                  // attempt, which may be a push whose result was lost, and a
                  // PR closed unmerged after launch whose head moved off this
                  // sandbox's pushes: its earlier head may have been one of
                  // them. A PR closed before launch froze its head before any
                  // push from here; a merged PR at a moved head is neither.
                  complete = false;
                }
              }
            }
            // A complete lookup with no pull request is a scratch push, not
            // unfinished work; the merge proof still needs one merged PR. A
            // push after the branch's pull requests (none at the latest pushed
            // head) is unmerged work and blocks stopping.
            if (named && shas.length && matched.size < latest.size) complete = false;
          }
        }
        // GitHub never received a rejected push's commit. A commit it has may be
        // a push whose confirmation was lost, so it withholds the stop.
        for (const key of unresolved) {
          if (!complete) break;
          const [repository = "", sha] = key.split("\t");
          if (await get(repository, `/commits/${sha}`, true)) complete = false;
        }
      }
      signal.throwIfAborted();
      const list = [...found.values()];
      if (github.encryptionKey && list.length > 0 && (await canDispatch())) {
        const priorUrls = new Set(
          (
            (
              await sql.query<{ pull_requests: SandboxPullRequest[] | null }>(
                "select pull_requests from public.sandboxes where id=$1",
                [row.id],
              )
            ).rows[0]?.pull_requests ?? []
          ).map((pr) => pr.url.toLowerCase()),
        );
        if (list.some((pr) => !priorUrls.has(pr.url.toLowerCase()))) {
          try {
            await upsertLangfusePrLinkedScores(sql, github.encryptionKey, row.id, {
              send: options.langfuseFetch,
              signal,
              logError: options.logError ?? console.error,
            });
          } catch (error) {
            if (signal.aborted) throw error;
          }
          signal.throwIfAborted();
        }
      }
      const proof =
        row.active &&
        // A read taken during a turn can precede that turn's last push. The
        // prompt and generation fences do not change when the turn settles.
        row.settled &&
        row.launch_authorized &&
        complete &&
        !pending &&
        !uncovered &&
        !scan.untracked &&
        list.length > 0 &&
        list.every((pr) => pr.state === "merged")
          ? {
              checkedAt,
              connectionEpoch: row.connection_epoch,
              membershipEpoch: row.membership_epoch,
              generation: row.lifecycle_generation,
              promptId: row.task_prompt_id,
            }
          : null;
      return {
        status: "retry",
        after: retryAfter(15),
        async commit(tx) {
          signal.throwIfAborted();
          const { rows } = await commitPullRequestScan(
            tx,
            row,
            JSON.stringify(list),
            JSON.stringify(proof),
            JSON.stringify({ ...scan, discovered: [...discovered.values()] }),
          );
          signal.throwIfAborted();
          await rescheduleRecurringJob(tx, job, retryAfter(rows[0] ? (rows[0].stopped ? 30 : 5) : 15));
        },
      } satisfies JobResult;
    } catch {
      // A partial observation preserves the last complete list.
    }
  }

  return {
    concurrency: 1,
    prepare,
    async run(job, context) {
      if (job.sandbox_id === null || job.generation === null) return { status: "fail", reason: "missing_scan_target" };
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(45_000)]);
      let after = retryAfter(15);
      try {
        if (await context.canDispatch()) {
          const result = await check(job, signal, context.canDispatch);
          if (result) return result;
          if (result === null) after = new Date(now() + 15_000);
        }
      } catch {
        // A timeout, denied grant or partial result preserves the last complete list.
      }
      const { rows } = await sql.query(
        `select 1 from public.sandboxes where id=$1 and status <> 'deleted'
         and not application_secret_tainted and (status <> 'stopped' or expires_at > now())`,
        [job.sandbox_id],
      );
      return rows.length
        ? {
            status: "retry",
            after,
            commit: (tx) => rescheduleRecurringJob(tx, job, after),
          }
        : { status: "done" };
    },
  } satisfies JobKind;
}
