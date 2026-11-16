import { isRedirectError } from "next/dist/client/components/redirect-error";
import type { ActionResult } from "./action";

export const UNCONFIRMED_MUTATION =
  "Completion is unconfirmed. Your request may already have completed. Check the saved resource or reload before retrying.";

/**
 * Only use at the browser/server-action boundary: a lost reply does not prove a refused write.
 * Redirects remain Next control flow. Never echo thrown messages (they can contain submitted secrets).
 * No retry or request-key changes happen here.
 */
export async function clientMutation<T extends ActionResult>(
  request: () => Promise<T>,
): Promise<T | (Extract<ActionResult, { ok: false }> & { pending: true; created?: never })> {
  try {
    return await request();
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return { ok: false, error: UNCONFIRMED_MUTATION, pending: true };
  }
}
