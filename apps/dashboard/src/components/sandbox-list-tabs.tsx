import { BoxesIcon, CheckCircle2Icon, SearchXIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Empty } from "@/components/page-header";
import { type SandboxListRowItem, SandboxListRows } from "@/components/sandbox-list";
import { Button } from "@/components/ui/button";
import type { SandboxActivity } from "@/lib/sandbox-activity";
import { cn } from "@/lib/utils";

const ACTIVITY_LABELS = {
  all: "All",
  active: "Active",
  need: "Waiting",
  stopped: "Stopped",
  failed: "Failed",
} satisfies Record<SandboxActivity, string>;

const PAGE_SIZE = 50;

export const sandboxRowGrid =
  "min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-x-3 px-4 md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.05fr)_minmax(0,1.15fr)_minmax(0,1.05fr)_minmax(0,0.85fr)_36px]";

const EMPTY_COPY: Record<SandboxActivity, { title: string; body: string }> = {
  need: { title: "Nothing waiting for you", body: "All caught up — no sandboxes are waiting on your reply." },
  active: { title: "No active sandboxes", body: "Nothing is starting or running right now." },
  stopped: {
    title: "No stopped sandboxes",
    body: "Stopped and paused sandboxes stay retained here once work pauses or ends.",
  },
  failed: { title: "No failed sandboxes", body: "No sandboxes have failed in this view." },
  all: { title: "No sandboxes in this view", body: "Try a different filter or return to the first page." },
};

/** Counts cover the filtered inventory; only the requested activity page is rendered. */
export function SandboxListTabs({
  rows,
  counts,
  tab,
  page,
  search,
  filtered = false,
  launchAction,
}: {
  rows: SandboxListRowItem[];
  counts: Record<SandboxActivity, number>;
  tab: SandboxActivity;
  page: number;
  search: string;
  filtered?: boolean;
  launchAction?: ReactNode;
}) {
  function href(activity: SandboxActivity, nextPage = 1) {
    const params = new URLSearchParams(search);
    if (activity === "all") params.delete("activity");
    else params.set("activity", activity);
    params.delete("page");
    if (nextPage > 1) params.set("page", String(nextPage));
    return params.size ? `?${params}` : "/sandboxes";
  }
  const totalInTab = counts[tab];
  const pages = Math.max(1, Math.ceil(totalInTab / PAGE_SIZE));
  const rangeStart = rows.length ? (page - 1) * PAGE_SIZE + 1 : 0;
  const rangeEnd = rows.length ? Math.min(totalInTab, rangeStart + rows.length - 1) : 0;

  if (!rows.length) {
    const empty = EMPTY_COPY[tab];
    const icon =
      tab === "need" || tab === "failed" ? <CheckCircle2Icon /> : tab === "all" ? <SearchXIcon /> : <BoxesIcon />;
    return (
      <section className="min-w-0 transition-opacity duration-150 ease-(--ease-out) motion-reduce:transition-none peer-data-[pending]:opacity-60">
        <Empty
          title={empty.title}
          icon={icon}
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              {tab === "active" && launchAction}
              {tab !== "all" && counts.all > 0 && (
                <Button variant="outline" asChild>
                  <Link
                    href={href("all")}
                  >{`View all ${counts.all} ${counts.all === 1 ? "sandbox" : "sandboxes"}`}</Link>
                </Button>
              )}
              {filtered && (
                <Button variant="outline" asChild>
                  <Link href="/sandboxes">Clear filters</Link>
                </Button>
              )}
            </div>
          }
        >
          {empty.body}
        </Empty>
      </section>
    );
  }

  return (
    <section className="min-w-0 space-y-3 transition-opacity duration-150 ease-(--ease-out) motion-reduce:transition-none peer-data-[pending]:opacity-60">
      <section aria-label={ACTIVITY_LABELS[tab]} className="divide-y rounded-xl border bg-card shadow-xs">
        <div
          aria-hidden="true"
          className={cn(
            sandboxRowGrid,
            "hidden h-9 rounded-t-xl bg-[var(--sunken)] text-xs font-medium text-muted-foreground md:grid",
          )}
        >
          <span>Sandbox</span>
          <span>Status</span>
          <span>Agent</span>
          <span>Environment</span>
          <span className="text-right">Cost / Time</span>
          <span className="sr-only">Actions</span>
        </div>
        <SandboxListRows rows={rows} />
      </section>
      {pages > 1 && (
        <nav aria-label="Sandbox pages" className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground tabular-nums">
            {`Showing ${rangeStart}–${rangeEnd} of ${totalInTab}`}
          </p>
          <div className="flex items-center gap-2">
            <PageButton label="Previous" href={page > 1 ? href(tab, page - 1) : null} />
            <PageButton label="Next" href={page < pages ? href(tab, page + 1) : null} />
          </div>
        </nav>
      )}
    </section>
  );
}

function PageButton({ label, href }: { label: string; href: string | null }) {
  return href ? (
    <Button variant="outline" size="sm" asChild>
      <Link href={href}>{label}</Link>
    </Button>
  ) : (
    <Button variant="outline" size="sm" disabled>
      {label}
    </Button>
  );
}
