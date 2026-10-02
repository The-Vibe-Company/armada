"use client";

// The overview's weekly figure (THE-893), a chip of its status (THE-899):
// this week's merges and the change from last week, linking to /insights,
// its full line (with the median claim to merge) as its title.
// Rendered with the page (THE-892), then read on its own every five minutes,
// never with the overview's poll: the numbers move by the hour, not the second.
import type { InsightsSummary } from "@armada/core/read";
import { useEffect, useState } from "react";
import { type InsightsLineReading, insightsHref } from "@/lib/insights-view";
import { Stat } from "../page";
import { useShell } from "../shell/context";

const EVERY_MS = 5 * 60_000;

export function InsightsLine({ initial = null }: { initial?: InsightsLineReading | null }) {
  const { t } = useShell();
  const [summary, setSummary] = useState<InsightsSummary | null>(initial?.body.live ? initial.body.summary : null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read from the page's first reading on, once.
  useEffect(() => {
    let tag: string | null = initial?.tag ?? null;
    let stopped = false;
    const read = async () => {
      try {
        const res = await fetch("/api/fleet/insights?range=7d", {
          cache: "no-store",
          headers: tag ? { "If-None-Match": tag } : {},
        });
        if (stopped || res.status === 304 || !res.ok) return;
        tag = res.headers.get("etag");
        const body = (await res.json()) as { live: boolean; summary: InsightsSummary };
        setSummary(body.live ? body.summary : null);
      } catch {
        // The line is a nicety: the overview stands without it.
      }
    };
    void read();
    const timer = setInterval(read, EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  if (!summary) return null;
  const change = summary.change === null ? null : Math.round(summary.change * 100);
  return (
    <span title={t.insights.overviewLine(summary, t.duration)}>
      <Stat href={insightsHref({ range: "7d" })} prefetch={false}>
        {t.status.stats.week} <b>{summary.merged}</b> {t.status.stats.merged}
        {change !== null && (
          <span className={change < 0 ? "ui-trend is-down" : "ui-trend"}>
            {change > 0 ? "↑" : change < 0 ? "↓" : "→"} {Math.abs(change)}%
          </span>
        )}
      </Stat>
    </span>
  );
}
