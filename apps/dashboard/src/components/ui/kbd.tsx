import type * as React from "react";
import { cn } from "@/lib/utils";

/** A key, as printed on the keyboard. */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center gap-0.5 rounded border border-border bg-background px-1 font-sans text-[11px] font-medium text-muted-foreground shadow-xs",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
