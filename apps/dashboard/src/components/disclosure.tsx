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
  children,
}: {
  summary: ReactNode;
  defaultOpen: boolean;
  quiet?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hidden = quiet && open;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={cn("h-auto justify-start gap-1 px-0 text-sm", hidden && "hidden")}
          tabIndex={hidden ? -1 : undefined}
          aria-hidden={hidden || undefined}
        >
          <ChevronRightIcon aria-hidden className={cn("size-3", open && "rotate-90")} />
          {summary}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent forceMount className={cn("data-[state=closed]:hidden", !hidden && "pt-4")}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
