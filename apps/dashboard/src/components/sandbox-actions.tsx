"use client";

import type { SandboxStatus } from "@armada/core";
import { Loader2Icon, SquareIcon } from "lucide-react";
import { useActionState, useCallback } from "react";
import { stopSandbox } from "@/app/actions/sandboxes";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action";
import { toastFromResult } from "@/lib/toast";

const CAN_STOP: readonly SandboxStatus[] = ["starting", "ready", "running"];

/** Messages go through the conversation's composer; the header keeps the machine's own action. */
export function SandboxActions({ sandboxId, status }: { sandboxId: string; status: SandboxStatus }) {
  return CAN_STOP.includes(status) ? <StopButton sandboxId={sandboxId} compact /> : null;
}

/**
 * Stops a sandbox after asking. `compact` is the sandbox header's: the quieter outline, and on a phone the icon alone
 * (the word stays its name) so the header keeps to one row. Elsewhere (the fleet board, the account choice) it is the
 * solid, labelled button. The dialog closes on confirm, so the result is a toast: the button itself may leave the page
 * once the sandbox is stopped.
 */
export function StopButton({
  sandboxId,
  size,
  compact = false,
}: {
  sandboxId: string;
  size?: "sm";
  compact?: boolean;
}) {
  const toast = useToast();
  // The toast is raised by the action itself, not by an effect on its state: the button unmounts with the refresh.
  const stop = useCallback(
    async (previous: ActionResult | null, data: FormData) => {
      const result = await stopSandbox(previous, data);
      toast(toastFromResult(result, "The sandbox was not stopped"));
      return result;
    },
    [toast],
  );
  const [, action, pending] = useActionState(stop, null);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant={compact ? "destructive-outline" : "destructive"}
          size={size}
          disabled={pending}
          className={compact ? "max-sm:px-2.5" : undefined}
        >
          {pending ? <Loader2Icon className="animate-spin" /> : <SquareIcon />}
          <span className={compact ? "max-sm:sr-only" : undefined}>Stop</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop this sandbox?</AlertDialogTitle>
          <AlertDialogDescription>
            The machine is removed. Its disk and conversations are kept, so you can resume later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <form action={action}>
            <input type="hidden" name="sandbox" value={sandboxId} />
            <AlertDialogAction type="submit" variant="destructive">
              Stop sandbox
            </AlertDialogAction>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
