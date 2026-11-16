"use client";

import type { SandboxStatus } from "@armada/core";
import { Loader2Icon, MoreHorizontalIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useActionState, useCallback } from "react";
import { deleteSandbox, stopSandbox } from "@/app/actions/sandboxes";
import { ShellPageActions } from "@/components/shell-page-actions";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action";
import { clientMutation } from "@/lib/client-mutation";
import { toastFromResult } from "@/lib/toast";

const CAN_STOP: readonly SandboxStatus[] = ["starting", "ready", "running"];

/** Messages go through the conversation's composer; the header keeps the machine's own action. */
export function SandboxActions({
  sandboxId,
  status,
  canStop = true,
  canDelete = false,
  stopDescription,
}: {
  sandboxId: string;
  status: SandboxStatus;
  /** False where the server does not support stopping this sandbox: the reason is shown on the page instead. */
  canStop?: boolean;
  /** Offered only where the server supports deleting it (a Docker sandbox), once it is stopped or failed. */
  canDelete?: boolean;
  stopDescription?: string;
}) {
  if (canStop && CAN_STOP.includes(status))
    return (
      <ShellPageActions>
        <Popover>
          <PopoverTrigger asChild>
            <Button size="icon" variant="ghost" aria-label="Sandbox actions">
              <MoreHorizontalIcon />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 space-y-2">
            <StopButton
              sandboxId={sandboxId}
              size="sm"
              {...(stopDescription ? { description: stopDescription } : {})}
            />
            <p className="text-xs text-muted-foreground">
              {stopDescription ?? "The machine is removed; disk and conversation are kept. A message starts it again."}
            </p>
          </PopoverContent>
        </Popover>
      </ShellPageActions>
    );
  if (canDelete && CAN_DELETE.includes(status))
    return (
      <ShellPageActions>
        <DeleteButton sandboxId={sandboxId} />
      </ShellPageActions>
    );
  return null;
}

const CAN_DELETE: readonly SandboxStatus[] = ["stopped", "failed"];

/** Deletes a stopped or failed sandbox after asking; a success goes back to the sandboxes. */
function DeleteButton({ sandboxId }: { sandboxId: string }) {
  const toast = useToast();
  const remove = useCallback(
    async (previous: ActionResult | null, data: FormData) => {
      const result = await clientMutation(() => deleteSandbox(previous, data));
      toast(toastFromResult(result, "Delete request not confirmed"));
      return result;
    },
    [toast],
  );
  const [, action, pending] = useActionState(remove, null);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive-outline" disabled={pending} className="max-sm:px-2.5">
          {pending ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
          <span className="max-sm:sr-only">Delete</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this sandbox?</AlertDialogTitle>
          <AlertDialogDescription>
            Its container and workspace are removed from the host for good. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <form action={action}>
            <input type="hidden" name="sandbox" value={sandboxId} />
            <AlertDialogAction type="submit" variant="destructive">
              Delete sandbox
            </AlertDialogAction>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
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
  description = "The machine is removed. Its disk and conversations are kept, so you can resume later.",
}: {
  sandboxId: string;
  size?: "sm";
  compact?: boolean;
  /** What stopping does on this sandbox's provider. */
  description?: string;
}) {
  const toast = useToast();
  // The toast is raised by the action itself, not by an effect on its state: the button unmounts with the refresh.
  const stop = useCallback(
    async (previous: ActionResult | null, data: FormData) => {
      const result = await clientMutation(() => stopSandbox(previous, data));
      toast(toastFromResult(result, "Stop request not confirmed"));
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
          <AlertDialogDescription>{description}</AlertDialogDescription>
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
