import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  manifestSchema,
  type PluginConfig,
  type PluginContext,
  pluginEventInputSchema,
  pluginEventSchema,
} from "@armada/plugin-api";
import type { EventInput } from "./events.ts";
import { fold } from "./fold.ts";
import { BUNDLED_PLUGINS, type PluginCatalogEntry } from "./plugins/catalog.ts";
import { appConfigPath, loadPlugins } from "./plugins/index.ts";
import { writePluginStatus } from "./plugins/status.ts";
import type { DaemonProject } from "./projects.ts";
import { EventStore } from "./store.ts";

export interface DaemonOptions {
  databasePath: string;
  configPath?: string;
  catalog?: readonly PluginCatalogEntry[];
  secrets: PluginContext["secrets"];
  projects?: readonly ProjectSettings[];
  log: PluginContext["log"];
}

type ProjectSettings = Pick<DaemonProject, "id" | "repository"> & Partial<DaemonProject>;
function projectConfig(projects: readonly ProjectSettings[]): PluginConfig {
  return {
    tracker: {
      linear: {
        projects: Object.fromEntries(
          projects.flatMap((p) =>
            p.programRoot
              ? [
                  [
                    p.id,
                    {
                      programRoot: p.programRoot,
                      phaseGroup: p.phaseGroup ?? "Agent phase",
                      ...(p.readyLabel ? { readyLabel: p.readyLabel } : {}),
                      ...(p.runtimeGroup ? { runtimeGroup: p.runtimeGroup } : {}),
                    },
                  ],
                ]
              : [],
          ),
        ),
      },
    },
    forge: { github: { projects: Object.fromEntries(projects.map((p) => [p.id, { repository: p.repository }])) } },
    node: {
      local: { projects: Object.fromEntries(projects.flatMap((p) => (p.root ? [[p.id, { root: p.root }]] : []))) },
    },
  };
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
      projectConfig(options.projects ?? []),
    );
    await mkdir(dirname(configPath), { recursive: true });
    const catalog = options.catalog ?? BUNDLED_PLUGINS;
    await writePluginStatus(configPath, catalog, plugins.plugins);
    return {
      ...plugins,
      configPath,
      catalog,
      store,
      async addProject(project: DaemonProject) {
        const scopedCatalog = catalog.filter((entry) => {
          const manifest = manifestSchema.safeParse(entry.manifest);
          return (
            manifest.success &&
            ["tracker", "forge", "node"].some(
              (seam) => Object.keys(manifest.data.contributions[seam as "tracker" | "forge" | "node"] ?? {}).length,
            )
          );
        });
        const scoped = await loadPlugins(
          {
            log: options.log,
            secrets: options.secrets,
            events: {
              append: async (event) =>
                pluginEventSchema.parse(store.append(pluginEventInputSchema.parse(event) as EventInput)),
              read: async (id, after) => store.readSince(after, id).map((event) => pluginEventSchema.parse(event)),
              fold: async (id) => fold(store.readSince(0, id)),
            },
          },
          configPath,
          scopedCatalog,
          projectConfig([project]),
        );
        const failed = scoped.plugins.find((p) => p.enabled && !p.loaded);
        if (failed) throw new Error(`Project provider ${failed.id} could not start`);
        plugins.registry.setProject(project.id, scoped.registry);
      },
      removeProject(project: string) {
        plugins.registry.removeProject(project);
      },
      close: () => store.close(),
    };
  } catch (error) {
    store.close();
    throw error;
  }
}
