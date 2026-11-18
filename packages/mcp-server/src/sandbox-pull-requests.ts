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
  head: z.object({
    ref: z.string().min(1),
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
});

type Report = { prNumber?: number; prUrl?: string };
type Identity = { repository: string; number: number };
type Scan = {
  // Per repository and branch, every pushed SHA, newest first.
  pushes: Record<string, [string, string[]][]>;
  discovered: Identity[];
  // Sticky: once a push may have escaped the ledger (a ledger gap, a reflog
  // push it lacks, or a missing hook), coverage is unprovable.
  untracked?: true;
  // Per repository and checkout directory, each branch's latest pushed SHA as
  // that checkout last read it. Kept for a checkout a later grant no longer lists.
  heads?: Record<string, Record<string, Record<string, string>>>;
};
type Target = {
  id: string;
  owner_id: string;
  provider: "boat" | "modal" | "docker";
  provider_sandbox_id: string;
  harness: "codex" | "claude" | "opencode";
  runtime: boolean;
  active: boolean;
  launch_authorized: boolean;
  created_at: string;
  lifecycle_generation: string;
  task_prompt_id: string | null;
  connection_epoch: string;
  github_id: string;
  membership_epoch: string;
  repositories: unknown;
  repository_dir: string | null;
  pull_request_scan: Scan | null;
  pull_request_reports: Record<string, Report>;
};

const launchBranch = /^(?!-)[A-Za-z0-9._/-]{1,255}$/;
const maxBranches = 32;
const maxKnownPulls = 64;
const maxPushesPerBranch = 16;

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

