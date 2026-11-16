"use client";

import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";

/** Keep page-owned forms and authorization while placing their actions in the shell. */
export function ShellPageActions({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => setTarget(document.getElementById("shell-page-actions")), []);
  const actions = <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>;
  return target ? createPortal(actions, target) : actions;
}
