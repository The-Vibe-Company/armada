"use client";

import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The sandbox's details beside its conversation. On a large screen they are a column of their own; on a smaller one
 * they fold behind one button under the conversation, so the conversation keeps the screen.
 */
export function SandboxDetailsPanel({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section aria-label="Details" data-fit="side" className="min-w-0">
      <Button
        type="button"
        variant="outline"
        className="w-full justify-between lg:hidden"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        Details
        <ChevronDownIcon className={cn("transition-transform", open && "rotate-180")} aria-hidden="true" />
      </Button>
      <div
        id={id}
        data-fit="side-content"
        className={cn("space-y-6 max-lg:mt-3", open ? "block" : "hidden", "lg:block")}
      >
        {children}
      </div>
    </section>
  );
}
