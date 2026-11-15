"use client";

import type { ReactNode } from "react";
import { useState } from "react";

/** Counts describe this already loaded inventory, never a second provider read. */
export function SandboxListTabs({
  rows,
}: {
  rows: { id: string; need: boolean; working: boolean; content: ReactNode }[];
}) {
  const [tab, setTab] = useState("need");
  const visible = rows.filter((row) => tab === "all" || (tab === "need" ? row.need : row.working));
  return (
    <section className="min-w-0 space-y-3">
      <div className="flex gap-1 border-b" role="tablist" aria-label="Sandbox activity">
        {(
          [
            ["need", "Need you", rows.filter((r) => r.need).length],
            ["working", "Working", rows.filter((r) => r.working).length],
            ["all", "All", rows.length],
          ] as const
        ).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`activity-${id}`}
            aria-controls="activity-panel"
            tabIndex={tab === id ? 0 : -1}
            aria-selected={tab === id}
            onKeyDown={(event) => {
              const ids = ["need", "working", "all"];
              const index = ids.indexOf(id);
              const next =
                event.key === "ArrowRight"
                  ? ids[(index + 1) % 3]
                  : event.key === "ArrowLeft"
                    ? ids[(index + 2) % 3]
                    : event.key === "Home"
                      ? ids[0]
                      : event.key === "End"
                        ? ids[2]
                        : null;
              if (next) {
                event.preventDefault();
                setTab(next);
                document.getElementById(`activity-${next}`)?.focus();
              }
            }}
            onClick={() => setTab(id)}
            className={`min-h-11 border-b-2 px-3 text-sm focus-visible:outline-2 ${tab === id ? "border-foreground font-medium" : "border-transparent text-muted-foreground"}`}
          >
            {label} · {count}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="activity-panel"
        aria-labelledby={`activity-${tab}`}
        aria-label={tab === "need" ? "Need you" : tab === "working" ? "Working" : "All"}
        className="divide-y rounded-xl border bg-card px-4"
      >
        {visible.map((row) => (
          <div key={row.id}>{row.content}</div>
        ))}
        {!visible.length && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {tab === "need" ? "Nothing needs you here." : "No sandboxes in this view."}
          </p>
        )}
      </div>
    </section>
  );
}
