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
  counts: { need: number; working: number; all: number };
  tab: "need" | "working" | "all";
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
      <nav className="flex gap-1 border-b" aria-label="Sandbox activity">
        {(
          [
            ["need", "Need you"],
            ["working", "Working"],
            ["all", "All"],
          ] as const
        ).map(([id, label]) => (
          <Link
            key={id}
            href={href(id)}
            aria-current={tab === id ? "page" : undefined}
            className={`inline-flex min-h-11 items-center border-b-2 px-3 text-sm focus-visible:outline-2 ${tab === id ? "border-foreground font-medium" : "border-transparent text-muted-foreground"}`}
          >
            {label} · {counts[id]}
          </Link>
        ))}
      </nav>
      <section
        aria-label={tab === "need" ? "Need you" : tab === "working" ? "Working" : "All"}
        className="divide-y rounded-xl border bg-card px-4"
      >
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
