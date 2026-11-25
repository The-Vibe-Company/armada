import type { Harness } from "@armada/core";
import { modelLabel } from "./templates";

const DEFAULT_MODEL_ALIAS = "default";
const DEFAULT_MODEL_LABEL = "Account default";

export function isDefaultModelAlias(model: string | null | undefined) {
  return typeof model === "string" && model.trim() === DEFAULT_MODEL_ALIAS;
}

function concreteModels(models: readonly (string | null | undefined)[] | null | undefined) {
  if (!models) return [];
  const seen = new Set<string>();
  const concrete: string[] = [];
  for (const raw of models) {
    const model = raw?.trim();
    if (!model || model === DEFAULT_MODEL_ALIAS || seen.has(model)) continue;
    seen.add(model);
    concrete.push(model);
  }
  return concrete;
}

export function displayedSandboxModel(
  harness: Harness,
  requestedModel: string | null | undefined,
  observedModels?: readonly (string | null | undefined)[] | null,
) {
  const requested = requestedModel?.trim() || null;
  if (requested && requested !== DEFAULT_MODEL_ALIAS) return requested;
  const executed = concreteModels(observedModels);
  if (executed.length > 0) return executed.join(", ");
  if (requested === DEFAULT_MODEL_ALIAS) {
    const label = modelLabel(harness, requested);
    return label === DEFAULT_MODEL_ALIAS ? DEFAULT_MODEL_LABEL : label;
  }
  return null;
}

export function costModelsLabel(models: readonly (string | null | undefined)[]) {
  const concrete = concreteModels(models);
  if (concrete.length > 0) return concrete.join(", ");
  return models.some(isDefaultModelAlias) ? DEFAULT_MODEL_LABEL : "Not reported";
}

export function turnModelLabel(model: string | null | undefined) {
  const trimmed = model?.trim();
  if (!trimmed) return "Model not reported";
  return isDefaultModelAlias(trimmed) ? DEFAULT_MODEL_LABEL : trimmed;
}

export function turnModelDisplay(
  turnModel:
    | {
        requestedModel?: string | null;
        observedModel?: string | null;
        modelSelectionReason?: string | null;
        modelSelectionMessage?: string | null;
      }
    | null
    | undefined,
) {
  if (!turnModel) return null;
  const requested = turnModel.requestedModel?.trim() || null;
  const observed = turnModel.observedModel?.trim() || null;
  const concreteObserved = observed && !isDefaultModelAlias(observed) ? observed : null;
  if (
    isDefaultModelAlias(requested) &&
    concreteObserved &&
    turnModel.modelSelectionReason !== "model_selection_mismatch"
  ) {
    return { kind: "model" as const, model: concreteObserved };
  }
  if (turnModel.modelSelectionReason) {
    return {
      kind: "notice" as const,
      summary:
        turnModel.modelSelectionReason === "model_selection_mismatch"
          ? ("The agent used a different model" as const)
          : ("The model could not be verified" as const),
      requestedModel: isDefaultModelAlias(requested) ? DEFAULT_MODEL_LABEL : requested,
      observedModel: concreteObserved,
      message: turnModel.modelSelectionMessage ?? null,
    };
  }
  return concreteObserved ? { kind: "reported" as const, model: concreteObserved } : null;
}
