import type { Plugin } from "@armada/protocol";

/** The seams as Settings' Providers names its groups (THE-2069): the coordinator's models first. */
const SEAM_GROUPS = [
  { seam: "model", label: "Models" },
  { seam: "runtime", label: "Runtimes" },
  { seam: "tracker", label: "Trackers" },
  { seam: "forge", label: "Forges" },
  { seam: "node", label: "Nodes" },
] as const;
const OTHER = { seam: "other", label: "Other" } as const;

/**
 * One group per seam, in that order, then "Other" for a plugin that
 * contributes to no known seam; a plugin is listed once, under the first seam
 * it contributes to. Empty groups are left out.
 */
export function pluginGroups(plugins: readonly Plugin[]): { seam: string; label: string; plugins: Plugin[] }[] {
  const order = SEAM_GROUPS.map((g) => g.seam as string);
  const seamOf = (plugin: Plugin) =>
    order.find((seam) => plugin.contributions.some((c) => c.seam === seam)) ?? OTHER.seam;
  return [...SEAM_GROUPS, OTHER]
    .map((group) => ({ ...group, plugins: plugins.filter((p) => seamOf(p) === group.seam) }))
    .filter((group) => group.plugins.length > 0);
}

/** The facts line's numbers. */
export function pluginCounts(plugins: readonly Plugin[]) {
  return {
    total: plugins.length,
    enabled: plugins.filter((p) => p.enabled).length,
    loaded: plugins.filter((p) => p.loaded).length,
    refused: plugins.filter((p) => p.error !== undefined).length,
    pending: plugins.filter((p) => p.restartRequired).length,
  };
}

/**
 * A row's state in a word, its ink and its dot: a change waits for the
 * restart (amber), loaded (green), refused at boot (red), off or not loaded (quiet).
 */
export function pluginState(plugin: Plugin): { word: string; ink: string; dot: string } {
  if (plugin.restartRequired) return { word: "Restart to apply", ink: "text-amber", dot: "bg-amber" };
  if (!plugin.enabled) return { word: "Off", ink: "text-text-3", dot: "bg-text-3" };
  if (plugin.loaded) return { word: "Loaded", ink: "text-green", dot: "bg-green" };
  if (plugin.error !== undefined) return { word: "Refused", ink: "text-red", dot: "bg-red" };
  return { word: "Not loaded", ink: "text-text-3", dot: "bg-text-3" };
}
