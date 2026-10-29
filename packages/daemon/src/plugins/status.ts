import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import type { PluginCatalogMetadata } from "./catalog.ts";
import { pluginStatusPath } from "./list.ts";
import type { PluginState } from "./loader.ts";

/** CLI reads the actual last boot, without importing/activating plugins a second time. */
export async function writePluginStatus(
  configPath: string,
  catalog: readonly PluginCatalogMetadata[],
  plugins: PluginState[],
): Promise<void> {
  const target = pluginStatusPath(configPath);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      JSON.stringify({ catalog: catalog.map(({ id, manifest }) => ({ id, manifest })), plugins }),
      { mode: 0o600 },
    );
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