export function createSandboxPullRequests(
  sql: Sql,
  github: GitHubResolveDeps,
  exec: (target: Target, request: ExecRequest) => Promise<ExecResult>,
) {
  let next = 0;
  let running: Promise<void> | undefined;
  async function check(signal: AbortSignal) {
    // Claim with a durable failure backoff. Reconciliation cannot stop from the
    // previous proof while a new check is unresolved.
    const row = (
      await sql.query<Target>(
        `with due as (
          select s.id,c.connection_epoch,c.github_id,e.epoch as membership_epoch,grant_row.repositories,grant_row.priority>0 as launch_authorized
          from public.sandboxes s
          join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
          join public.mcp_actor_epochs e on e.org_id=m.org_id and e.user_id=m.user_id
          join public.github_connections c on c.user_id=s.owner_id and c.revoked_at is null
          join lateral (
            select repositories,priority from (
              select s.pull_request_source->'repositories' as repositories, 3 as priority, 0::bigint as revision
              where s.pull_request_source->>'connectionEpoch'=c.connection_epoch::text
              union all
              select binding->'repositories', 2, revision
              from public.runtime_github_capabilities
              where sandbox_id=s.id and delivered_at is not null
                and binding->>'connectionEpoch'=c.connection_epoch::text
                and binding->>'membershipEpoch'=e.epoch::text
              union all
              select binding->'identity'->'repositories', 1, revision from public.github_runtime_capabilities
              where sandbox_id=s.id and binding->'identity'->>'connectionEpoch'=c.connection_epoch::text
                and binding->'identity'->>'membershipEpoch'=e.epoch::text
              union all
              select jsonb_build_array(s.resource_project), 0, 0::bigint
              where s.provider<>'docker' and s.pull_request_source is null and s.resource_project is not null
            ) grants order by priority desc, revision desc limit 1
          ) grant_row on true
          where ((s.status in ('ready','running') and s.stop_requested_at is null)
              or (s.status='stopped' and (s.pull_request_scan is not null or s.pull_request_reports<>'{}'::jsonb)))
            and s.activity_lease_id is null and not s.application_secret_tainted
            and s.expires_at>now() and s.pull_request_check_after<=now()
          order by s.pull_request_check_after,s.id limit 1 for update of s skip locked
        )
        update public.sandboxes s set pull_request_check_after=now()+interval '15 minutes',
          pull_request_merge_proof=null from due where s.id=due.id
        returning s.id,s.owner_id,s.provider::text,s.provider_sandbox_id,s.harness::text,
          s.status in ('ready','running') as active,
          (s.boat_runtime or s.runtime_transport is not distinct from 'dialout' or s.provider='docker') as runtime,
          s.created_at::text,s.lifecycle_generation::text,s.task_prompt_id,due.connection_epoch::text,
          due.github_id::text,due.membership_epoch::text,due.repositories,due.launch_authorized,s.repository_dir,s.pull_request_scan,s.pull_request_reports`,
      )
    ).rows[0];
    if (!row) return;
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
        const result = await exec(row, {
          sandboxId: row.provider_sandbox_id,
          // The launch branch counts as integrated work; without a usable name
          // the reader falls back to origin/HEAD.
          command: `set -- '${since}' '${remote}' '${repo.branch && launchBranch.test(repo.branch) ? repo.branch : ""}'; ${readPushes}`,
          cwd: `/home/user/${repo.dir}`,
          onlyIfRunning: true,
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
          await sql.query(
            `update public.sandboxes set pull_request_merge_proof=null,
              pull_request_scan=jsonb_set(coalesce(pull_request_scan,'{"pushes":{},"discovered":[]}'::jsonb),'{untracked}','true'::jsonb)
             where id=$1`,
            [row.id],
          );
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
      const claim = await sql.query(
        `update public.sandboxes set pull_request_scan=$2::text::jsonb
         where id=$1 and lifecycle_generation=$3 and (status='stopped' or stop_requested_at is null)
           and activity_lease_id is null returning id`,
        [row.id, JSON.stringify(scan), row.lifecycle_generation],
      );
      if (!claim.rows.length) return;
      const numbers = new Map<string, Identity>();
      const discovered = new Map<string, Identity>();
      const urlFor = ({ repository, number }: Identity) => `https://github.com/${repository}/pull/${number}`;
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
      // Dropping an older push could hide its closed PR, so too many is incomplete.
      if (
        branchCount > maxBranches ||
        numbers.size > maxKnownPulls ||
        unresolved.size > maxPushesPerBranch ||
        [...lookups.values()].some((refs) =>
          [...refs.values()].some(
            ({ shas, attempts }) => shas.length > maxPushesPerBranch || attempts.length > maxPushesPerBranch,
          ),
        )
      )
        return;
      const found = new Map<string, SandboxPullRequest>();
      const checkedAt = new Date().toISOString();
      if (numbers.size || branchCount) {
        const request = github.fetch ?? fetch;
        const access = await resolveGitHubAccess(
          {
            ...github,
            caller: "managed_runtime",
            fetch: Object.assign(
              (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
                request(input, { ...init, signal }),
              { preconnect: request.preconnect },
            ),
          },
          row.owner_id,
        );
        if (
          access.status !== "connected" ||
          String(access.identity.id) !== row.github_id ||
          access.connectionEpoch !== row.connection_epoch
        )
          return;
        const token = access.token;
        let requests = 0;
        async function get(repository: string, path: string, missing = false) {
          if (!repoName.test(repository) || !branches.has(repository))
            throw Error("Repository is outside the sandbox grant.");
          // A large scan costs capacity from subsequent scans, even on failure.
          next = Math.max(next, Date.now() + ++requests * 1000);
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
          if (!response.ok || response.headers.get("link")?.includes('rel="next"'))
            throw Error("Incomplete pull request observation.");
          return response.json();
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
                named = true;
                if (shas.includes(pull.head.sha)) {
                  // A PR at any pushed commit is this sandbox's work, so an
                  // earlier closed-unmerged PR still vetoes the stop.
                  const identity = { repository, number: pull.number };
                  discovered.set(urlFor(identity), identity);
                  record(repository, pull);
                  if (latest.has(pull.head.sha)) matched.add(pull.head.sha);
                } else if (pull.state === "open" || (attempts.includes(pull.head.sha) && !pull.merged_at)) {
                  // A moved open head blocks stopping without becoming work of
                  // this sandbox. So does an unmerged PR at an unconfirmed
                  // attempt, which may be a push whose result was lost; a merged
                  // PR at a rejected attempt is neither.
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
      const proof =
        row.active &&
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
      await sql.query(
        `update public.sandboxes s set pull_requests=$2::text::jsonb,pull_request_merge_proof=$3::text::jsonb,
          pull_request_check_after=now()+case when s.status='stopped' then interval '30 minutes' else interval '5 minutes' end,
          pull_request_scan=$9::text::jsonb
          where s.id=$1 and s.lifecycle_generation=$4 and s.task_prompt_id is not distinct from $5
            and s.pull_request_reports=$6::text::jsonb and s.activity_lease_id is null
            and (s.status='stopped' or (s.status in ('ready','running') and s.stop_requested_at is null))
            and exists(select 1 from public.github_connections c where c.user_id=s.owner_id
              and c.revoked_at is null and c.connection_epoch=$7)
            and exists(select 1 from public.mcp_actor_epochs e join public.members m
              on m.org_id=e.org_id and m.user_id=e.user_id
              where e.org_id=s.org_id and e.user_id=s.owner_id and e.epoch=$8)`,
        [
          row.id,
          JSON.stringify(list),
          JSON.stringify(proof),
          row.lifecycle_generation,
          row.task_prompt_id,
          JSON.stringify(row.pull_request_reports),
          row.connection_epoch,
          row.membership_epoch,
          JSON.stringify({ ...scan, discovered: [...discovered.values()] }),
        ],
      );
    } catch {
      // A timeout, denied grant or partial result preserves the last complete list.
    }
  }
  return {
    async drain() {
      await running;
    },
    async reconcileOne(signal: AbortSignal) {
      if (running || Date.now() < next) return false;
      next = Date.now() + 15_000;
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
      running = check(deadline)
        .catch(() => {})
        .finally(() => {
          running = undefined;
        });
      return false;
    },
  };
}
