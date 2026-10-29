import { manifestSchema, type PluginContext } from "@armada/plugin-api";
import {
  type CoordinatorModel,
  coordinatorModelSchema,
  type ModelKindEntry,
  modelConfigSchema,
} from "@armada/protocol";
import type { LanguageModel } from "ai";
import { z } from "zod";
import type { CoordinatorOptions } from "../../coordinator/index.ts";
import type { Keychain } from "../keychain.ts";
import { pluginModels } from "../model-sdk.ts";
import { BUNDLED_PLUGINS, type PluginCatalogEntry } from "../plugins/catalog.ts";
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
export async function modelEnvironment(env: Readonly<Record<string, string | undefined>>, keychain: Keychain) {
  const saved = await keychain.coordinator().catch(() => null);
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
  let selected: CoordinatorModel | undefined;
  if (generic.kind) {
    selected = coordinatorModelSchema.parse({
      kind: generic.kind,
      config: {
        ...(saved?.provider === generic.kind ? saved.config : {}),
        ...(generic.model ? { model: generic.model } : {}),
        ...(generic.baseURL ? { baseURL: generic.baseURL } : {}),
        apiKeySecret: "ARMADA_MODEL_API_KEY",
      },
    });
  } else if (zai.baseURL && zai.model && zai.key) {
    selected = {
      kind: "openai-compatible",
      config: { baseURL: zai.baseURL, model: zai.model, apiKeySecret: "ZAI_API_KEY" },
    };
  } else if (azure.baseURL && azure.model && azure.key) {
    selected = {
      kind: "openai-compatible",
      config: { baseURL: azure.baseURL, model: azure.model, apiKeySecret: "AZURE_AI_API_KEY", apiKeyHeader: "api-key" },
    };
  } else if (saved) {
    // Read old OpenAI entries without retaining the old identity in the app or catalog.
    selected = {
      kind: saved.provider,
      config: { ...saved.config, apiKeySecret: "ARMADA_MODEL_API_KEY" },
    };
  }
  return {
    selected,
    secrets: {
      async get(name: string) {
        if (env[name]) return env[name] ?? null;
        if (name === "ARMADA_MODEL_API_KEY")
          return generic.key ?? (selected?.kind === saved?.provider ? (saved?.key ?? null) : null);
        return keychain.read("plugin", name).catch(() => null);
      },
    } satisfies PluginContext["secrets"],
  };
}

const checkpoint = z.object({
  checkpoint: z.object({
    format: z.literal("armada.tools"),
    rules: z.object({ value: z.object({ coordinatorModel: coordinatorModelSchema.optional() }) }),
  }),
});

/** Project rules win over the boot default. Provider code is always obtained from the registry. */
export function coordinatorModels(options: {
  projects: readonly { id: string; coordinatorModel?: CoordinatorModel }[];
  store: EventStore;
  registry: PluginRegistry;
  selected?: CoordinatorModel;
  onSkipped?: (project: string) => void;
}): CoordinatorOptions[] {
  return options.projects.flatMap((project) => {
    let selection = project.coordinatorModel ?? options.selected;
    for (const event of options.store.readSince(0, project.id)) {
      if (event.kind !== "coordinator.checkpoint") continue;
      const parsed = checkpoint.safeParse(event.payload);
      if (parsed.success && parsed.data.checkpoint.rules.value.coordinatorModel)
        selection = parsed.data.checkpoint.rules.value.coordinatorModel;
    }
    if (!selection) return [];
    try {
      const config = modelConfigSchema.parse({
        ...(options.selected?.kind === selection.kind ? options.selected.config : {}),
        ...selection.config,
      });
      const provider = options.registry.get("model", selection.kind);
      if (!provider) throw new Error("Model plugin unavailable");
      const sdk = provider.create(config.model ?? "", config) as LanguageModel;
      if (typeof sdk !== "object" || !sdk || !("modelId" in sdk)) throw new Error("Invalid plugin model");
      return [{ project: project.id, ...pluginModels(selection.kind, config.model ?? sdk.modelId, sdk) }];
    } catch {
      options.onSkipped?.(project.id);
      return [];
    }
  });
}
