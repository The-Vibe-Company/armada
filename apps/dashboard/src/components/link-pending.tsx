"use client";

import { Loader2Icon } from "lucide-react";
import { useLinkStatus } from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Inside a `Link`: its icon, turned into a spinner while the navigation it started is on its way.
 * `data-pending` lets the link style itself as current at once. The spinner fades in after 100 ms,
 * so a fast navigation never flashes it.
 */
export function LinkPendingIcon({ children, className }: { children?: ReactNode; className?: string }) {
  const { pending } = useLinkStatus();
  return (
    <span
      data-pending={pending || undefined}
      className={cn("relative inline-flex size-4 shrink-0 [&_svg]:size-4", className)}
    >
      {children && (
        <span className={cn("inline-flex transition-opacity", pending && "opacity-0 delay-100")}>{children}</span>
      )}
      <Loader2Icon
        aria-hidden
        className={cn("absolute inset-0 animate-spin opacity-0 transition-opacity", pending && "opacity-100 delay-100")}
      />
    </span>
  );
}
