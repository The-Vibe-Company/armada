import type { PluginConfig, PluginContext } from "@armada/plugin-api";
import { BUNDLED_PLUGINS } from "../../src/plugins/catalog.ts";
import { PluginRegistry } from "../../src/plugins/registry.ts";
import type { EventStore } from "../../src/store.ts";

/** Compose the bundled modules with their public context; no daemon provider construction. */
export async function readerRegistry(
  store: EventStore,
  projects: readonly { id: string; repository: string; programRoot?: string; phaseGroup?: string }[],
  secrets: PluginContext["secrets"] = { get: async () => "synthetic-key" },
) {
  const registry = new PluginRegistry();
  const config: PluginConfig = {
    tracker: {
      linear: {
        projects: Object.fromEntries(
          projects.flatMap((p) =>
            p.programRoot ? [[p.id, { programRoot: p.programRoot, phaseGroup: p.phaseGroup ?? "Agent phase" }]] : [],
          ),
        ),
      },
    },
    forge: { github: { projects: Object.fromEntries(projects.map((p) => [p.id, { repository: p.repository }])) } },
  };
  for (const id of ["linear", "github"]) {
    const entry = BUNDLED_PLUGINS.find((p) => p.id === id);
    if (!entry) throw new Error(`Missing bundled reader: ${id}`);
    const plugin = await entry.load();
    const activation = registry.activation(entry.manifest as import("@armada/plugin-api").PluginManifest);
    await plugin.activate({
      config,
      secrets,
      register: activation.register,
      log: { info() {}, error() {} },
      events: {
        append: async (event) => store.append(event as import("../../src/events.ts").EventInput),
        read: async (project, after) => store.readSince(after, project),
        fold: async () => null,
      },
    });
    activation.commit();
  }
  return registry;
}
