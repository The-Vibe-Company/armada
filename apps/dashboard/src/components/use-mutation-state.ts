"use client";

import { useActionState, useCallback } from "react";
import type { ActionResult } from "@/lib/action";
import { clientMutation } from "@/lib/client-mutation";

/** Recover rejected remote actions as local results, without unmounting the draft. */
export function useMutationState(action: (previous: ActionResult | null, data: FormData) => Promise<ActionResult>) {
  const run = useCallback(
    (previous: ActionResult | null, data: FormData): Promise<ActionResult & { pending?: true; created?: true }> =>
      clientMutation(() => action(previous, data)),
    [action],
  );
  return useActionState(run, null);
}
