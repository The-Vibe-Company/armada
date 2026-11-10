"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** How long the confirmation stays before the button reads "Copy" again. */
const CONFIRM_MS = 1600;

/**
 * Copies one value (an id, a command) to the clipboard and says so at once: the icon turns to a check and a polite
 * live region announces it. `label` names what is copied ("Copy sandbox ID"). A refused clipboard says that instead.
 */
export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    timer.current = setTimeout(() => setState("idle"), CONFIRM_MS);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={copy}
      aria-label={label}
      title={label}
      data-copy-state={state}
      className={cn("text-muted-foreground hover:text-foreground", state === "copied" && "text-success", className)}
    >
      {state === "copied" ? <CheckIcon className="animate-in zoom-in-50 duration-150" /> : <CopyIcon />}
      {/* A polite live region without the status role, so it never stands in for a form's own result. */}
      <span aria-live="polite" className="sr-only">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : ""}
      </span>
    </Button>
  );
}
