"use client";

import { useMemo } from "react";
import { dayIn } from "@/lib/activity-view";
import { type OverviewItem, overviewItems } from "@/lib/coordinator-view";
import { useFleet, useNow, useShell } from "./context";

/**
 * The overview's lines (lib/coordinator-view.ts), as the sidebar and the
 * overview count them. "Today" is the viewer's day by the clock: a quiet
 * fleet, whose overview does not change, still turns the page at midnight.
 */
export function useOverviewItems(): OverviewItem[] {
  const { overview } = useFleet();
  const { zone } = useShell();
  const now = useNow();
  const day = dayIn(new Date(now).toISOString(), zone);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the lines change with the day, not with each second of `now`.
  return useMemo(() => overviewItems(overview, { now, zone }), [overview, zone, day]);
}
