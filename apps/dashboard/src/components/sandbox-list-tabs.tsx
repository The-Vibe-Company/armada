import Link from "next/link";
import type { ReactNode } from "react";
import type { SandboxActivity } from "@/lib/sandbox-activity";
import { cn } from "@/lib/utils";

const ACTIVITY_LABELS = {
  all: "All",
  active: "Active",
  need: "Waiting",
  stopped: "Stopped",
  failed: "Failed",
} satisfies Record<SandboxActivity, string>;

export const sandboxRowGrid =
  "min-w-0 grid-cols-[repeat(2,minmax(0,1fr))_auto] items-center gap-x-3 px-3 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,.8fr)_auto] md:px-4";

/** Counts cover the filtered inventory; only the requested activity page is rendered. */
export function SandboxListTabs({
  rows,
  counts,
  tab,
  page,
  search,
}: {
  rows: { id: string; content: ReactNode }[];
  counts: Record<SandboxActivity, number>;
  tab: SandboxActivity;
  page: number;
  search: string;
}) {
  function href(activity: SandboxActivity, nextPage = 1) {
    const params = new URLSearchParams(search);
    if (activity === "all") params.delete("activity");
    else params.set("activity", activity);
    params.delete("page");
    if (nextPage > 1) params.set("page", String(nextPage));
    return params.size ? `?${params}` : "/sandboxes";
  }
  const pages = Math.max(1, Math.ceil(counts[tab] / 50));
  return (
    <section className="min-w-0 space-y-3 transition-opacity duration-150 ease-(--ease-out) motion-reduce:transition-none peer-data-[pending]:opacity-60">
      <section aria-label={ACTIVITY_LABELS[tab]} className="divide-y overflow-hidden rounded-[10px] border bg-card">
        <div
          aria-hidden="true"
          className={cn(sandboxRowGrid, "hidden h-9 bg-muted/40 text-xs text-muted-foreground md:grid")}
        >
          <span>Sandbox</span>
          <span>Status</span>
          <span>Harness / Model</span>
          <span>Machine</span>
          <span className="text-right">Cost / Time</span>
          <span className="w-[72px] text-right">Actions</span>
        </div>
        {rows.map((row) => (
          <div key={row.id}>{row.content}</div>
        ))}
        {!rows.length && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {tab === "need" ? "Nothing needs you here." : "No sandboxes in this view."}
          </p>
        )}
      </section>
      {pages > 1 && (
        <nav aria-label="Sandbox pages" className="flex items-center justify-between gap-3 text-sm">
          {page > 1 ? (
            <Link className="inline-flex min-h-11 items-center underline" href={href(tab, page - 1)}>
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span>
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link className="inline-flex min-h-11 items-center underline" href={href(tab, page + 1)}>
              Next
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </section>
  );
}
