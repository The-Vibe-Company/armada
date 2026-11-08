"use client";

import type { SandboxStatus } from "@armada/core";
import { SquareIcon } from "lucide-react";
import { useActionState } from "react";
import { sendToSandbox, stopSandbox } from "@/app/actions/sandboxes";
import { ActionForm, SubmitButton } from "@/components/action-form";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

const CAN_STOP: readonly SandboxStatus[] = ["starting", "ready", "running"];
const CAN_SEND: readonly SandboxStatus[] = ["ready", "running"];

export function SandboxActions({ sandboxId, status }: { sandboxId: string; status: SandboxStatus }) {
  return (
    <div className="flex gap-2">
      {CAN_SEND.includes(status) && (
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">Send a message</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Send a message</DialogTitle>
              <DialogDescription>
                It goes to the agent as a new prompt, or steers the turn in progress.
              </DialogDescription>
            </DialogHeader>
            <ActionForm action={sendToSandbox} resetOnSuccess className="space-y-3">
              <input type="hidden" name="sandbox" value={sandboxId} />
              <Textarea name="prompt" rows={5} required placeholder="What should the agent do?" aria-label="Message" />
              <SubmitButton>Send</SubmitButton>
            </ActionForm>
          </DialogContent>
        </Dialog>
      )}
      {CAN_STOP.includes(status) && <StopButton sandboxId={sandboxId} />}
    </div>
  );
}

function StopButton({ sandboxId }: { sandboxId: string }) {
  const [state, action, pending] = useActionState(stopSandbox, null);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" disabled={pending}>
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
