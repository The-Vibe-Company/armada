import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  manifestSchema,
  type PluginConfig,
  type PluginContext,
  pluginEventInputSchema,
  pluginEventSchema,
} from "@armada/plugin-api";
import type { EventInput } from "./events.ts";
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
  onStarting?: (events: number) => void;
}

type ProjectSettings = Pick<DaemonProject, "id" | "repository"> & Partial<DaemonProject>;
function projectConfig(projects: readonly ProjectSettings[]): PluginConfig {
  return {
    tracker: {
      linear: {
        quotaProjects: projects.map((p) => p.id),
        projects: Object.fromEntries(
          projects.flatMap((p) =>
            p.programRoot && (p.tracker === undefined || p.tracker === "linear")
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
  const beforeStore = performance.now();
  const store = new EventStore(options.databasePath);
  let foldMs = 0;
  let storeMs = 0;
  const beforePlugins = performance.now();
  try {
    // Each project resumes from its stored fold snapshot: the splash counts the
    // rows appended since, and the warm-up writes the next snapshot.
    const projectIds = (options.projects ?? []).map((p) => p.id);
    options.onStarting?.(store.pending(projectIds));
    for (const id of projectIds) {
      const warmup = store.warm(id);
      foldMs += warmup.ms;
      if (warmup.ignored) options.log.info(`armadad: ${id} fold snapshot ignored (${warmup.ignored}); rebuilding`);
      options.log.info(
        `armadad: ${id} fold replayed: ${warmup.replayed} events after seq ${warmup.from} (${warmup.parsed} parsed) in ${warmup.ms.toFixed(0)} ms`,
      );
    }
    storeMs = performance.now() - beforeStore;
    const services = {
      log: options.log,
      secrets: options.secrets,
      events: {
        append: async (event: Parameters<PluginContext["events"]["append"]>[0]) =>
          pluginEventSchema.parse(store.append(pluginEventInputSchema.parse(event) as EventInput)),
        appendWith: async (
          project: string,
          build: (fold: unknown) => import("@armada/plugin-api").PluginEventInput[],
        ) =>
          store
            .appendWith(project, (tables) =>
              build(tables).map((event) => pluginEventInputSchema.parse(event) as EventInput),
            )
            .map((event) => pluginEventSchema.parse(event)),
        read: async (project: string, after: number) => {
          if (!Number.isSafeInteger(after) || after < 0)
            throw new Error("sequence must be a non-negative safe integer");
          const head = store.sequence;
          let cursor = after;
          const events = [];
          while (cursor < head) {
            // Page the SQLite read too: decoding the whole log before yielding
            // still delays the first fleet response behind background readers.
            await setImmediate();
            const page = store.readSince(cursor, project, 128);
            for (const event of page) {
              if (event.seq > head) return events;
              events.push(pluginEventSchema.parse(event));
            }
            if (page.length < 128) break;
            cursor = page.at(-1)!.seq;
          }
          return events;
        },
        fold: async (project: string) => store.fold(project),
      },
    };
    const plugins = await loadPlugins(services, configPath, options.catalog, projectConfig(options.projects ?? []));
    await mkdir(dirname(configPath), { recursive: true });
    const catalog = options.catalog ?? BUNDLED_PLUGINS;
    await writePluginStatus(configPath, catalog, plugins.plugins);
    return {
      ...plugins,
      timings: { storeMs, foldMs, pluginsMs: performance.now() - beforePlugins },
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
        const scoped = await loadPlugins(services, configPath, scopedCatalog, projectConfig([project]));
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
