"use client";

import { useActionState, useCallback } from "react";
import {
  clientMutation,
  isUnconfirmedMutation,
  type MutationResult,
  type UnconfirmedMutation,
} from "@/lib/client-mutation";

/**
 * Recover lost replies without replacing the last confirmed action state.
 * In particular, no synthetic failure is passed to actions with specialized result contracts.
 */
export function useMutationState<T extends MutationResult>(action: (previous: T | null, data: FormData) => Promise<T>) {
  type State = { confirmed: T | null; displayed: T | UnconfirmedMutation | null };
  const run = useCallback(
    async (previous: State, data: FormData): Promise<State> => {
      const result = await clientMutation(() => action(previous.confirmed, data));
      return {
        confirmed: isUnconfirmedMutation(result) ? previous.confirmed : result,
        displayed: result,
      };
    },
    [action],
  );
  const [state, dispatch, pending] = useActionState(run, { confirmed: null, displayed: null });
  return [state.displayed, dispatch, pending] as const;
}
