import { manifestSchema, type PluginContext } from "@armada/plugin-api";
import {
  type CoordinatorModel,
  coordinatorModelSchema,
  type ModelKindEntry,
  modelConfigSchema,
} from "@armada/protocol";
import type { LanguageModel } from "ai";
import type { CoordinatorOptions } from "../../coordinator/index.ts";
import { checkpointRules } from "../../coordinator/rules.ts";
import type { Keychain } from "../keychain.ts";
import { pluginModels } from "../model-sdk.ts";
import type { ModelRegistry } from "../models/registry.ts";
import { BUNDLED_PLUGINS, type PluginCatalogEntry } from "../plugins/catalog.ts";
import { readPluginSecret } from "../plugins/keychain.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type { EventStore } from "../store.ts";

export function loadedModelKinds(
  registry: PluginRegistry,
  catalog: readonly PluginCatalogEntry[] = BUNDLED_PLUGINS,
): ModelKindEntry[] {
  return catalog.flatMap((entry) => {
    const parsed = manifestSchema.safeParse(entry.manifest);
    if (!parsed.success) return [];
    return Object.entries(parsed.data.contributions.model ?? {}).flatMap(([kind, contribution]) =>
      registry.get("model", kind)
        ? [
            {
              kind,
              description: contribution.description ?? kind,
              config: (registry.get("model", kind)?.configSchema ?? contribution.config) as ModelKindEntry["config"],
            },
          ]
        : [],
    );
  });
}

/** Boot-only credential source. Plugins never read the host environment or keychain themselves. */
export async function modelEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  keychain: Keychain,
  accountSecrets?: PluginContext["secrets"],
) {
  const saved = await keychain.coordinator().catch(() => null);
  const plugin = await keychain.pluginCoordinator().catch(() => null);
  const value = async (name: string) =>
    env[name] || (await keychain.read("plugin", name).catch(() => null)) || undefined;
  const generic = {
    kind: await value("ARMADA_MODEL_KIND"),
    model: await value("ARMADA_MODEL_NAME"),
    baseURL: await value("ARMADA_MODEL_BASE_URL"),
    key: await value("ARMADA_MODEL_API_KEY"),
  };
  const zai = {
    baseURL: await value("ZAI_BASE_URL"),
    model: await value("ZAI_MODEL"),
    key: await value("ZAI_API_KEY"),
  };
  const azure = {
    baseURL: (await value("AZURE_AI_ENDPOINT")) ?? (await value("AZURE_AI_BASE_URL")),
    model: await value("AZURE_AI_MODEL"),
    key: await value("AZURE_AI_API_KEY"),
  };
  const savedSecret = plugin?.config?.apiKeySecret === undefined ? "ARMADA_MODEL_API_KEY" : plugin.config.apiKeySecret;
  const pluginSelected = plugin
    ? { kind: plugin.provider, config: { ...plugin.config, apiKeySecret: savedSecret } }
    : undefined;
  let savedSelected: CoordinatorModel | undefined;
  if (saved?.model) savedSelected = { provider: saved.provider, model: saved.model };
  else if (saved) savedSelected = { kind: saved.provider, config: { ...saved.config, apiKeySecret: savedSecret } };
  let genericSelected: CoordinatorModel | undefined;
  if ((env.ARMADA_MODEL_PROVIDER || generic.kind) && !generic.baseURL && env.ARMADA_MODEL_PROVIDER && generic.model) {
    genericSelected = { provider: env.ARMADA_MODEL_PROVIDER, model: generic.model };
  } else if (generic.kind) {
    genericSelected = {
      kind: generic.kind,
      config: {
        ...(plugin?.provider === generic.kind ? plugin.config : {}),
        ...(generic.model ? { model: generic.model } : {}),
        ...(generic.baseURL ? { baseURL: generic.baseURL } : {}),
        apiKeySecret: "ARMADA_MODEL_API_KEY",
      },
    };
  }
  // Only a generic model can be forced; an incomplete override must not promote ZAI/Azure.
  const force = env.ARMADA_MODEL_FORCE === "1" && !!(env.ARMADA_MODEL_PROVIDER || env.ARMADA_MODEL_KIND);
  let selected: CoordinatorModel | undefined =
    (force ? genericSelected : undefined) ?? savedSelected ?? genericSelected;
  if (!selected && zai.baseURL && zai.model && zai.key) {
    selected = {
      kind: "openai-compatible",
      config: { baseURL: zai.baseURL, model: zai.model, apiKeySecret: "ZAI_API_KEY" },
    };
  } else if (!selected && azure.baseURL && azure.model && azure.key) {
    selected = {
      kind: "openai-compatible",
      config: { baseURL: azure.baseURL, model: azure.model, apiKeySecret: "AZURE_AI_API_KEY", apiKeyHeader: "api-key" },
    };
  }
  return {
    selected,
    pluginSelected,
    secrets: {
      async get(name: string, project?: string) {
        if (env[name]) return env[name] ?? null;
        if (name === "ARMADA_MODEL_API_KEY")
          return (
            (await value(name)) ?? (savedSecret === name ? ((await keychain.pluginCoordinator())?.key ?? null) : null)
          );
        if (name === savedSecret) return (await value(name)) ?? (await keychain.pluginCoordinator())?.key ?? null;
        return accountSecrets ? accountSecrets.get(name, project) : readPluginSecret(name, keychain, env);
      },
    } satisfies PluginContext["secrets"],
  };
}

/** Project rules win over the boot default. Provider code is always obtained from the registry. */
export function coordinatorModels(options: {
  projects: readonly { id: string; coordinatorModel?: unknown }[];
  store: EventStore;
  registry: PluginRegistry;
  pi?: ModelRegistry;
  selected?: CoordinatorModel;
  pluginSelected?: Extract<CoordinatorModel, { kind: string }>;
  onSkipped?: (project: string) => void;
}): CoordinatorOptions[] {
  return options.projects.flatMap<CoordinatorOptions>((project) => {
    try {
      let candidate = project.coordinatorModel === undefined ? options.selected : project.coordinatorModel;
      for (const event of options.store.readSince(0, project.id)) {
        if (event.kind !== "coordinator.checkpoint") continue;
        const rules = checkpointRules(event.payload.checkpoint);
        if (rules?.value.coordinatorModel) candidate = rules.value.coordinatorModel;
      }
      if (candidate === undefined) return [];
      const selection = coordinatorModelSchema.parse(candidate);
      if ("provider" in selection) {
        if (!options.pi?.models.getModel(selection.provider, selection.model)) throw new Error("Model unavailable");
        return [
          {
            project: project.id,
            models: options.pi.models,
            model: { provider: selection.provider, modelId: selection.model },
            selection,
          },
        ];
      }
      const config = modelConfigSchema.parse({
        ...(options.pluginSelected?.kind === selection.kind ? options.pluginSelected.config : {}),
        ...(options.selected && "kind" in options.selected && options.selected.kind === selection.kind
          ? options.selected.config
          : {}),
        ...selection.config,
      });
      const provider = options.registry.get("model", selection.kind);
      if (!provider) throw new Error("Model plugin unavailable");
      const sdk = provider.create(config.model ?? "", config) as LanguageModel;
      if (typeof sdk !== "object" || !sdk || !("modelId" in sdk)) throw new Error("Invalid plugin model");
      return [
        {
          project: project.id,
          ...pluginModels(selection.kind, config.model ?? sdk.modelId, sdk),
          selection: { ...selection, config },
        },
      ];
    } catch {
      options.onSkipped?.(project.id);
      return [];
    }
  });
}
