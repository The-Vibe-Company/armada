"use client";

import { Loader2Icon, Trash2Icon } from "lucide-react";
import { useActionState } from "react";
import { removeGolden } from "@/app/actions/goldens";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/**
 * Removes a golden after a confirmation that says what stays: its sandboxes, their conversations and logs, and the
 * provider's snapshot. The dialog stays open on a refusal so the reason is read where the action was taken.
 */
export function RemoveGolden({
  goldenId,
  orgId,
  name,
  providerLabel,
}: {
  goldenId: string;
  orgId: string;
  name: string;
  providerLabel: string;
}) {
  const [state, action, pending] = useActionState(removeGolden, null);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive">
          <Trash2Icon /> Remove golden
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Remove {name} on {providerLabel}?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>New sandboxes can no longer be launched from it, and it leaves this list.</p>
              <p>
                Sandboxes already started from it stay, with their conversations and logs. Its snapshot and state
                artifacts are kept. Any existing backend reservation is retained.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {state && !state.ok && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <form action={action}>
            <input type="hidden" name="golden" value={goldenId} />
            <input type="hidden" name="org" value={orgId} />
            <Button type="submit" variant="destructive" disabled={pending} className="w-full">
              {pending && <Loader2Icon className="animate-spin" />}
              Remove golden
            </Button>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
