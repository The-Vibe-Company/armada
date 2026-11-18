import type { SandboxPullRequest } from "@armada/core";
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
  .array(z.object({ url: z.string(), dir: z.string().min(1) }))
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
  pushes: Record<string, [string, string][]>;
  discovered: Identity[];
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

const maxBranches = 32;
const maxKnownPulls = 64;

// A local branch name or matching SHA alone also describes a checkout made by
// another sandbox. Only reflog records written by a push qualify for discovery.
const readPushes = `remote=$(git remote get-url --push --all origin) || exit 1
case "$remote" in
  "https://github.com/$2"|"https://github.com/$2.git"|"git@github.com:$2"|"git@github.com:$2.git"|"ssh://git@github.com/$2"|"ssh://git@github.com/$2.git") ;;
  *) exit 1 ;;
esac
logs=$(git reflog show --all --date=unix --format='%gD%x09%gs%x09%H') || exit 1
printf '%s\\n' "$logs" |
awk -v since="$1" -F '\\t' '$1 ~ /^refs\\/remotes\\/origin\\// && $2 == "update by push" {
    timestamp=$1
    sub(/^.*@\\{/, "", timestamp)
    if (timestamp+0 < since) next
    sub(/@\\{[^@]*\\}$/, "", $1)
    sub(/^refs\\/remotes\\/origin\\//, "", $1)
    if (!seen[$1]++) print $1 "\\t" $3
}'`;

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
      const branches = new Map<string, Map<string, string>>();
      for (const repo of configured) {
        signal.throwIfAborted();
        const remote = repoUrl.exec(repo.url)?.[1];
        const repository = remote?.toLowerCase();
        if (
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
        if (!row.active) continue;
        const result = await exec(row, {
          sandboxId: row.provider_sandbox_id,
          command: `set -- '${since}' '${remote}'; ${readPushes}`,
          cwd: `/home/user/${repo.dir}`,
          onlyIfRunning: true,
          timeoutSeconds: 5,
          signal,
        });
        if (result.detached || result.exitCode !== 0 || result.truncated || result.timedOut) return;
        const lines = result.stdout.trimEnd() ? result.stdout.trimEnd().split("\n") : [];
        for (const line of lines) {
          const [ref, sha] = line.split("\t");
          if (!ref || ref.length > 255 || /\s/.test(ref) || [...ref].some((char) => char.charCodeAt(0) < 32)) return;
          if (!sha || !/^[a-f0-9]{40}$/.test(sha)) return;
          names.set(ref, sha);
        }
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
        )
          return;
        const identity = { repository, number };
        numbers.set(urlFor(identity), identity);
      }
      const branchCount = [...branches.values()].reduce((sum, refs) => sum + refs.size, 0);
      if (branchCount > maxBranches || numbers.size > maxKnownPulls) return;
      const found = new Map<string, SandboxPullRequest>();
      let complete = true;
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
        async function get(repository: string, path: string) {
          if (!repoName.test(repository) || !branches.has(repository))
            throw Error("Repository is outside the sandbox grant.");
          // A large scan costs capacity from subsequent scans, even on failure.
          next = Math.max(next, Date.now() + ++requests * 1000);
          const response = await request(`https://api.github.com/repos/${repository}/pulls${path}`, {
            signal,
            redirect: "error",
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/vnd.github+json",
            },
          });
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
        for (const { repository, number } of numbers.values()) {
          const pull = githubPull.parse(await get(repository, `/${number}`));
          if (pull.number !== number) return;
          record(repository, pull);
        }
        for (const [headRepository, refs] of branches) {
          for (const [ref, sha] of refs) {
            const params = new URLSearchParams({
              state: "all",
              head: `${headRepository.split("/")[0]}:${ref}`,
              per_page: "100",
            });
            let matched = false;
            const batch = await Promise.allSettled(
              [...branches.keys()].map(async (repository) => ({
                repository,
                pulls: z
                  .array(githubPull)
                  .max(100)
                  .parse(await get(repository, `?${params}`)),
              })),
            );
            for (const result of batch) {
              if (result.status === "rejected") throw result.reason;
              const { repository, pulls } = result.value;
              for (const pull of pulls) {
                if (pull.head.repo?.full_name.toLowerCase() !== headRepository || pull.head.ref !== ref) continue;
                if (pull.head.sha === sha) {
                  const identity = { repository, number: pull.number };
                  discovered.set(urlFor(identity), identity);
                  record(repository, pull);
                  matched = true;
                } else if (pull.state === "open") {
                  // A moved open head blocks stopping without becoming work of this sandbox.
                  complete = false;
                }
              }
            }
            complete &&= matched;
          }
        }
      }
      signal.throwIfAborted();
      const list = [...found.values()];
      const proof =
        row.active && row.launch_authorized && complete && list.length > 0 && list.every((pr) => pr.state === "merged")
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
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
      running = check(deadline)
        .catch(() => {})
        .finally(() => {
          running = undefined;
        });
      return false;
    },
  };
}
