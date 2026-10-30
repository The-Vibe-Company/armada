import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type PluginContext, pluginEventInputSchema, pluginEventSchema } from "@armada/plugin-api";
import type { EventInput } from "./events.ts";
import { fold } from "./fold.ts";
import { BUNDLED_PLUGINS, type PluginCatalogEntry } from "./plugins/catalog.ts";
import { appConfigPath, loadPlugins } from "./plugins/index.ts";
import { writePluginStatus } from "./plugins/status.ts";
import { EventStore } from "./store.ts";

export interface DaemonOptions {
  databasePath: string;
  configPath?: string;
  catalog?: readonly PluginCatalogEntry[];
  secrets: PluginContext["secrets"];
  projects?: readonly { id: string; repository: string; programRoot?: string; phaseGroup?: string }[];
  log: PluginContext["log"];
}

/** The shell starts once and retains this registry for the lifetime of the daemon. */
export async function bootDaemon(options: DaemonOptions) {
  const configPath = options.configPath ?? appConfigPath();
  const store = new EventStore(options.databasePath);
  try {
    const plugins = await loadPlugins(
      {
        log: options.log,
        secrets: options.secrets,
        events: {
          append: async (event) =>
            pluginEventSchema.parse(store.append(pluginEventInputSchema.parse(event) as EventInput)),
          read: async (project, after) =>
            store.readSince(after, project).map((event) => pluginEventSchema.parse(event)),
          fold: async (project) => fold(store.readSince(0, project)),
        },
      },
      configPath,
      options.catalog,
      {
        tracker: {
          linear: {
            projects: Object.fromEntries(
              (options.projects ?? []).flatMap((p) =>
                p.programRoot
                  ? [[p.id, { programRoot: p.programRoot, phaseGroup: p.phaseGroup ?? "Agent phase" }]]
                  : [],
              ),
            ),
          },
        },
        forge: {
          github: {
            projects: Object.fromEntries((options.projects ?? []).map((p) => [p.id, { repository: p.repository }])),
          },
        },
      },
    );
    await mkdir(dirname(configPath), { recursive: true });
    const catalog = options.catalog ?? BUNDLED_PLUGINS;
    await writePluginStatus(configPath, catalog, plugins.plugins);
    return { ...plugins, configPath, catalog, store, close: () => store.close() };
  } catch (error) {
    store.close();
    throw error;
  }
}
