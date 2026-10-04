"use client";

import { useMemo } from "react";
import { type OverviewItem, overviewItems } from "@/lib/coordinator-view";
import { useFleet, useShell } from "./context";

/**
 * The overview's lines (lib/coordinator-view.ts), as the sidebar and the
 * overview count them. "Today" is the viewer's day when the overview was
 * built: the server's render and the browser's agree.
 */
export function useOverviewItems(): OverviewItem[] {
  const { overview } = useFleet();
  const { zone } = useShell();
  return useMemo(() => overviewItems(overview, { now: Date.parse(overview.generatedAt), zone }), [overview, zone]);
}
