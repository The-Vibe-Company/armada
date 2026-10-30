// The panel's Pull requests (THE-2085): the open pull requests of the tickets
// in flight, each with its number, its ticket, its title and its checks as the
// fold reads them. Merging from here is THE-2086's.
import { TONE } from "@/components/fleet/FleetList";
import type { FleetItem } from "@/fleet/overview";
import type { FleetState, FoldedPullRequest } from "@/fleet/state";
import { cn } from "@/lib/utils";
import { sessionHref } from "@/session/route";

const CHECKS: Record<FoldedPullRequest["ci"], { words: string; dot: string }> = {
  failure: { words: "Checks failing", dot: TONE.blocked.bg },
  pending: { words: "Checks running", dot: TONE.you.bg },
  success: { words: "Checks passed", dot: TONE.ready.bg },
  none: { words: "No checks", dot: TONE.merged.bg },
};

export interface OpenPullRequest extends FoldedPullRequest {
  title: string;
}

/** The open pull requests of the tickets in flight, in the fold's order. */
export function openPullRequests(state: FleetState, items: readonly FleetItem[]): OpenPullRequest[] {
  const flying = new Map(items.filter((i) => i.group !== "merged").map((i) => [i.ticket, i.title]));
  return state.pullRequests.flatMap((p) => {
    const title = flying.get(p.ticket);
    return p.state === "open" && title !== undefined ? [{ ...p, title }] : [];
  });
}

export function PullRequests({ prs, repository }: { prs: readonly OpenPullRequest[]; repository: string }) {
  if (!prs.length) return <p className="m-0 px-4 py-3 text-body text-text-3">No pull request open.</p>;
  return (
    <ul aria-label="Open pull requests" className="m-0 list-none p-0 pb-2">
      {prs.map((p) => {
        const checks = CHECKS[p.ci];
        return (
          <li key={p.number} data-pr-row={p.number} className="flex flex-col border-line border-b px-4 py-2">
            <span className="flex min-w-0 items-baseline gap-2">
              <a
                href={`https://github.com/${repository}/pull/${p.number}`}
                target="_blank"
                rel="noreferrer"
                className="flex-none font-mono text-meta text-text hover:underline"
              >
                #{p.number}
              </a>
              <a href={sessionHref(p.ticket)} className="flex-none font-mono text-meta text-text-2 hover:text-text">
                {p.ticket}
              </a>
              <span className="min-w-0 truncate text-sub text-text">{p.title}</span>
            </span>
            <span className="mt-px flex items-center gap-2 text-body text-text-2" data-checks={p.ci}>
              <span aria-hidden className={cn("size-1.75 rounded-full", checks.dot)} />
              {checks.words}
              {p.conflicting && <span className="text-red">· Conflicts with main</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
