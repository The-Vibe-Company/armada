import {
  type Json,
  type JsonSchema,
  manifestSchema,
  PLUGIN_API_VERSION,
  type PluginConfig,
  type PluginContext,
  type PluginManifest,
  type PluginSetting,
  SEAMS,
  type Seam,
} from "@armada/plugin-api";
import { Ajv } from "ajv";
import { satisfies, valid, validRange } from "semver";
import { BUNDLED_PLUGINS, type PluginCatalogEntry } from "./catalog.ts";
import { appConfigPath, readPluginSettings } from "./config.ts";
import { describePlugin } from "./list.ts";
import { PluginRegistry } from "./registry.ts";

export interface PluginState {
  id: string;
  version: string | null;
  enabled: boolean;
  contributions: string[];
  loaded: boolean;
  error?: string;
}
export type PluginServices = Pick<PluginContext, "events" | "secrets" | "log">;
export interface PluginBoot {
  registry: PluginRegistry;
  plugins: PluginState[];
  /** The saved switches and configs this boot read: what a later change is compared with. */
  settings: PluginSetting[];
}
const line = (message: string) => message.replace(/[\r\n\t]+/g, " ");

/** One contribution's config against its JSON Schema; shared by the boot and the app's Plugins screen. */
export function validateContribution(schema: JsonSchema, seam: Seam, kind: string, value: Json): void {
  const ajv = new Ajv({ allErrors: true });
  const check = ajv.compile(schema);
  if ("$async" in check && check.$async) throw new Error("config schemas must be synchronous");
  if (!check(value))
    throw new Error(`config ${seam}.${kind}: ${ajv.errorsText(check.errors, { dataVar: "config", separator: "; " })}`);
}

function validateConfig(manifest: PluginManifest, config: PluginConfig, defaults: PluginConfig): PluginConfig {
  const validated: PluginConfig = {};
  for (const seam of SEAMS) {
    for (const kind of Object.keys(config[seam] ?? {}))
      if (!Object.hasOwn(manifest.contributions[seam] ?? {}, kind))
        throw new Error(`config for undeclared contribution ${seam}.${kind}`);
    for (const [kind, contribution] of Object.entries(manifest.contributions[seam] ?? {})) {
      const values = config[seam];
      const saved = values && Object.hasOwn(values, kind) ? (values[kind] as Json) : {};
      const base = defaults[seam]?.[kind];
      const value =
        base && typeof saved === "object" && saved !== null && !Array.isArray(saved)
          ? { ...(base as Record<string, Json>), ...saved }
          : saved;
      validateContribution(contribution.config as JsonSchema, seam, kind, value);
      const target = validated[seam] ?? {};
      target[kind] = structuredClone(value);
      validated[seam] = target;
    }
  }
  return validated;
}

/** One call per daemon boot. No watching, unloading or network resolution. */
export async function loadPlugins(
  services: PluginServices,
  configPath = appConfigPath(),
  catalog: readonly PluginCatalogEntry[] = BUNDLED_PLUGINS,
  defaults: PluginConfig = {},
): Promise<PluginBoot> {
  const registry = new PluginRegistry();
  const plugins: PluginState[] = [];
  const ids = new Set<string>();
  const settings = await readPluginSettings(configPath);
  for (const entry of catalog) {
    const setting = settings.find((s) => s.id === entry.id);
    const state: PluginState = {
      ...describePlugin(entry),
      enabled: setting?.enabled ?? describePlugin(entry).enabled,
      loaded: false,
    };
    plugins.push(state);
    if (!state.enabled) continue;
    let activation: ReturnType<PluginRegistry["activation"]> | undefined;
    try {
      if (ids.has(entry.id)) throw new Error("duplicate catalog plugin id");
      ids.add(entry.id);
      const parsed = manifestSchema.safeParse(entry.manifest);
      if (!parsed.success)
        throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
      const manifest = parsed.data;
      state.version = manifest.version;
      state.contributions = SEAMS.flatMap((seam) =>
        Object.keys(manifest.contributions[seam] ?? {}).map((kind) => `${seam}.${kind}`),
      );
      if (manifest.id !== entry.id) throw new Error(`manifest id ${manifest.id} does not match catalog id ${entry.id}`);
      if (!valid(manifest.version)) throw new Error(`invalid plugin version ${manifest.version}`);
      if (!validRange(manifest.pluginApi)) throw new Error(`invalid pluginApi range ${manifest.pluginApi}`);
      if (!satisfies(PLUGIN_API_VERSION, manifest.pluginApi))
        throw new Error(`pluginApi ${manifest.pluginApi} excludes daemon Plugin API ${PLUGIN_API_VERSION}`);
      const config = validateConfig(manifest, setting?.config ?? {}, defaults);
      const declared = new Set(
        SEAMS.flatMap((seam) => Object.values(manifest.contributions[seam] ?? {}).flatMap((c) => c.secrets)),
      );
      activation = registry.activation(manifest);
      const plugin = await entry.load();
      if (typeof plugin.activate !== "function") throw new Error("module must export activate(ctx)");
      await plugin.activate({
        events: services.events,
        config,
        log: services.log,
        register: activation.register,
        secrets: {
          get: async (name, project) => {
            if (!declared.has(name)) throw new Error(`undeclared secret ${name}`);
            return services.secrets.get(name, project);
          },
        },
      });
      activation.commit();
      state.loaded = true;
    } catch (error) {
      activation?.abort();
      state.error = line(error instanceof Error ? error.message : String(error));
      services.log.error(`Plugin ${state.id} refused: ${state.error}`);
    }
  }
  return { registry, plugins, settings };
}
