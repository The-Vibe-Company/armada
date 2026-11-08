"use client";

import { type ReactNode, useState } from "react";

/**
 * A native `<details>` whose open state belongs to the person, not to the server render: when an action
 * revalidates the page and the default changes, an open form (and the result it shows) stays open.
 */
export function Disclosure({
  summary,
  defaultOpen,
  children,
}: {
  summary: ReactNode;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm font-medium">{summary}</summary>
      <div className="pt-4">{children}</div>
    </details>
  );
}
