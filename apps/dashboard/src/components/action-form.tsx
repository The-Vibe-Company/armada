"use client";

import { Loader2Icon } from "lucide-react";
import { type ComponentProps, type ReactNode, useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
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
}: Props) {
  const [state, formAction] = useActionState(action, null);
  const form = useRef<HTMLFormElement>(null);
  const message = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (resetOnSuccess && state?.ok) form.current?.reset();
  }, [state, resetOnSuccess]);

  useEffect(() => {
    if (focusError && state && !state.ok) message.current?.focus();
  }, [state, focusError]);

  const result = state && (
    <p
      ref={message}
      tabIndex={focusError && !state.ok ? -1 : undefined}
      role={state.ok ? "status" : "alert"}
      className={cn("text-sm outline-none", state.ok ? "text-success" : "text-destructive")}
    >
      {state.ok ? state.message : state.error}
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
