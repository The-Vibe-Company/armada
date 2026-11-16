import Link from "next/link";
import type { ReactNode } from "react";

/** Counts cover the filtered inventory; only the requested activity page is rendered. */
export function SandboxListTabs({
  rows,
  counts,
  tab,
  page,
  search,
}: {
  rows: { id: string; need: boolean; working: boolean; content: ReactNode }[];
  counts: Record<"all" | "mine" | "need" | "working" | "stopped" | "failed", number>;
  tab: "all" | "mine" | "need" | "working" | "stopped" | "failed";
  page: number;
  search: string;
}) {
  function href(activity: string, nextPage = 1) {
    const params = new URLSearchParams(search);
    params.set("activity", activity);
    params.delete("page");
    if (nextPage > 1) params.set("page", String(nextPage));
    return `?${params}`;
  }
  const pages = Math.max(1, Math.ceil(counts[tab] / 50));
  return (
    <section className="min-w-0 space-y-3">
      <section
        aria-label={
          tab === "need"
            ? "Waiting for you"
            : tab === "working"
              ? "Working"
              : tab === "mine"
                ? "Mine"
                : tab === "stopped"
                  ? "Stopped"
                  : tab === "failed"
                    ? "Failed"
                    : "All"
        }
        className="divide-y overflow-hidden rounded-[10px] border bg-card"
      >
        <div
          aria-hidden="true"
          className="hidden grid-cols-[minmax(0,2.8fr)_minmax(0,1.3fr)_minmax(0,.8fr)_minmax(0,1fr)_minmax(0,.9fr)_64px] gap-4 bg-muted/40 px-4 py-[9px] text-xs text-muted-foreground lg:grid"
        >
          <span>Task</span>
          <span>Agent</span>
          <span>Snapshot</span>
          <span>Owner</span>
          <span>Lifetime</span>
          <span />
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

export function SandboxActivityTabs({
  counts,
  tab,
  search,
}: {
  counts: Record<"all" | "mine" | "need" | "working" | "stopped" | "failed", number>;
  tab: "all" | "mine" | "need" | "working" | "stopped" | "failed";
  search: string;
}) {
  function href(activity: string) {
    const params = new URLSearchParams(search);
    params.set("activity", activity);
    params.delete("page");
    return `?${params}`;
  }
  return (
    <nav className="inline-flex flex-wrap gap-0.5 rounded-lg bg-muted p-[3px]" aria-label="Sandbox activity">
      {(
        [
          ["all", "All"],
          ["mine", "Mine"],
          ["working", "Working"],
          ["need", "Waiting for you"],
          ["stopped", "Stopped"],
          ["failed", "Failed"],
        ] as const
      ).map(([id, label]) => (
        <Link
          key={id}
          href={href(id)}
          aria-current={tab === id ? "page" : undefined}
          className={`inline-flex min-h-9 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium focus-visible:outline-2 ${tab === id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
        >
          {label}
          <span className="font-mono text-[11px] text-muted-foreground">{counts[id]}</span>
        </Link>
      ))}
    </nav>
  );
}
