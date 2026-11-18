import type { SandboxPullRequest } from "@armada/core";
import { GitPullRequestIcon } from "lucide-react";
import { parsePullRequests } from "@/lib/pull-requests";
import { TONE_BADGE } from "@/lib/status-tone";
import { cn } from "@/lib/utils";

const STATE_LOOK: Record<SandboxPullRequest["state"], { label: string; tone: string }> = {
  open: { label: "Open", tone: TONE_BADGE.info },
  merged: { label: "Merged", tone: TONE_BADGE.success },
  closed: { label: "Closed", tone: TONE_BADGE.neutral },
};

/** The sandbox's confirmed pull requests: each links to GitHub with its last observed state. Nothing when none. */
export function PullRequestList({
  pullRequests,
  className,
}: {
  pullRequests: readonly SandboxPullRequest[] | null | undefined;
  className?: string;
}) {
  if (!pullRequests?.length) return null;
  return (
    <ul data-pull-requests className={cn("space-y-1 text-xs", className)} aria-label="Pull requests">
      {pullRequests.map((pr) => (
        <li key={pr.url} data-pull-request={pr.state} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            title={pr.headBranch}
            className="relative z-10 inline-flex items-center gap-1 font-medium underline underline-offset-4"
          >
            <GitPullRequestIcon aria-hidden="true" className="size-3" />
            {pr.repository}#{pr.number}
          </a>
          <span
            className={cn(
              "inline-flex items-center rounded-md border px-1.5 py-0 font-medium whitespace-nowrap",
              STATE_LOOK[pr.state].tone,
            )}
          >
            {STATE_LOOK[pr.state].label}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The detail page's section: the stored list, validated before display. Nothing when none is confirmed. */
export function PullRequestSection({ value }: { value: unknown }) {
  const pullRequests = parsePullRequests(value);
  if (!pullRequests?.length) return null;
  return (
    <section className="space-y-3 text-sm" data-pull-request-section>
      <h2 className="text-xs font-medium text-muted-foreground">Pull requests</h2>
      <PullRequestList pullRequests={pullRequests} className="text-sm" />
    </section>
  );
}
