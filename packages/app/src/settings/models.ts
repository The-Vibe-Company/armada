// Settings › Coordinator's rules (THE-2070), pure: the order of pi's
// providers, the state word on a provider's dot, the model picker's groups
// and search, a model's label, a sign-in flow read from the daemon's auth
// frames, and each project's override read from its folded rules.
import { type AuthFrame, type CoordinatorModel, coordinatorModelSchema, type ModelsCatalog } from "@armada/protocol";

export type CatalogProvider = ModelsCatalog["providers"][number];
export type CatalogModel = CatalogProvider["models"][number];

/** Signed in or a key saved on this device: the provider the owner connected. */
export const isConnected = (provider: CatalogProvider) =>
  provider.status === "signed-in" || provider.status === "key-set";

/** Connected, or configured by the daemon's environment: its models answer. */
export const isUsable = (provider: CatalogProvider) => provider.status !== "unconfigured";

/** Connected (and those the environment configures) first, then the ones with a sign-in, then by name. */
export function providerOrder(providers: readonly CatalogProvider[]): CatalogProvider[] {
  const tier = (p: CatalogProvider) => (isUsable(p) ? 0 : p.auth.oauth ? 1 : 2);
  return [...providers].sort((a, b) => tier(a) - tier(b) || a.name.localeCompare(b.name));
}

/** A provider's state in a word, its ink and its dot; none when nothing connects it. */
export function providerState(provider: CatalogProvider): { word: string; ink: string; dot: string } | null {
  switch (provider.status) {
    case "signed-in":
      return { word: "Signed in", ink: "text-green", dot: "bg-green" };
    case "key-set":
      return { word: "Key set", ink: "text-green", dot: "bg-green" };
    case "env":
      return { word: "From environment", ink: "text-text-2", dot: "bg-text-3" };
    default:
      return null;
  }
}

/** A context window in tokens, short: 400k, 1M, 1.5M; nothing when unknown. */
export function contextLabel(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "";
  if (tokens < 1_000_000) return `${Math.max(1, Math.round(tokens / 1000))}k`;
  return `${Number((tokens / 1_000_000).toFixed(1))}M`;
}

/** A model as a row reads it: its name, whether it reasons, its context. */
export function modelLabel(model: CatalogModel): { name: string; reasoning: boolean; context: string; text: string } {
  const context = contextLabel(model.contextWindow);
  const name = model.name || model.id;
  return {
    name,
    reasoning: model.reasoning,
    context,
    text: [name, model.reasoning ? "reasoning" : "", context ? `${context} context` : ""].filter(Boolean).join(", "),
  };
}

export interface PickerGroup {
  provider: CatalogProvider;
  /** Its models can be chosen; otherwise they are listed dimmed, with why. */
  available: boolean;
  reason: string | null;
  models: CatalogModel[];
}

/**
 * The picker's groups: one per provider with models, the usable ones first,
 * each holding the models the search matches (every word of it, in the
 * model's name or id or the provider's name). A group nothing matches leaves.
 */
