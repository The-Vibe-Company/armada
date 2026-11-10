"use client";

import type { SandboxStatus } from "@armada/core";
import { SquareIcon } from "lucide-react";
import { useActionState } from "react";
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

const CAN_STOP: readonly SandboxStatus[] = ["starting", "ready", "running"];

/** Messages go through the conversation's composer; the header keeps the machine's own action. */
export function SandboxActions({ sandboxId, status }: { sandboxId: string; status: SandboxStatus }) {
  return CAN_STOP.includes(status) ? <StopButton sandboxId={sandboxId} /> : null;
}

export function StopButton({ sandboxId, size }: { sandboxId: string; size?: "sm" }) {
  const [state, action, pending] = useActionState(stopSandbox, null);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size={size} disabled={pending}>
          <SquareIcon /> Stop
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop this sandbox?</AlertDialogTitle>
          <AlertDialogDescription>
            The machine is removed. Its disk and conversations are kept, so you can resume later.
            {state && !state.ok && <span className="mt-2 block text-destructive">{state.error}</span>}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <form action={action}>
            <input type="hidden" name="sandbox" value={sandboxId} />
            <AlertDialogAction type="submit">Stop sandbox</AlertDialogAction>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
