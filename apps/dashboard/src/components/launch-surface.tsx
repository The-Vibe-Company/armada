"use client";

import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, type RefObject, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { isSubmitShortcut } from "@/lib/shortcut";

/** One launch surface for cloud snapshots, Docker snapshots and owned machines. Controllers stay provider-specific. */
export function LaunchDialogContent({ children }: { children: ReactNode }) {
  return (
    <DialogContent
      className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0"
      onOpenAutoFocus={(event) => {
        const task = (event.target as HTMLElement | null)?.querySelector<HTMLElement>('textarea[name="prompt"]');
        if (!task) return;
        event.preventDefault();
        task.focus();
      }}
    >
      {children}
    </DialogContent>
  );
}

export function LaunchDialogHeader({ title, description }: { title: ReactNode; description: ReactNode }) {
  return (
    <DialogHeader className="px-6 pt-6 pb-4 pr-12">
      <DialogTitle className="break-words">{title}</DialogTitle>
      <DialogDescription>{description}</DialogDescription>
    </DialogHeader>
  );
}

/** Only the fields scroll; the form's action footer stays outside this region. */
export function LaunchFields({ children }: { children: ReactNode }) {
  return (
    <div data-launch-fields className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 pb-4">
      {children}
    </div>
  );
}

export function LaunchTaskField({ idPrefix }: { idPrefix: string }) {
  return (
    <div className="space-y-2 pt-1">
      <Label htmlFor={`${idPrefix}-prompt`}>Task</Label>
      <Textarea
        id={`${idPrefix}-prompt`}
        name="prompt"
        rows={4}
        className="max-h-[40dvh] min-h-24"
        placeholder="What should the agent do? Leave empty to start idle."
      />
    </div>
  );
}

export function LaunchAdvanced({
  children,
  summary,
  open,
  onOpenChange,
}: {
  children: ReactNode;
  summary?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} data-launch-advanced className="group rounded-md border">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="flex h-auto w-full items-center justify-start gap-3 whitespace-normal rounded-md px-3 py-2.5 text-sm"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
            <span className="font-medium">Advanced</span>
            {summary}
          </span>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none group-data-[state=open]:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent forceMount className="space-y-4 border-t p-3 data-[state=closed]:hidden">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Fit the visible phone viewport (including its keyboard) and share the same deliberate submit shortcut. */
export function useLaunchSurface(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const viewport = window.visualViewport;
    const content = root.current?.closest<HTMLElement>('[data-slot="dialog-content"]');
    const fields = root.current?.querySelector<HTMLElement>("[data-launch-fields]");
    if (!viewport || !content || !fields) return;
    const release = () => {
      content.style.removeProperty("top");
      content.style.removeProperty("max-height");
      content.style.removeProperty("transition-property");
      delete content.dataset.visibleViewport;
    };
    const fit = () => {
      // A pinch zoom also shrinks the visual viewport; only a keyboard does so at scale 1.
      if (viewport.scale > 1 || (window.innerHeight - viewport.height < 1 && viewport.offsetTop < 1)) return release();
      // No easing: the bounds apply now, so the focused field below is measured where it will stay.
      content.style.transitionProperty = "none";
      content.style.top = `${viewport.offsetTop + viewport.height / 2}px`;
      content.style.maxHeight = `${Math.max(viewport.height - 16, 0)}px`;
      content.dataset.visibleViewport = "";
      // Only the fields scroll: bring the focused one into their region, never the page behind the dialog.
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !fields.contains(active)) return;
      const box = active.getBoundingClientRect();
      const region = fields.getBoundingClientRect();
      if (box.bottom > region.bottom) fields.scrollTop += Math.min(box.bottom - region.bottom, box.top - region.top);
      else if (box.top < region.top) fields.scrollTop -= region.top - box.top;
    };
    fit();
    viewport.addEventListener("resize", fit);
    viewport.addEventListener("scroll", fit);
    fields.addEventListener("focusin", fit);
    return () => {
      viewport.removeEventListener("resize", fit);
      viewport.removeEventListener("scroll", fit);
      fields.removeEventListener("focusin", fit);
      release();
    };
  }, [root]);
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    // ⌘↵ launches from any field, as the composer sends. It goes through the Launch button, so a held or pending
    // launch (the button is disabled) is not submitted by the keyboard either.
    const shortcut = (event: KeyboardEvent) => {
      if (!isSubmitShortcut(event)) return;
      event.preventDefault();
      const button = node.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (button && !button.disabled) button.form?.requestSubmit(button);
    };
    node.addEventListener("keydown", shortcut);
    return () => node.removeEventListener("keydown", shortcut);
  }, [root]);
}
