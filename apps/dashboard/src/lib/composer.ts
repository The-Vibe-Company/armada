import { type LaunchKey, launchKeyFor } from "./launch-key.ts";
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

/** Runtime-backed sandboxes keep the model and effort chosen at launch for every message. */
export const PINNED_MODEL = "This sandbox keeps the model and effort chosen at launch for every message.";

/** The form field carrying one message's request key: the same on a retry of the same message. */
export const SEND_KEY_FIELD = "send_key";

/**
 * A pinned runtime send: the server admits it once per request key, so a retry of the same message never runs twice, and it
 * keeps the launch model and effort, so no override is sent.
 */
export function pinnedSend(
  fields: ModelFields,
  key: string,
): { ok: true; requestId: string } | { ok: false; error: string } {
  if (modelChange(fields) !== "none") return { ok: false, error: PINNED_MODEL };
  if (!UUID.test(key)) return { ok: false, error: "That request is not valid. Reload the page and send it again." };
  return { ok: true, requestId: key };
}

/** Lowercase, as the server checks it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A runtime send failure as a person reads it: a server sentence that names an API field (`request_id`) becomes plain
 * words. The composer keeps the message's request key until submitted choices change, so sending it again unchanged is the safe
 * retry the server asks for; a pending admission may still run, so it is never called a failure.
 */
export function plainSendFailure(message: string): string {
  if (!/\b[a-z]+_[a-z_]+\b/.test(message)) return message;
  return /\b(pending|uncertain|unknown)\b/i.test(message)
    ? "The message has not been confirmed and may still run. Keep it unchanged and check the sandbox status before retrying."
    : "The message could not be delivered. Send it again.";
}

/** Identical retry keeps its key; every submitted instruction/model choice participates. */
export function messageKeyFor(previous: LaunchKey | null, data: FormData, fresh?: () => string): LaunchKey {
  return launchKeyFor(
    previous,
    ["sandbox", "prompt", "conversation", "model", "other_model", "reasoning_effort"].map(
      (field) => [field, String(data.get(field) ?? "")] as [string, string],
    ),
    fresh,
  );
}
