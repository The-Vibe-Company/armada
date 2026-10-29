import { type Json, manifestSchema, type PluginManifest, SEAMS, type Seam } from "@armada/plugin-api";
import { type ClientMessage, type Plugin, PROTOCOL_VERSION, type ServerMessage } from "@armada/protocol";
import type { Keychain } from "../keychain.ts";
import type { PluginCatalogMetadata } from "../plugins/catalog.ts";
import { readPluginSettings, setPluginConfig, setPluginEnabled, updateAppConfig } from "../plugins/config.ts";
import { describePlugin } from "../plugins/list.ts";
import { type PluginBoot, validateContribution } from "../plugins/loader.ts";

export type PluginsRequest = Extract<
  ClientMessage,
  { type: "plugins.list" | "plugins.enable" | "plugins.disable" | "plugins.configure" | "plugins.secret" }
>;

const TYPES = new Set<string>([
  "plugins.list",
  "plugins.enable",
  "plugins.disable",
  "plugins.configure",
  "plugins.secret",
]);
export const isPluginsRequest = (request: ClientMessage): request is PluginsRequest => TYPES.has(request.type);

/** What the Plugins screen reads and changes: this boot's catalog and results, and the app's saved settings. */
export interface PluginHost {
  /** The app configuration the boot read; changes go there under its process-safe lock. */
  configPath: string;
  catalog: readonly PluginCatalogMetadata[];
  /** What this daemon's boot loaded, and the settings it read: a change is compared with them. */
  boot: Pick<PluginBoot, "plugins" | "settings">;
  /** Declared secrets only, service `armada.plugins`; values are written and checked, never sent. */
  keychain: Pick<Keychain, "read" | "write">;
}

class Refusal extends Error {
  readonly code: "invalid-message" | "not-found" | "internal";
  constructor(code: Refusal["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** JSON with its keys sorted, so a saved config compares by value. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
const manifestOf = (entry: PluginCatalogMetadata): PluginManifest | null => {
  const parsed = manifestSchema.safeParse(entry.manifest);
  return parsed.success ? parsed.data : null;
};

async function list(host: PluginHost): Promise<Plugin[]> {
  let settings: Awaited<ReturnType<typeof readPluginSettings>>;
  try {
    settings = await readPluginSettings(host.configPath);
  } catch {
    throw new Refusal("internal", "The app configuration cannot be read: fix or remove its plugins list");
  }
  // One keychain read per name: a name may be declared by several contributions.
  const secrets = new Map<string, Promise<boolean>>();
  const isSet = (name: string) => {
    if (!secrets.has(name))
      secrets.set(
        name,
        host.keychain.read("plugin", name).then(
          (value) => value !== null,
          () => false,
        ),
      );
    return secrets.get(name) as Promise<boolean>;
  };
  return Promise.all(
    host.catalog.map(async (entry): Promise<Plugin> => {
      const described = describePlugin(entry);
      const manifest = manifestOf(entry);
      const setting = settings.find((s) => s.id === entry.id);
      const booted = host.boot.settings.find((s) => s.id === entry.id);
      const state = host.boot.plugins.find((p) => p.id === entry.id);
      const enabled = setting?.enabled ?? described.enabled;
      const reconfigured = enabled && canonical(setting?.config ?? {}) !== canonical(booted?.config ?? {});
      const contributions = await Promise.all(
        SEAMS.flatMap((seam) =>
          Object.entries(manifest?.contributions[seam] ?? {}).map(async ([kind, contribution]) => ({
            seam,
            kind,
            ...(contribution.description ? { description: contribution.description } : {}),
            schema: contribution.config,
            config: (setting?.config[seam]?.[kind] ?? {}) as Json,
            secrets: await Promise.all(contribution.secrets.map(async (name) => ({ name, set: await isSet(name) }))),
          })),
        ),
      );
      return {
        id: entry.id,
        version: manifest?.version ?? described.version,
        description: manifest?.description ?? null,
        enabled,
        loaded: state?.loaded ?? false,
        ...(state?.error ? { error: state.error } : {}),
        restartRequired: !state || state.enabled !== enabled || reconfigured,
        contributions,
      };
    }),
  );
}

/**
 * Called only after protocol admission, one request at a time. Every answer is
 * the whole list as saved now; a change takes effect when the daemon restarts.
 * A secret's value is never logged, echoed or put in an error.
 */
export async function dispatchPlugins(
  request: PluginsRequest,
  host: PluginHost,
  restartable: boolean,
): Promise<ServerMessage> {
  const base = { version: PROTOCOL_VERSION, id: request.id };
  try {
    if (request.type !== "plugins.list") {
      const entry = host.catalog.find((e) => e.id === request.plugin);
      if (!entry) throw new Refusal("not-found", `No bundled plugin ${request.plugin}`);
      if (request.type === "plugins.enable" || request.type === "plugins.disable") {
        const enabled = request.type === "plugins.enable";
        await updateAppConfig(host.configPath, (current) => setPluginEnabled(current, entry.id, enabled));
      } else {
        const manifest = manifestOf(entry);
        if (!manifest) throw new Refusal("invalid-message", `Plugin ${entry.id} has an invalid manifest`);
        if (request.type === "plugins.configure") {
          const seam = SEAMS.find((s) => s === request.seam) as Seam | undefined;
          const contribution = seam && manifest.contributions[seam]?.[request.kind];
          if (!seam || !contribution || !Object.hasOwn(manifest.contributions[seam] ?? {}, request.kind))
            throw new Refusal("not-found", `Plugin ${entry.id} has no contribution ${request.seam}.${request.kind}`);
          try {
            validateContribution(contribution.config, seam, request.kind, request.config);
          } catch (error) {
            throw new Refusal("invalid-message", error instanceof Error ? error.message : "Invalid config");
          }
          await updateAppConfig(host.configPath, (current) =>
            setPluginConfig(current, entry.id, seam, request.kind, request.config),
          );
        } else {
          const declared = SEAMS.some((seam) =>
            Object.values(manifest.contributions[seam] ?? {}).some((c) => c.secrets.includes(request.name)),
          );
          if (!declared) throw new Refusal("not-found", `Plugin ${entry.id} declares no secret ${request.name}`);
          try {
            await host.keychain.write("plugin", request.name, request.value);
          } catch {
            throw new Refusal("internal", "Could not access credential storage. Unlock it and try again.");
          }
        }
      }
    }
    return { ...base, type: "plugins.result", plugins: await list(host), restartable };
  } catch (error) {
    const refusal =
      error instanceof Refusal ? error : new Refusal("internal", "The app configuration could not be saved");
    return { ...base, type: "error", code: refusal.code, message: refusal.message.replace(/[\r\n\t]+/g, " ") };
  }
}
