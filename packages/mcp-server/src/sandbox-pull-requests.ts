import {
  type ExecRequest,
  type ExecResult,
  type GitHubResolveDeps,
  resolveGitHubAccess,
  type Sql,
} from "@armada/core/server";
import { z } from "zod";

const repoName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const repoUrl = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i;
const prUrl = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/i;
const repos = z
  .array(z.object({ url: z.string(), dir: z.string().min(1) }))
  .min(1)
  .max(10);
const githubPull = z.object({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable(),
  head: z.object({ ref: z.string().min(1), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
});

type PullRequest = {
  repository: string;
  number: number;
  url: string;
  headBranch: string;
  state: "open" | "merged" | "closed";
  checkedAt: string;
};
type Report = { prNumber?: number; prUrl?: string };
type Target = {
  id: string;
  owner_id: string;
  provider: "boat" | "modal" | "docker";
  provider_sandbox_id: string;
  harness: "codex" | "claude" | "opencode";
  runtime: boolean;
  created_at: string;
  lifecycle_generation: string;
  task_prompt_id: string | null;
  connection_epoch: string;
  github_id: string;
  membership_epoch: string;
  repositories: unknown;
  pull_requests: PullRequest[];
  pull_request_reports: Record<string, Report>;
};

const maxBranches = 16;

// A local branch name or matching SHA alone also describes a checkout made by
// another sandbox. Only reflog records written by a push qualify for discovery.
const readPushes = `remote=$(git remote get-url --push --all origin) || exit 1
case "$remote" in
  "https://github.com/$2"|"https://github.com/$2.git"|"git@github.com:$2"|"git@github.com:$2.git") ;;
  *) exit 1 ;;
esac
logs=$(git reflog show --all --date=unix --format='%gD%x09%gs') || exit 1
printf '%s\\n' "$logs" |
awk -v since="$1" -F '\\t' '$1 ~ /^refs\\/remotes\\/origin\\// && $2 == "update by push" {
    timestamp=$1
    sub(/^.*@\\{/, "", timestamp)
    if (timestamp+0 < since) next
    sub(/@\\{[^@]*\\}$/, "", $1)
    sub(/^refs\\/remotes\\/origin\\//, "", $1)
    if (!seen[$1]++) print $1
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
          select s.id,c.connection_epoch,c.github_id,e.epoch as membership_epoch,grant_row.repositories
          from public.sandboxes s
          join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
          join public.mcp_actor_epochs e on e.org_id=m.org_id and e.user_id=m.user_id
          join public.github_connections c on c.user_id=s.owner_id and c.revoked_at is null
          join lateral (
            select repositories from (
              select binding->'repositories' as repositories, revision
              from public.runtime_github_capabilities
              where sandbox_id=s.id and delivered_at is not null
                and binding->>'connectionEpoch'=c.connection_epoch::text
                and binding->>'membershipEpoch'=e.epoch::text
              union all
              select binding->'identity'->'repositories', revision from public.github_runtime_capabilities
              where sandbox_id=s.id and binding->'identity'->>'connectionEpoch'=c.connection_epoch::text
                and binding->'identity'->>'membershipEpoch'=e.epoch::text
            ) grants order by revision desc limit 1
          ) grant_row on true
          where s.status in ('ready','running') and s.stop_requested_at is null
            and s.activity_lease_id is null and not s.application_secret_tainted
            and s.expires_at>now() and s.pull_request_check_after<=now()
          order by s.pull_request_check_after,s.id limit 1 for update of s skip locked
        )
        update public.sandboxes s set pull_request_check_after=now()+interval '15 minutes',
          pull_request_merge_proof=null from due where s.id=due.id
        returning s.id,s.owner_id,s.provider::text,s.provider_sandbox_id,s.harness::text,
          (s.boat_runtime or s.runtime_transport is not distinct from 'dialout' or s.provider='docker') as runtime,
          s.created_at::text,s.lifecycle_generation::text,s.task_prompt_id,due.connection_epoch::text,
          due.github_id::text,due.membership_epoch::text,due.repositories,s.pull_requests,s.pull_request_reports`,
      )
    ).rows[0];
    if (!row) return;
    try {
      const configured = repos.parse(row.repositories);
      const branches = new Map<string, Set<string>>();
      for (const repo of configured) {
        signal.throwIfAborted();
        const repository = repoUrl.exec(repo.url)?.[1]?.toLowerCase();
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
        const result = await exec(row, {
          sandboxId: row.provider_sandbox_id,
          command: `set -- '${since}' '${repoUrl.exec(repo.url)?.[1]}'; ${readPushes}`,
          cwd: `/home/user/${repo.dir}`,
          onlyIfRunning: true,
          timeoutSeconds: 5,
          signal,
        });
        if (result.detached || result.exitCode !== 0 || result.truncated || result.timedOut) return;
        const refs = result.stdout.trimEnd() ? result.stdout.trimEnd().split("\n") : [];
        const names = branches.get(repository) ?? new Set<string>();
        for (const ref of refs) {
          if (!ref || ref.length > 255 || /\s/.test(ref) || [...ref].some((char) => char.charCodeAt(0) < 32)) return;
          names.add(ref);
        }
        branches.set(repository, names);
      }
      const numbers = new Map<string, { repository: string; number: number }>();
      for (const pr of row.pull_requests) numbers.set(pr.url, pr);
      for (const report of Object.values(row.pull_request_reports)) {
        const match = report.prUrl ? prUrl.exec(report.prUrl) : undefined;
        const repository = match?.[1]?.toLowerCase() ?? (branches.size === 1 ? [...branches.keys()][0] : undefined);
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
        numbers.set(`https://github.com/${repository}/pull/${number}`, { repository, number });
      }
      if ([...branches.values()].reduce((sum, refs) => sum + refs.size, numbers.size) > maxBranches) return;
      const found = new Map<string, PullRequest>();
      const checkedAt = new Date().toISOString();
      if (numbers.size || [...branches.values()].some((refs) => refs.size)) {
        const request = github.fetch ?? fetch;
        const access = await resolveGitHubAccess(
          {
            ...github,
            caller: "managed_runtime",
            fetch: (input, init) => request(input, { ...init, signal }),
          },
          row.owner_id,
        );
        if (access.status !== "connected" || String(access.identity.id) !== row.github_id) return;
        async function get(repository: string, path: string) {
          if (!repoName.test(repository) || !branches.has(repository))
            throw Error("Repository is outside the sandbox grant.");
          const response = await request(`https://api.github.com/repos/${repository}/pulls${path}`, {
            signal,
            redirect: "error",
            headers: {
              authorization: `Bearer ${access.status === "connected" ? access.token : ""}`,
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
        for (const [repository, refs] of branches) {
          for (const ref of refs) {
            const params = new URLSearchParams({
              state: "all",
              head: `${repository.split("/")[0]}:${ref}`,
              per_page: "30",
            });
            const pulls = z
              .array(githubPull)
              .max(30)
              .parse(await get(repository, `?${params}`));
            for (const pull of pulls) {
              if (pull.head.repo?.full_name.toLowerCase() === repository && pull.head.ref === ref)
                record(repository, pull);
            }
          }
        }
      }
      signal.throwIfAborted();
      const list = [...found.values()];
      const proof =
        list.length > 0 && list.every((pr) => pr.state === "merged")
          ? {
              checkedAt,
              connectionEpoch: row.connection_epoch,
              membershipEpoch: row.membership_epoch,
              generation: row.lifecycle_generation,
              promptId: row.task_prompt_id,
            }
          : null;
      await sql.query(
        `update public.sandboxes s set pull_requests=$2::jsonb,pull_request_merge_proof=$3::jsonb,
          pull_request_check_after=now()+interval '5 minutes'
          where s.id=$1 and s.lifecycle_generation=$4 and s.task_prompt_id is not distinct from $5
            and s.pull_request_reports=$6::jsonb and s.activity_lease_id is null
            and s.stop_requested_at is null
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
