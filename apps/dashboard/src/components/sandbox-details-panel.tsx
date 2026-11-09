"use client";

import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The sandbox's details beside its conversation. On a large screen they are a column of their own; on a smaller one
 * they fold behind one button under the conversation and, open, take the history's place while the composer stays.
 */
export function SandboxDetailsPanel({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const section = useRef<HTMLElement>(null);

  function toggle() {
    const next = !open;
    setOpen(next);
    // On a small screen the details take the history's place; where the page cannot fit (a fallback), bring them into view.
    if (next && window.matchMedia("(max-width: 63.98rem)").matches) {
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      requestAnimationFrame(() =>
        section.current?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" }),
      );
    }
  }

  return (
    <section ref={section} aria-label="Details" data-fit="side" className="min-w-0">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full justify-between lg:hidden"
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
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
