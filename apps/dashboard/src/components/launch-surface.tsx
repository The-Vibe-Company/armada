"use client";

import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { isSubmitShortcut } from "@/lib/shortcut";
import { cn } from "@/lib/utils";

/** The soft keyboard can shrink the visible viewport without changing CSS viewport units. */
export function useLaunchViewport(sheet = false) {
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport || !content) return;
    const phone = matchMedia("(width < 640px)");
    const fit = () => {
      const keyboard = phone.matches && viewport.scale === 1 && viewport.height < window.innerHeight;
      if (keyboard && sheet) {
        content.style.maxHeight = `${viewport.height * 0.85}px`;
        content.style.bottom = `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`;
      } else if (keyboard) {
        content.style.height = `${viewport.height}px`;
        content.style.top = `${viewport.offsetTop + viewport.height / 2}px`;
      } else {
        for (const property of ["height", "top", "max-height", "bottom"]) content.style.removeProperty(property);
      }
    };
    fit();
    viewport.addEventListener("resize", fit);
    viewport.addEventListener("scroll", fit);
    return () => {
      viewport.removeEventListener("resize", fit);
      viewport.removeEventListener("scroll", fit);
    };
  }, [content, sheet]);
  return setContent;
}

export function LaunchDialogContent({ children }: { children: ReactNode }) {
  const dialog = useLaunchViewport();
  return (
    <DialogContent
      ref={dialog}
      className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-y-auto overscroll-contain rounded-2xl p-0 sm:max-w-[760px] max-sm:h-dvh max-sm:max-h-dvh max-sm:w-screen max-sm:max-w-none max-sm:rounded-none [&_[data-slot=dialog-close]]:pointer-coarse:grid [&_[data-slot=dialog-close]]:pointer-coarse:size-11 [&_[data-slot=dialog-close]]:pointer-coarse:place-items-center"
      onKeyDownCapture={(event) => {
        if (!isSubmitShortcut(event.nativeEvent)) return;
        const send = event.currentTarget.querySelector<HTMLButtonElement>("[data-launch-send]");
        if (!send) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) send.click();
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
