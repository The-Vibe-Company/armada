import type { ArmadaPlugin } from "@armada/plugin-api";

export interface PluginCatalogMetadata {
  id: string;
  manifest: unknown;
}
export interface PluginCatalogEntry extends PluginCatalogMetadata {
  load(): Promise<ArmadaPlugin>;
}
export { BUNDLED_PLUGINS } from "./catalog.generated.ts";
