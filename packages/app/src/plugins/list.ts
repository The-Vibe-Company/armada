import type { Plugin } from "@armada/protocol";

/** The seams in the plugin API's order (packages/plugin-api), as the screen names its groups. */
export const SEAM_GROUPS = [
  { seam: "runtime", label: "Runtimes" },
  { seam: "tracker", label: "Trackers" },
  { seam: "forge", label: "Forges" },
  { seam: "node", label: "Nodes" },
  { seam: "model", label: "Models" },
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
 * A row's state in a word and its colour: a change waits for the restart
 * (amber), loaded (green), refused at boot (red), off or not loaded (quiet).
 */
export function pluginState(plugin: Plugin): { word: string; ink: string } {
  if (plugin.restartRequired) return { word: "Restart to apply", ink: "text-amber" };
  if (!plugin.enabled) return { word: "Off", ink: "text-text-3" };
  if (plugin.loaded) return { word: "Loaded", ink: "text-green" };
  if (plugin.error !== undefined) return { word: "Refused", ink: "text-red" };
  return { word: "Not loaded", ink: "text-text-3" };
}
