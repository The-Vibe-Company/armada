"use client";

import { CircleAlertIcon, CircleCheckIcon, Loader2Icon } from "lucide-react";
import { type ComponentProps, type ReactNode, useActionState, useCallback, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action";
import { cn } from "@/lib/utils";

type Props = {
  action: (previous: ActionResult | null, data: FormData) => Promise<ActionResult>;
  children: ReactNode;
  className?: string;
  /** Empty the fields once the action succeeded (a pasted key must not linger in the page). */
  resetOnSuccess?: boolean;
  /** Pinned under the fields with the result above it, so the outcome sits next to the action that caused it. */
  footer?: ReactNode;
  footerClassName?: string;
  /** Move focus to a failure, so a person who submitted from a long form lands on what to fix. */
  focusError?: boolean;
  /**
   * Confirm a success with this toast title instead of the inline line, for a form the success moves or removes (a
   * golden shared into another list). A failure stays inline: the form is still there to retry.
   */
  successToast?: string;
};

/** A form bound to a server action, with its result shown under the fields. */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = false,
  footer,
  footerClassName,
  focusError = false,
  successToast,
}: Props) {
  const toast = useToast();
  // Raised by the action, not by an effect on its state: the refresh that follows may unmount this form.
  const run = useCallback(
    async (previous: ActionResult | null, data: FormData) => {
      const next = await action(previous, data);
      if (next.ok && successToast !== undefined) toast({ tone: "success", title: successToast });
      return next;
    },
    [action, successToast, toast],
  );
  const [state, formAction] = useActionState(run, null);
  const form = useRef<HTMLFormElement>(null);
  const message = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (resetOnSuccess && state?.ok) form.current?.reset();
  }, [state, resetOnSuccess]);

  useEffect(() => {
    if (focusError && state && !state.ok) message.current?.focus();
  }, [state, focusError]);

  const result = state && !(state.ok && successToast !== undefined) && (
    <p
      ref={message}
      tabIndex={focusError && !state.ok ? -1 : undefined}
      role={state.ok ? "status" : "alert"}
      className={cn(
        "flex items-start gap-1.5 text-sm outline-none animate-in fade-in-0 duration-200",
        state.ok ? "text-success" : "text-destructive",
      )}
    >
      {state.ok ? (
        <CircleCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      ) : (
        <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      )}
      <span className="min-w-0">{state.ok ? state.message : state.error}</span>
    </p>
  );
  return (
    <form ref={form} action={formAction} className={className}>
      {children}
      {footer === undefined ? (
        result
      ) : (
        <div className={footerClassName}>
          {result}
          {footer}
        </div>
      )}
    </form>
  );
}

export function SubmitButton({ children, ...props }: ComponentProps<typeof Button>) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || props.disabled} {...props}>
      {pending && <Loader2Icon className="animate-spin" />}
      {children}
    </Button>
  );
}
