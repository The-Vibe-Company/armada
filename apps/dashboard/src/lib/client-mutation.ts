import { isRedirectError } from "next/dist/client/components/redirect-error";
import type { ActionResult } from "./action";

export const UNCONFIRMED_MUTATION =
  "Completion is unconfirmed. Your request may already have completed. Check the saved resource or reload before retrying.";

/**
 * Only use at the browser/server-action boundary: a lost reply does not prove a refused write.
 * Redirects remain Next control flow. Never echo thrown messages (they can contain submitted secrets).
 * No retry or request-key changes happen here.
 */
export type MutationResult = { ok: true } | Extract<ActionResult, { ok: false }>;
export type UnconfirmedMutation = Extract<ActionResult, { ok: false }> & {
  pending: true;
  created?: never;
  unconfirmed: true;
};

export function isUnconfirmedMutation(result: MutationResult): result is UnconfirmedMutation {
  return "unconfirmed" in result && result.unconfirmed === true;
}

export async function clientMutation<T extends MutationResult>(
  request: () => Promise<T>,
): Promise<T | UnconfirmedMutation> {
  try {
    return await request();
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return { ok: false, error: UNCONFIRMED_MUTATION, pending: true, unconfirmed: true };
  }
}
