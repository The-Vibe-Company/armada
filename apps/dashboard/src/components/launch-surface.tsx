"use client";

import type { SandboxPlacementProviderId } from "@armada/core";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { isSubmitShortcut } from "@/lib/shortcut";
import { ttlOptions } from "@/lib/templates";

/** One launch surface for cloud snapshots, Docker snapshots and owned machines. Controllers stay provider-specific. */
export function LaunchDialogContent({ children }: { children: ReactNode }) {
  return (
    <DialogContent
      className="sm:max-w-[640px] flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0"
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

export function LaunchTaskField({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
}) {
  return (
    <div className="space-y-2 pt-1">
      <Label htmlFor={`${idPrefix}-prompt`}>Task</Label>
      <Textarea
        id={`${idPrefix}-prompt`}
        name="prompt"
        value={value}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        rows={2}
        className="max-h-[40dvh] min-h-20"
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
            <span className="font-medium">More options</span>
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

/** A boxed word, with a searchable phone sheet. Launch forms use full phone rows; compact sentences opt into inline. */
export function LaunchChoice({
  inline = false,
  label,
  value,
  options,
  onChange,
  disabled = false,
  tone,
}: {
  inline?: boolean;
  label: string;
  value: string;
  options: readonly { value: string; label: string; group?: string | undefined; reason?: string | undefined }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  tone?: "warning" | "destructive" | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const media = matchMedia("(max-width: 639px)");
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const selected = options.find((option) => option.value === value);
  const trigger = (
    <button
      type="button"
      disabled={disabled}
      aria-label={`${label}: ${selected?.label ?? value}`}
      className={`inline-flex max-w-full items-center justify-between gap-2 rounded-md border bg-background px-2 py-0.5 align-baseline text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ${inline ? "min-h-8" : "max-sm:min-h-11 max-sm:w-full max-sm:rounded-none max-sm:border-x-0 max-sm:border-t-0 max-sm:bg-transparent max-sm:px-0"} ${tone === "destructive" ? "border-destructive text-destructive" : tone === "warning" ? "border-warning text-warning" : "text-foreground"}`}
      onClick={() => setOpen(true)}
    >
      {!inline && <span className="text-muted-foreground sm:hidden">{label}</span>}
      <span className="truncate">
        {selected?.label ?? value} <span aria-hidden="true">⌄</span>
      </span>
    </button>
  );
  const choices = (
    <Command>
      <CommandInput placeholder={`Search ${label.toLowerCase()}`} />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        {[...new Set(options.map((option) => option.group ?? ""))].map((group) => (
          <CommandGroup key={group} heading={group || undefined}>
            {options
              .filter((option) => (option.group ?? "") === group)
              .map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value || "default"}
                  keywords={[option.label, option.group ?? ""]}
                  disabled={!!option.reason}
                  onSelect={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span>
                    {option.label}
                    {option.reason && <span className="block text-xs text-muted-foreground">{option.reason}</span>}
                  </span>
                  {option.value === value && (
                    <span className="ml-auto">
                      <CheckIcon aria-hidden="true" className="size-4" />
                      <span className="sr-only">Selected</span>
                    </span>
                  )}
                </CommandItem>
              ))}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  );
  if (phone)
    return (
      <>
        <span className={inline ? "inline" : "block"}>{trigger}</span>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
            <SheetTitle>{label}</SheetTitle>
            {choices}
          </SheetContent>
        </Sheet>
      </>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        {choices}
      </PopoverContent>
    </Popover>
  );
}

export function LaunchLocation({
  provider,
  start,
  repositories = [],
  project = "",
  onProject,
  idleDelaySeconds,
  starts,
  onStart,
  lockedStart = false,
}: {
  provider: SandboxPlacementProviderId;
  lockedStart?: boolean;
  start: string;
  repositories?: readonly string[];
  project?: string;
  onProject?: (value: string) => void;
  idleDelaySeconds?: number | undefined;
  starts?:
    | readonly { value: string; label: string; group?: string | undefined; reason?: string | undefined }[]
    | undefined;
  onStart?: ((value: string) => void) | undefined;
}) {
  const [ttl, setTtl] = useState("");
  return (
    <div className="space-y-2">
      <div className="text-sm leading-loose text-muted-foreground">
        <span className="max-sm:hidden">It starts from </span>
        <span className="whitespace-nowrap max-sm:block">
          <LaunchChoice
            disabled={lockedStart}
            label="Starts from"
            value={start}
            options={starts ?? [{ value: start, label: start }]}
            onChange={(value) => onStart?.(value)}
          />
          <span className="max-sm:hidden">{provider !== "docker" ? "," : ""}</span>
        </span>
        {provider !== "docker" && (
          <>
            <span className="max-sm:hidden"> works in the </span>
            <LaunchChoice
              label="Folder"
              value={project}
              options={[
                { value: "", label: "Default directory" },
                ...repositories.map((value) => ({ value, label: value })),
              ]}
              onChange={(value) => onProject?.(value)}
            />
            <span className="max-sm:hidden"> folder</span>
            <input type="hidden" name="repo" value={project} />
          </>
        )}
        <span className="max-sm:hidden"> and runs for up to </span>
        <span className="whitespace-nowrap">
          <LaunchChoice
            label="Runs for up to"
            value={ttl}
            options={ttlOptions(provider).map((option) => (option.value ? option : { value: "", label: "4 hours" }))}
            onChange={setTtl}
          />
          <span className="max-sm:hidden">.</span>
        </span>
        <input type="hidden" name="ttl" value={ttl} />
      </div>
      <p className="text-xs text-muted-foreground">
        {idleDelaySeconds === undefined
          ? "The machine pauses without activity"
          : `The machine pauses after ${Math.ceil(idleDelaySeconds / 60)} minutes without activity`}{" "}
        and wakes on your next message, until the time is up.
      </p>
      {provider === "docker" && (
        <p className="text-xs text-muted-foreground">
          The first launch on your own server downloads Armada’s base image; it can take a few minutes.
        </p>
      )}
    </div>
  );
}
