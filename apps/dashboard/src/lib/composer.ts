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

/** On an owned Docker host the model and effort chosen at launch serve every message (#1526). */
export const PINNED_MODEL = "On your own Docker host, the model and effort chosen at launch stay for every message.";

/** The form field carrying one Docker message's request key: the same on a retry of the same message. */
export const SEND_KEY_FIELD = "send_key";

/**
 * A Docker send: the server admits it once per request key, so a retry of the same message never runs twice, and it
 * keeps the launch model and effort, so no override is sent.
 */
export function dockerSend(
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
 * A Docker send failure as a person reads it: a server sentence that names an API field (`request_id`) becomes a plain
 * retry. The composer keeps the message's request key, so sending it again is the safe retry the server asks for.
 */
export function plainSendFailure(message: string): string {
  return /\b[a-z]+_[a-z_]+\b/.test(message) ? "The message could not be delivered. Send it again." : message;
}
