"use client";

// The overview's line under its summary (THE-893): this week's merges, their
// median claim to merge and the change from last week, linking to /insights.
// Read on its own, once on load and every five minutes, never with the
// overview's poll: the numbers move by the hour, not the second.
import type { InsightsSummary } from "@armada/core/read";
import Link from "next/link";
import { useEffect, useState } from "react";
import { insightsHref } from "@/lib/insights-view";
import { useShell } from "../shell/context";

const EVERY_MS = 5 * 60_000;

export function InsightsLine() {
  const { t } = useShell();
  const [summary, setSummary] = useState<InsightsSummary | null>(null);
  useEffect(() => {
    let tag: string | null = null;
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
  return (
    <p className="ins-overview">
      {summary && (
        <Link href={insightsHref({ range: "7d" })} prefetch={false} className="ins-summary">
          {t.insights.overviewLine(summary, t.duration)}
        </Link>
      )}
    </p>
  );
}
