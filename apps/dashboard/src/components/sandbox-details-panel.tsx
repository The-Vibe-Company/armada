"use client";

import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * The sandbox's details beside its conversation. On a large screen they are a column of their own; on a smaller one
 * they fold behind one button under the conversation and, open, take the history's place while the composer stays.
 */
export function SandboxDetailsPanel({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
  const section = useRef<HTMLElement>(null);
  const [mobileTarget, setMobileTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHeaderTarget(document.getElementById("sandbox-details-toggle"));
    setOpen(window.matchMedia("(min-width: 64rem)").matches);
    const media = window.matchMedia("(max-width: 63.99rem)");
    const update = () => setMobileTarget(media.matches ? document.getElementById("sandbox-mobile-about") : null);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  function toggle(next: boolean) {
    setOpen(next);
    // On a small screen the details take the history's place; where the page cannot fit (a fallback), bring them into view.
    if (next && window.matchMedia("(max-width: 63.98rem)").matches) {
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      requestAnimationFrame(() =>
        section.current?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" }),
      );
    }
  }

  const trigger = (
    <CollapsibleTrigger asChild>
      <Button type="button" variant="outline" size="sm" className="w-full justify-between ">
        Sandbox details
        <ChevronDownIcon className={cn("transition-transform", open && "rotate-180")} aria-hidden="true" />
      </Button>
    </CollapsibleTrigger>
  );
  const panel = (
    <Collapsible open={open} onOpenChange={toggle} asChild>
      <section
        data-details-open={open}
        ref={section}
        aria-label="About"
        data-fit="side"
        className={cn("min-w-0 border-l bg-muted/10 p-4", headerTarget && !open && "hidden")}
      >
        {headerTarget ? createPortal(trigger, headerTarget) : trigger}
        <CollapsibleContent
          forceMount
          data-fit="side-content"
          className="space-y-6 max-lg:max-h-[35dvh] max-lg:overflow-y-auto max-lg:mt-3 data-[state=closed]:hidden "
        >
          {children}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
  return mobileTarget ? createPortal(panel, mobileTarget) : panel;
}
