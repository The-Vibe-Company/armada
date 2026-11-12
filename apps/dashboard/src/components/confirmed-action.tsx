"use client";

import { Loader2Icon } from "lucide-react";
import { type ReactNode, useActionState, useEffect, useRef, useState } from "react";
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
import type { ActionResult } from "@/lib/action";

/** Confirm an existing server action; a refusal stays here to explain the problem and allow a retry. */
export function ConfirmedAction({
  action,
  trigger,
  triggerLabel,
  title,
  description,
  confirm,
  pendingLabel,
  successFocusId,
  children,
}: {
  action: (previous: ActionResult | null, data: FormData) => Promise<ActionResult>;
  trigger: string;
  triggerLabel?: string;
  title: string;
  description: string;
  confirm: string;
  pendingLabel: string;
  /** The replacement control to focus when success removes this trigger. */
  successFocusId: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<{ message: string } | null>(null);
  const message = useRef<HTMLParagraphElement>(null);
  const succeeded = useRef(false);
  const [, submit, pending] = useActionState<ActionResult | null, FormData>(async (previous, data) => {
    const result = await action(previous, data);
    if (result.ok) {
      succeeded.current = true;
      setOpen(false);
    } else {
      setError({ message: result.error });
    }
    return result;
  }, null);

  useEffect(() => {
    if (error) message.current?.focus();
  }, [error]);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (next) {
          setError(null);
          succeeded.current = false;
        }
        setOpen(next);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={triggerLabel}>
          {trigger}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          if (succeeded.current) {
            event.preventDefault();
            document.getElementById(successFocusId)?.focus();
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <form action={submit} className="space-y-4" aria-busy={pending}>
          {children}
          {error && (
            <p ref={message} tabIndex={-1} role="alert" className="text-sm text-destructive outline-none">
              {error.message}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending && <Loader2Icon aria-hidden="true" className="animate-spin" />}
              {pending ? pendingLabel : confirm}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
