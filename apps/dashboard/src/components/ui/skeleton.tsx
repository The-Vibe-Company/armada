import type * as React from "react";
import { cn } from "@/lib/utils";

/** A placeholder the size of what loads into it, so nothing moves when the data arrives. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("rounded-md bg-muted motion-safe:animate-pulse", className)}
      {...props}
    />
  );
}

export { Skeleton };
