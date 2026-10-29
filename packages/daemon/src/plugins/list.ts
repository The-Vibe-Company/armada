import { type PluginSetting, SEAMS } from "@armada/plugin-api";
import type { PluginCatalogMetadata } from "./catalog.ts";
import type { PluginState } from "./loader.ts";

export { appConfigPath } from "./config.ts";
export const pluginStatusPath = (configPath: string) => `${configPath}.plugins.json`;
export interface PluginBootStatus {
  catalog: PluginCatalogMetadata[];
  plugins: PluginState[];
}
export function parsePluginStatus(body: string): PluginBootStatus {
  const value = JSON.parse(body);
  if (!Array.isArray(value.catalog) || !Array.isArray(value.plugins))
    throw new Error("invalid daemon plugin status: restart the desktop app");
  return value;
}
export function describePlugin(entry: PluginCatalogMetadata): Omit<PluginState, "loaded"> {
  const manifest = entry.manifest as Record<string, unknown> | null;
  const contributions = manifest?.contributions as Record<string, object> | undefined;
  return {
    id: entry.id,
    version: typeof manifest?.version === "string" ? manifest.version : null,
    enabled: typeof manifest?.enabledByDefault === "boolean" ? manifest.enabledByDefault : true,
    contributions: SEAMS.flatMap((seam) => Object.keys(contributions?.[seam] ?? {}).map((kind) => `${seam}.${kind}`)),
  };
}
export function catalogList(
  catalog: readonly PluginCatalogMetadata[],
  settings: PluginSetting[],
  boot: readonly PluginState[] = [],
): (PluginState & { restartRequired: boolean })[] {
  return catalog.map((entry) => {
    const metadata = describePlugin(entry);
    const enabled = settings.find((s) => s.id === entry.id)?.enabled ?? metadata.enabled;
    const previous = boot.find((p) => p.id === entry.id);
    return {
      ...metadata,
      loaded: previous?.loaded ?? false,
      ...(previous?.error ? { error: previous.error } : {}),
      enabled,
      restartRequired: !previous || previous.enabled !== enabled,
    };
  });
}
export function renderPluginList(plugins: readonly (PluginState & { restartRequired?: boolean })[]): string {
  return (
    plugins
      .map((plugin) => {
        const state = `${plugin.enabled ? "enabled" : "disabled"}, ${plugin.loaded ? "loaded" : plugin.error ? `refused: ${plugin.error}` : "not loaded"}${plugin.restartRequired ? " (restart required)" : ""}`;
        return [
          `${plugin.id}@${plugin.version ?? "?"} ${state}`,
          ...plugin.contributions.map((c) => `  └─ ${c} ${state}`),
        ].join("\n");
      })
      .join("\n") + (plugins.length ? "\n" : "")
  );
}
