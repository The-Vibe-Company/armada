import type { CoordinatorModel, ModelsCatalog } from "@armada/protocol";
import { coordinatorModelSchema } from "@armada/protocol";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Credential,
  type CredentialStore,
  createAssistantMessageEventStream,
  defaultProviderAuthContext,
  type Model,
} from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { createModels, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
// pi 1.4.0 does not export env-api-keys as a package subpath. Resolve the pinned
// dependency beside this package; the desktop bundler embeds this same module.
import { findEnvKeys } from "../../node_modules/@earendil-works/pi-ai/dist/env-api-keys.js";
import type { Keychain } from "../keychain.ts";

registerBunOAuthFlows();
type Catalog = Pick<ModelsCatalog, "providers" | "selected">;
type Env = Readonly<Record<string, string | undefined>>;

/** One daemon-owned registry. pi owns providers, OAuth and request dispatch. */
export class ModelRegistry {
  readonly models: MutableModels;
  readonly credentials: CredentialStore;
  readonly #keychain: Keychain;
  readonly #env: Env;
  #selected: CoordinatorModel | null | undefined;

  constructor(options: {
    keychain: Keychain;
    env?: Env;
    providers?: readonly Provider[];
    selected?: CoordinatorModel;
  }) {
    this.#keychain = options.keychain;
    this.#env = options.env ?? process.env;
    this.#selected = options.selected;
    const chains = new Map<string, Promise<unknown>>();
    const serialize = <T>(id: string, run: () => Promise<T>): Promise<T> => {
      const next = (chains.get(id) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          const release = await this.#keychain.lock("pi", id);
          try {
            return await run();
          } finally {
            await release();
          }
        });
      chains.set(id, next);
      void next
        .finally(() => {
          if (chains.get(id) === next) chains.delete(id);
        })
        .catch(() => {});
      return next;
    };
    const read: CredentialStore["read"] = async (id, operation) => {
      operation?.signal?.throwIfAborted();
      const value = await this.#keychain.read("pi", id);
      if (value === null) return undefined;
      try {
        const credential = JSON.parse(value) as Credential;
        if (
          credential.type === "api_key" &&
          (credential.key === undefined || typeof credential.key === "string") &&
          (credential.env === undefined || (credential.env && typeof credential.env === "object"))
        )
          return credential;
        if (
          credential.type === "oauth" &&
          typeof credential.access === "string" &&
          typeof credential.refresh === "string" &&
          typeof credential.expires === "number" &&
          Number.isFinite(credential.expires)
        )
          return credential;
      } catch {
        /* Never propagate a credential or parse input. */
      }
      throw new Error("Saved provider credential is invalid");
    };
    this.credentials = {
      read,
      list: async (operation) => {
        const result = await Promise.all(
          this.models.getProviders().map(async (provider) => {
            const credential = await read(provider.id, operation);
            return credential ? [{ providerId: provider.id, type: credential.type }] : [];
          }),
        );
        return result.flat();
      },
      modify: (id, update, operation) =>
        serialize(id, async () => {
          const current = await read(id, operation);
          const next = await update(current);
          operation?.signal?.throwIfAborted();
          if (next !== undefined) await this.#keychain.write("pi", id, JSON.stringify(next));
          return next ?? current;
        }),
      delete: (id, operation) =>
        serialize(id, async () => {
          operation?.signal?.throwIfAborted();
          await this.#keychain.remove("pi", id);
        }),
    };
    const ambient = defaultProviderAuthContext();
    const authContext = {
      env: async (name: string) => {
        if (this.#env[name]) return this.#env[name];
        // Generic credentials apply only to the explicitly named provider.
        const provider = this.#env.ARMADA_MODEL_PROVIDER ?? this.#env.ARMADA_MODEL_KIND;
        const keys = provider ? findEnvKeys(provider, { [name]: "configured" }) : undefined;
        return keys?.includes(name) ? this.#env.ARMADA_MODEL_API_KEY : undefined;
      },
      fileExists: options.env === undefined ? ambient.fileExists : async () => false,
    };
    this.models = options.providers
      ? createModels({ credentials: this.credentials, authContext })
      : builtinModels({ credentials: this.credentials, authContext });
    for (const provider of options.providers ?? []) this.models.setProvider(provider);
    const stream = this.models.stream.bind(this.models);
    const streamSimple = this.models.streamSimple.bind(this.models);
    this.models.stream = (model, context, request) =>
      safeStream(() => stream(model, context, request), model, request?.signal);
    this.models.streamSimple = (model, context, request) =>
      safeStream(() => streamSimple(model, context, request), model, request?.signal);
  }

  async selection(): Promise<CoordinatorModel | null> {
    if (this.#selected !== undefined) return this.#selected;
    const saved = await this.#keychain.coordinator();
    return saved
      ? typeof saved.model === "string"
        ? { provider: saved.provider, model: saved.model }
        : { kind: saved.provider, config: saved.config ?? {} }
      : null;
  }

  async select(selection: { provider: string; model: string }): Promise<void> {
    const parsed = coordinatorModelSchema.parse(selection);
    if (!("provider" in parsed) || !this.models.getModel(parsed.provider, parsed.model))
      throw new Error("Unknown provider or model");
    if (!(await this.models.checkAuth(parsed.provider))) throw new Error("Provider is not configured");
    await this.#keychain.selectCoordinator(parsed);
    this.#selected = parsed;
  }

  async setKey(provider: string, key: string): Promise<void> {
    if (!this.models.getProvider(provider)?.auth.apiKey) throw new Error("Provider does not accept an API key");
    await this.credentials.modify(provider, async () => ({ type: "api_key", key }));
  }

  async catalog(): Promise<Catalog> {
    const providers = await Promise.all(
      this.models.getProviders().map(async (provider) => {
        const configured = await this.models.checkAuth(provider.id);
        const envVars = findEnvKeys(provider.id, new Proxy({}, { get: () => "configured" })) ?? [];
        return {
          id: provider.id,
          name: provider.name,
          auth: { oauth: !!provider.auth.oauth, apiKey: !!provider.auth.apiKey?.login, envVars },
          status: !configured
            ? ("unconfigured" as const)
            : configured.type === "oauth"
              ? ("signed-in" as const)
              : configured.source === "stored credential"
                ? ("key-set" as const)
                : (await this.credentials.read(provider.id))?.type === "api_key"
                  ? ("key-set" as const)
                  : ("env" as const),
          models: this.models.getModels(provider.id).map((model) => ({
            id: model.id,
            name: model.name,
            reasoning: model.reasoning,
            contextWindow: model.contextWindow,
            inputCost: model.cost.input,
            outputCost: model.cost.output,
          })),
        };
      }),
    );
    providers.sort((a, b) =>
      a.id === "openai-codex" ? -1 : b.id === "openai-codex" ? 1 : a.name.localeCompare(b.name),
    );
    return { providers, selected: await this.selection() };
  }
}

/** Provider errors can contain request headers or response bodies. pi persists
 * terminal messages, so sanitize before they cross into the durable harness. */
function safeStream(
  run: () => AssistantMessageEventStream,
  model: Model<string>,
  signal?: AbortSignal,
): AssistantMessageEventStream {
  const result = createAssistantMessageEventStream();
  const safe = (message: AssistantMessage): AssistantMessage => {
    const { diagnostics: _diagnostics, ...clean } = message;
    return message.stopReason === "error" || message.stopReason === "aborted"
      ? {
          ...clean,
          content: message.stopReason === "aborted" ? message.content : [],
          errorMessage: message.stopReason === "aborted" ? "Model request cancelled" : "Model request failed",
        }
      : clean;
  };
  void (async () => {
    try {
      const upstream = run();
      for await (const event of upstream) {
        if (event.type === "error") result.push({ ...event, error: safe(event.error) });
        else if (event.type === "done") result.push({ ...event, message: safe(event.message) });
        else result.push({ ...event, partial: safe(event.partial) });
      }
      result.end(safe(await upstream.result()));
    } catch {
      const reason = signal?.aborted ? "aborted" : "error";
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        timestamp: Date.now(),
        stopReason: reason,
        errorMessage: reason === "aborted" ? "Model request cancelled" : "Model request failed",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      result.push({ type: "error", reason, error: message });
      result.end(message);
    }
  })();
  return result;
}
