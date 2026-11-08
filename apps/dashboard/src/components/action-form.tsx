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
};

/** A form bound to a server action, with its result shown under the fields. */
export function ActionForm({ action, children, className, resetOnSuccess = false }: Props) {
  const [state, formAction] = useActionState(action, null);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (resetOnSuccess && state?.ok) form.current?.reset();
  }, [state, resetOnSuccess]);

  return (
    <form ref={form} action={formAction} className={className}>
      {children}
      {state && (
        <p
          role={state.ok ? "status" : "alert"}
          className={cn("text-sm", state.ok ? "text-success" : "text-destructive")}
        >
          {state.ok ? state.message : state.error}
        </p>
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
