import type { Harness } from "./contract.ts";
import { LaunchError } from "./launch-error.ts";

/**
 * The models Armada suggests at launch, per harness, and the defaults. The model is a harness choice: it does
 * not depend on the sandbox provider or the golden. The ids and efforts below come from the harnesses' own
 * catalogs: Codex CLI 0.167.0 `codex debug models` (efforts per model), and Claude Code 2.1.322's model
 * selector (Opus 5.5 and Sonnet 5.5; efforts from its `--effort` levels).
 *
 * The list is a set of suggestions, not the whole of what a harness runs. Another well-formed id is passed
 * to the provider unchanged, with an effort from the harness's vocabulary; the provider or the harness
 * refuses it if it cannot run it. Armada never replaces a requested model or effort by another.
 */
export interface ModelOption {
  /** The id the harness takes. */
  id: string;
  /** How people call it. */
  label: string;
  /** The reasoning efforts this model accepts, lowest first. */
  reasoningEfforts: readonly string[];
}

export interface HarnessModels {
  defaultModel: string;
  defaultReasoningEffort: string;
  /** Every effort the harness knows: what a model outside `models` may ask for. */
  reasoningEfforts: readonly string[];
  models: readonly ModelOption[];
}

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

export const MODEL_CATALOG: Readonly<Record<Harness, HarnessModels>> = {
  claude: {
    defaultModel: "claude-opus-5-5",
    defaultReasoningEffort: "medium",
    reasoningEfforts: CLAUDE_EFFORTS,
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", reasoningEfforts: CLAUDE_EFFORTS },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", reasoningEfforts: CLAUDE_EFFORTS },
    ],
  },
  codex: {
    defaultModel: "gpt-6.1-sol",
    defaultReasoningEffort: "medium",
    reasoningEfforts: CODEX_EFFORTS,
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", reasoningEfforts: CODEX_EFFORTS },
      { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", reasoningEfforts: CODEX_EFFORTS },
      { id: "gpt-6-astra", label: "GPT-6 Astra", reasoningEfforts: CODEX_EFFORTS },
      { id: "gpt-6-sol", label: "GPT-6 Sol", reasoningEfforts: CODEX_EFFORTS },
      { id: "gpt-6-luna", label: "GPT-6 Luna", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
    ],
  },
};

/** A model id Armada forwards: letters, digits and `.:_/-[]`, as harness and gateway ids are written. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,199}$/;

/** What a sandbox's turns run with. */
export interface ModelChoice {
  model: string;
  reasoningEffort: string;
}

/**
 * The model and effort a launch or a send runs with: the given ones, else `fallback` (a sandbox's stored
 * choice), else the harness defaults. An effort given alone applies to the chosen model. A suggested model
 * takes only the efforts it lists; another model takes the harness's efforts and is checked by the provider.
 * Anything refused is an `invalid_request` that names what is accepted.
 */
export function resolveModelChoice(
  harness: Harness,
  requested: { model?: string | undefined; reasoningEffort?: string | undefined },
  fallback?: ModelChoice,
): ModelChoice {
  const catalog = MODEL_CATALOG[harness];
  const model = requested.model ?? fallback?.model ?? catalog.defaultModel;
  if (!MODEL_ID.test(model)) {
    throw new LaunchError(
      "invalid_request",
      `The model id is not well formed (letters, digits and .:_/-[] only). Use one of: ${catalog.models.map((m) => m.id).join(", ")}, or another ${harness} model id.`,
    );
  }
  const efforts =
    catalog.models.find((candidate) => candidate.id === model)?.reasoningEfforts ?? catalog.reasoningEfforts;
  const keepEffort = requested.model === undefined || requested.model === fallback?.model;
  const effort =
    requested.reasoningEffort ??
    (keepEffort ? fallback?.reasoningEffort : undefined) ??
    (efforts.includes(catalog.defaultReasoningEffort) ? catalog.defaultReasoningEffort : undefined);
  if (effort === undefined || !efforts.includes(effort)) {
    throw new LaunchError(
      "invalid_request",
      `That reasoning effort is not available for ${model}. Use one of: ${efforts.join(", ")}.`,
    );
  }
  return { model, reasoningEffort: effort };
}
