import { describeFailure } from "./failure.ts";
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

/** On an owned Docker host the model and effort chosen at launch serve every message (#1526). */
export const PINNED_MODEL = "This sandbox keeps the model and effort chosen at launch for every message.";

/** The form field carrying one Docker message's request key: the same on a retry of the same message. */
export const SEND_KEY_FIELD = "send_key";

/**
 * A Docker send: the server admits it once per request key, so a retry of the same message never runs twice, and it
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

export const UNCONFIRMED_ACTION = "This action could not be confirmed. Check the conversation before trying again.";

/** Only curated guidance reaches the composer, never an arbitrary API/provider sentence. */
export function drivingFailureMessage(
  error: { message: string; code?: string | undefined; status?: number | undefined },
  owner: boolean,
  keyedSend = false,
): string {
  if (error.code === "credential_binding_required")
    return owner
      ? "This sandbox needs an account before it can resume. Choose one above."
      : "This sandbox needs an account before it can resume. Only its owner can choose it.";
  const known = describeFailure(error.code);
  if (known) return known.hint;
  if (error.status === 401 || error.status === 403)
    return "This session cannot access the sandbox. Sign in again, or ask an organization admin to check your access.";
  return keyedSend ? plainSendFailure(error.message) : UNCONFIRMED_ACTION;
}

/** A keyed Docker retry checks the same admission; never suggest editing or starting a second message. */
function plainSendFailure(message: string): string {
  return /\b(pending|uncertain|unknown)\b/i.test(message)
    ? "The message has not been confirmed and may still run. Keep it unchanged and check the sandbox status before retrying."
    : "The host could not confirm delivery. Send the same message again without editing it to check.";
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
