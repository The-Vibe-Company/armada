"use client";

import type { SandboxPlacementProviderId } from "@armada/core";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { ProviderMark } from "@/components/provider-mark";
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
import { cn } from "@/lib/utils";

/** One launch surface for cloud snapshots, Docker snapshots and owned machines. Controllers stay provider-specific. */
export function LaunchDialogContent({ children }: { children: ReactNode }) {
  return (
    <DialogContent
      className="sm:max-w-[620px] flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden rounded-[14px] p-0"
      onEscapeKeyDown={(event) => {
        const root = (event.target as HTMLElement | null)?.closest('[data-slot="dialog-content"]');
        const trigger = root?.querySelector<HTMLButtonElement>('[data-launch-disclosure][aria-expanded="true"]');
        if (trigger) {
          event.preventDefault();
          trigger.click();
          trigger.focus();
        }
      }}
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
    <DialogHeader className="border-b px-5 py-3.5 pr-12 text-left">
      <DialogTitle className="break-words text-[15px] font-semibold">{title}</DialogTitle>
      <DialogDescription className="sr-only">{description}</DialogDescription>
    </DialogHeader>
  );
}

/** Only the fields scroll; the form's action footer stays outside this region. */
export function LaunchFields({ children }: { children: ReactNode }) {
  return (
    <div data-launch-fields className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-5 py-[18px]">
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
    <div className="space-y-2">
      <Label className="text-[13px]" htmlFor={`${idPrefix}-prompt`}>
        Task
      </Label>
      <Textarea
        id={`${idPrefix}-prompt`}
        name="prompt"
        value={value}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        rows={5}
        className="max-h-[40dvh] min-h-[138px] resize-y rounded-[10px] bg-background px-3.5 py-3 text-[14.5px] leading-[1.55]"
        placeholder="What should the agent do? Leave it empty to start the sandbox idle."
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
          className="flex h-auto w-full items-center justify-start gap-3 text-left whitespace-normal rounded-md px-3 py-2.5 text-sm"
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

/** Keep picker fields inside the form and mounted, so closed settings still submit. */
export function LaunchSetting({
  label,
  value,
  description,
  mark,
  children,
}: {
  label: string;
  value: ReactNode;
  description?: ReactNode;
  mark?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <fieldset className="min-w-0" aria-label={`${label} settings`}>
      <button
        type="button"
        data-launch-disclosure
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        aria-label={`${label} settings`}
        className="grid min-h-[53px] w-full grid-cols-[84px_minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-2 text-left text-[13px] hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="text-muted-foreground">{label}</span>
        <span className="flex min-w-0 items-center gap-2.5">
          {mark}
          <span className="min-w-0">
            <span className="block truncate font-medium">{value}</span>
            <span className="block truncate text-xs text-muted-foreground">{description}</span>
          </span>
        </span>
        <span aria-hidden className="flex items-center gap-1 text-xs text-muted-foreground">
          Change <ChevronDownIcon className="size-3.5" />
        </span>
      </button>

      <div hidden={!open} className="max-h-[60dvh] overflow-y-auto border-t bg-popover p-3 text-popover-foreground">
        {children}
      </div>
    </fieldset>
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

/** A settings row with a searchable picker; compact catalog controls can opt into inline. */
export function LaunchChoice({
  presentation = "picker",
  inline = false,
  label,
  value,
  options,
  onChange,
  disabled = false,
  tone,
}: {
  presentation?: "picker" | "chips";
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
      className={`${inline ? "inline-flex max-w-full min-h-8 items-center justify-between gap-2 rounded-md border bg-background px-2 py-0.5" : "grid w-full min-h-[52px] grid-cols-[84px_minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-2 text-left"} text-[13px] hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ${tone === "destructive" ? "text-destructive" : tone === "warning" ? "text-warning" : "text-foreground"}`}
      onClick={() => setOpen(true)}
    >
      {!inline && <span className="text-muted-foreground">{label}</span>}
      <span className="min-w-0 truncate font-medium">{selected?.label ?? value}</span>
      <span aria-hidden="true" className="flex items-center gap-1 text-xs text-muted-foreground">
        {!inline && <span className="max-sm:sr-only">Change</span>}
        <ChevronDownIcon className="size-3.5" />
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
  if (presentation === "chips" && options.length <= 8)
    return (
      <fieldset aria-label={label} className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <Button
            key={option.value}
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={option.value === value}
            disabled={disabled || !!option.reason}
            title={option.reason}
            onClick={() => onChange(option.value)}
            className={cn("h-8 rounded-[7px] text-[13px]", option.value === value && "border-primary bg-primary/10")}
          >
            {option.label}
          </Button>
        ))}
      </fieldset>
    );
  if (phone)
    return (
      <>
        <span className={inline ? "inline" : "block border-b last:border-b-0"}>{trigger}</span>
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
  compact = false,
}: {
  compact?: boolean;
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
  if (compact)
    return (
      <LaunchSetting
        label="From"
        value={starts?.find((x) => x.value === start)?.label ?? start}
        description={`${repositories.join(", ")} · ${provider}`}
        mark={<ProviderMark provider={provider} />}
      >
        <LaunchChoice
          disabled={lockedStart}
          label="From"
          value={start}
          options={starts ?? [{ value: start, label: start }]}
          onChange={(value) => onStart?.(value)}
        />
        {provider !== "docker" && (
          <>
            <LaunchChoice
              label="Folder"
              value={project}
              options={[{ value: "", label: "default" }, ...repositories.map((value) => ({ value, label: value }))]}
              onChange={(value) => onProject?.(value)}
            />
            <input type="hidden" name="repo" value={project} />
          </>
        )}
      </LaunchSetting>
    );
  return (
    <div data-launch-location className="space-y-2">
      <div className="overflow-hidden rounded-[10px] border [&>button]:border-b [&>button:last-of-type]:border-b-0">
        <LaunchChoice
          disabled={lockedStart}
          label="Starts from"
          value={start}
          options={starts ?? [{ value: start, label: start }]}
          onChange={(value) => onStart?.(value)}
        />
        {provider !== "docker" && (
          <>
            <LaunchChoice
              label="Folder"
              value={project}
              options={[{ value: "", label: "default" }, ...repositories.map((value) => ({ value, label: value }))]}
              onChange={(value) => onProject?.(value)}
            />
            <input type="hidden" name="repo" value={project} />
          </>
        )}
        <LaunchChoice
          label="Runs for up to"
          value={ttl}
          options={ttlOptions(provider).map((option) => (option.value ? option : { value: "", label: "4 hours" }))}
          onChange={setTtl}
        />
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