export function pickerGroups(providers: readonly CatalogProvider[], query = ""): PickerGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return providerOrder(providers).flatMap((provider) => {
    const models = provider.models.filter((model) => {
      const haystack = `${model.name} ${model.id} ${provider.name} ${provider.id}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
    if (models.length === 0) return [];
    const available = isUsable(provider);
    return [{ provider, available, reason: available ? null : "Connect first", models }];
  });
}

/** The key the picker and its options share for one model. */
export const modelKey = (provider: string, model: string) => `${provider}/${model}`;

/** The chosen pi model, when the daemon's selection is one. */
export function piSelection(selected: CoordinatorModel | null | undefined): { provider: string; model: string } | null {
  return selected && "provider" in selected ? { provider: selected.provider, model: selected.model } : null;
}

/** A selection in words: the model's name from the catalog, else what the daemon said. */
export function selectionLabel(
  selected: CoordinatorModel | null | undefined,
  providers: readonly CatalogProvider[],
): string | null {
  if (!selected) return null;
  if ("provider" in selected) {
    const model = providers.find((p) => p.id === selected.provider)?.models.find((m) => m.id === selected.model);
    return model ? modelLabel(model).name : modelKey(selected.provider, selected.model);
  }
  return selected.config.model ? `${selected.kind} · ${selected.config.model}` : selected.kind;
}

/** A project's coordinator model from its folded state's rules; null when it has none (the default). */
export function projectOverride(state: unknown): CoordinatorModel | null {
  const rules = state && typeof state === "object" ? Reflect.get(state, "rules") : undefined;
  const value = rules && typeof rules === "object" ? Reflect.get(rules, "value") : undefined;
  const model = value && typeof value === "object" ? Reflect.get(value, "coordinatorModel") : undefined;
  const parsed = coordinatorModelSchema.safeParse(model);
  return parsed.success ? parsed.data : null;
}

/** Which mark a provider wears: its maker's, by its id, else the generic one. */
export type MarkName =
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "mistral"
  | "deepseek"
  | "groq"
  | "openrouter"
  | "github"
  | "generic";
const MARKS: readonly [RegExp, MarkName][] = [
  [/^openai(-|$)/, "openai"],
  [/^anthropic(-|$)/, "anthropic"],
  [/^google(-|$)/, "google"],
  [/^xai(-|$)/, "xai"],
  [/^mistral(-|$)/, "mistral"],
  [/^deepseek(-|$)/, "deepseek"],
  [/^groq(-|$)/, "groq"],
  [/^openrouter(-|$)/, "openrouter"],
  [/^github(-|$)/, "github"],
];
export function markOf(provider: string): MarkName {
  return MARKS.find(([pattern]) => pattern.test(provider))?.[1] ?? "generic";
}

export type AuthPrompt = Extract<AuthFrame, { type: "auth.prompt" }>;

/** One sign-in as the owner sees it, built from the daemon's auth frames. */
export interface SignInView {
  provider: string;
  /** The page to open, once the daemon gave it. */
  url: string | null;
  instructions: string | null;
  device: { code: string; uri: string } | null;
  /** Progress and information lines, oldest first. */
  lines: string[];
  links: { url: string; label: string }[];
  /** The question awaiting the owner's answer; it leaves once answered. */
  prompt: AuthPrompt | null;
  error: string | null;
  /**
   * A CLI login's terminal (THE-2075, provider sign-ins only: the daemon
   * removes what the owner typed from it); absent where it is not shown.
   */
  terminal?: string;
}

export const startSignIn = (provider: string, options: { terminal?: boolean } = {}): SignInView => ({
  provider,
  url: null,
  instructions: null,
  device: null,
  lines: [],
  links: [],
  prompt: null,
  error: null,
  ...(options.terminal ? { terminal: "" } : {}),
});

/** How much of a terminal stays: its last characters. */
const TERMINAL_KEPT = 16_000;
// Colours, cursor moves and titles: the pane shows the text only.
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what it removes.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\r(?!\n)/g;

/**
 * A terminal's output as text: escape sequences removed (over what is kept,
 * so one split across two chunks goes once whole), the last part kept.
 */
export function terminalText(current: string, output: string): string {
  const next = (current + output).replace(ESCAPES, "");
  return next.length > TERMINAL_KEPT ? next.slice(-TERMINAL_KEPT) : next;
}

/**
 * The sign-in after one more frame. Terminal output is shown only where the
 * sign-in asked for it (a provider's): a model's may carry what the owner typed.
 */
export function applyAuthFrame(view: SignInView, frame: AuthFrame): SignInView {
  if (frame.type === "auth.prompt") return { ...view, prompt: frame };
  const event = frame.event;
  switch (event.type) {
    case "auth_url":
      return { ...view, url: event.url, instructions: event.instructions ?? view.instructions };
    case "device_code":
      return { ...view, device: { code: event.userCode, uri: event.verificationUri } };
    case "progress":
      return { ...view, lines: [...view.lines, event.message] };
    case "info":
      return {
        ...view,
        lines: [...view.lines, event.message],
        links: [...view.links, ...(event.links ?? []).map((l) => ({ url: l.url, label: l.label ?? l.url }))],
      };
    case "terminal":
      return view.terminal === undefined ? view : { ...view, terminal: terminalText(view.terminal, event.output) };
    default:
      return view;
  }
}
