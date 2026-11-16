"use client";

import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** User-owned expansion survives server refreshes; mounted fields retain drafts and build/admission state. */
export function Disclosure({
  summary,
  defaultOpen,
  quiet = false,
  onOpenChange,
  open: controlledOpen,
  children,
}: {
  summary: ReactNode;
  defaultOpen: boolean;
  quiet?: boolean;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  children: ReactNode;
}) {
  const [localOpen, setOpen] = useState(defaultOpen);
  const open = controlledOpen ?? localOpen;
  const hidden = quiet && open;
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
      }}
    >
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={cn(
            "h-auto max-w-full min-w-0 shrink justify-start gap-1 whitespace-normal px-0 text-left text-sm",
            hidden && "hidden",
          )}
          tabIndex={hidden ? -1 : undefined}
          aria-hidden={hidden || undefined}
        >
          <ChevronRightIcon aria-hidden className={cn("size-3", open && "rotate-90")} />
          <span className="min-w-0 [overflow-wrap:anywhere]">{summary}</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent forceMount className={cn("data-[state=closed]:hidden", !hidden && "pt-4")}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
