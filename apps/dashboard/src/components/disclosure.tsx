"use client";

import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A native `<details>` whose open state belongs to the person, not to the server render: when an action
 * revalidates the page and the default changes, an open form (and the result it shows) stays open.
 */
export function Disclosure({
  summary,
  defaultOpen,
  quiet = false,
  children,
}: {
  summary: ReactNode;
  defaultOpen: boolean;
  /**
   * Leaves the summary out of sight while the content is open, for a form that is the page's purpose: the same
   * element either way, so a later render that wants the summary back keeps what was open and typed.
   */
  quiet?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hidden = quiet && open;
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary
        className={cn("cursor-pointer text-sm font-medium", hidden && "sr-only")}
        tabIndex={hidden ? -1 : undefined}
        aria-hidden={hidden || undefined}
      >
        {summary}
      </summary>
      <div className={hidden ? undefined : "pt-4"}>{children}</div>
    </details>
  );
}
