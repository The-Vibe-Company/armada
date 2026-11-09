import { type ModelFields, OTHER_MODEL } from "./model-choice.ts";

/**
 * How the composer's model fields differ from the launch choice: `changed` makes a new turn with an override (a
 * steer refuses it), `incomplete` is "Other model id" left empty, which must never fall back to the launch model.
 */
export function modelChange(fields: ModelFields): "none" | "changed" | "incomplete" {
  if (fields.model === OTHER_MODEL && !fields.otherModel.trim()) return "incomplete";
  const model = fields.model === OTHER_MODEL ? fields.otherModel : fields.model;
  return model.trim() || fields.reasoningEffort.trim() ? "changed" : "none";
}

export const INCOMPLETE_MODEL = "Enter the model id, or choose a listed model.";
export const STEER_KEEPS_MODEL = "A model or effort change needs a new turn. Send it instead.";

/** The conversation field: empty lets the server choose (a sandbox with none yet), otherwise one of this sandbox's. */
export function chosenConversation(
  value: string,
  recorded: readonly string[],
): { ok: true; id: string | undefined } | { ok: false; error: string } {
  const id = value.trim();
  if (!id) return { ok: true, id: undefined };
  return recorded.includes(id)
    ? { ok: true, id }
    : { ok: false, error: "That conversation is not part of this sandbox." };
}
