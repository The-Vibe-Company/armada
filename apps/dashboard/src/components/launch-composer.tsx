"use client";

import type { SandboxPlacementProviderId } from "@armada/core";
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, CircleAlertIcon, Loader2Icon, LockIcon } from "lucide-react";
import Link from "next/link";
import { createContext, memo, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { LaunchRepositoryContext } from "@/components/launch-repositories";
import { useLaunchViewport } from "@/components/launch-surface";
import { SubmitShortcut } from "@/components/mod-key";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { launchSendLabel, launchStopLabel, prioritizeRepositoryHold } from "@/lib/launch-composer";
import type { LaunchStartTarget } from "@/lib/launch-picker";
import { ttlOptions } from "@/lib/templates";
import { cn } from "@/lib/utils";

const ChipFocus = createContext<{
  dismiss: { current: (() => void) | null };
  restore: { current: HTMLElement | null };
} | null>(null);

export function LaunchChip({
  label,
  title = label,
  prefix,
  className,
  locked,
  warning,
  children,
  open: controlled,
  onOpenChange,
}: {
  label: string;
  title?: string;
  prefix?: ReactNode;
  className?: string;
  locked?: boolean;
  warning?: boolean;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [local, setLocal] = useState(false);
  const [phone, setPhone] = useState(false);
  const sheetRef = useLaunchViewport(true);
  useEffect(() => {
    const media = matchMedia("(width < 640px)");
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const open = controlled ?? local;
  const setOpen = onOpenChange ?? setLocal;
  const focus = useContext(ChipFocus);
  const dismiss = focus?.dismiss;
  useEffect(() => {
    if (!dismiss || !open) return;
    const close = () => setOpen(false);
    dismiss.current = close;
    return () => {
      if (dismiss.current === close) dismiss.current = null;
    };
  }, [dismiss, open, setOpen]);
  function restoreFocus(event: Event) {
    const destination = focus?.restore.current;
    if (destination && focus) {
      focus.restore.current = null;
      event.preventDefault();
      destination.focus();
    }
  }
  const trigger = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(
        "max-w-full rounded-full bg-background font-normal focus-visible:ring-ring pointer-coarse:min-h-11",
        warning && "border-warning",
        className,
      )}
      aria-label={`${label}${warning ? ", needs attention" : ""}${locked ? ", locked by template" : ""}`}
      data-launch-chip={title}
      aria-haspopup="dialog"
      aria-expanded={open}
    >
      {warning && <CircleAlertIcon aria-hidden="true" className="text-warning" />}
      {prefix && (
        <span aria-hidden="true" className="flex shrink-0 items-center gap-0.5">
          {prefix}
        </span>
      )}
      <span className="truncate">{label}</span>
      {locked ? <LockIcon aria-hidden="true" /> : <ChevronDownIcon aria-hidden="true" />}
    </Button>
  );
  if (phone)
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent
          ref={sheetRef}
          side="bottom"
          aria-describedby={undefined}
          className="max-h-[85dvh] overflow-y-auto rounded-t-2xl p-4
              [&_[cmdk-item]]:min-h-11 [&_button]:pointer-coarse:min-h-11
              [&_[data-slot=sheet-close]]:pointer-coarse:grid [&_[data-slot=sheet-close]]:pointer-coarse:size-11 [&_[data-slot=sheet-close]]:pointer-coarse:place-items-center
              [&_a]:pointer-coarse:inline-flex [&_a]:pointer-coarse:min-h-11 [&_a]:pointer-coarse:items-center [&_input:not([type=radio])]:pointer-coarse:min-h-11
              [&_button]:focus-visible:ring-ring"
          onCloseAutoFocus={restoreFocus}
        >
          <SheetTitle className="pr-14">{title}</SheetTitle>
          {children}
        </SheetContent>
      </Sheet>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        aria-label={title}
        align="start"
        onCloseAutoFocus={restoreFocus}
        className="max-h-[var(--radix-popover-content-available-height)] w-[min(25rem,calc(100vw-2rem))] overflow-y-auto rounded-xl p-2 [&_[cmdk-item]]:pointer-coarse:min-h-11 [&_button]:pointer-coarse:min-h-11 [&_button]:focus-visible:ring-ring"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

type Choice = { value: string; label: string; group?: string | undefined; reason?: string | undefined };

export function ChoiceChip({
  title,
  label,
  value,
  options,
  onChange,
  children,
  open: controlledOpen,
  onOpenChange,
}: {
  title: string;
  label: string;
  value: string;
  options: readonly Choice[];
  onChange: (value: string) => void;
  children?: ReactNode;
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  return (
    <LaunchChip title={title} label={label} open={open} onOpenChange={setOpen}>
      <Command>
        <CommandInput placeholder={`Search ${title.toLowerCase()}`} />
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
                    keywords={[option.label, group, option.reason ?? ""]}
                    disabled={Boolean(option.reason)}
                    className="data-[disabled=true]:opacity-100"
                    onSelect={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                  >
                    <span>
                      {option.label}
                      {option.reason && <span className="block text-xs">{option.reason}</span>}
                    </span>
                    {option.value === value && <CheckIcon aria-label="Selected" className="ml-auto" />}
                  </CommandItem>
                ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
      {children}
    </LaunchChip>
  );
}

export function ComposerLocation({
  name,
  starts,
  selectedStart,
  onStart,
  locked,
  folder,
  repositories,
  project,
  onProject,
}: {
  name: string;
  starts?: readonly LaunchStartTarget[] | undefined;
  selectedStart?: string | undefined;
  onStart?: ((value: string) => void) | undefined;
  locked?: boolean;
  folder: boolean;
  repositories: readonly string[];
  project: string;
  onProject: (value: string) => void;
}) {
  const repo = useContext(LaunchRepositoryContext);
  const selected = starts?.find((start) => start.id === selectedStart);
  const visibleStarts = [...(starts ?? []), ...(repo?.othersOpen ? repo.otherStarts : [])];
  const label = repo?.fromLabel ?? `From · ${selected?.label ?? name}`;
  return (
    <>
      {locked || repo?.building ? (
        <LaunchChip label={label} title="From" locked>
          <p className="p-2 text-sm">{repo?.building ? label : name}</p>
        </LaunchChip>
      ) : (
        <ChoiceChip
          title="From"
          label={label}
          value={selectedStart ?? name}
          open={repo?.fromOpen}
          onOpenChange={repo?.setFromOpen}
          options={
            starts
              ? visibleStarts.map((start) => ({
                  value: start.id,
                  label: start.label,
                  group: repo?.otherStarts.includes(start)
                    ? "Starts without this repository"
                    : start.provider === "docker"
                      ? "Docker hosts"
                      : start.group,
                  reason: start.reason,
                }))
              : [{ value: name, label: name }]
          }
          onChange={(value) => onStart?.(value)}
        >
          {repo && repo.otherStarts.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              aria-expanded={repo.othersOpen}
              onClick={() => repo.setOthersOpen(!repo.othersOpen)}
            >
              Other starting points ({repo.otherStarts.length})
            </Button>
          )}
          <div className="flex flex-wrap gap-3 border-t p-2 text-sm underline">
            <Link href="/snapshots">Open Snapshots</Link>
            <Link href="/hosts">Open Docker hosts</Link>
          </div>
        </ChoiceChip>
      )}
      {folder && !repo?.repository && (
        <ChoiceChip
          title="Folder"
          label={`Folder · ${project || "default"}`}
          value={project}
          options={[{ value: "", label: "default" }, ...repositories.map((value) => ({ value, label: value }))]}
          onChange={onProject}
        />
      )}
    </>
  );
}

export function ComposerStop({
  provider,
  idleDelaySeconds,
}: {
  provider: SandboxPlacementProviderId;
  idleDelaySeconds?: number | undefined;
}) {
  const [ttl, setTtl] = useState("");
  return (
    <>
      <input type="hidden" name="ttl" value={ttl} />
      <ChoiceChip
        title="Stops after"
        label={launchStopLabel(provider, ttl)}
        value={ttl}
        options={ttlOptions(provider)}
        onChange={setTtl}
      >
        <p className="border-t p-2 text-sm text-muted-foreground">
          {idleDelaySeconds === undefined
            ? "The machine pauses without activity"
            : `The machine pauses after ${Math.ceil(idleDelaySeconds / 60)} minutes without activity`}{" "}
          and wakes on your next message, until the time is up.
        </p>
      </ChoiceChip>
    </>
  );
}

const ComposerTask = memo(function ComposerTask({
  id,
  value,
  onChange,
  template,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  template?: string | undefined;
}) {
  return (
    <>
      <Label className="sr-only" htmlFor={`${id}-prompt`}>
        Task
      </Label>
      <Textarea
        id={`${id}-prompt`}
        name="prompt"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={`${id}-hint`}
        placeholder={template ? `Add details for ${template} (optional)` : "Describe the task"}
        rows={5}
        className="min-h-32 resize-y border-0 bg-transparent px-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
    </>
  );
});

export function LaunchComposer({
  id,
  headline,
  subline,
  loadingError,
  template,
  templatePill,
  docker,
  dockerHost,
  task,
  onTask,
  tools,
  skills,
  agent,
  alerts,
  holds,
  location,
  options,
  chooser,
}: {
  id: string;
  headline: string;
  subline?: ReactNode;
  loadingError?: string | undefined;
  template?: string;
  templatePill?: ReactNode;
  docker: boolean;
  dockerHost?: boolean;
  task: string;
  onTask: (task: string) => void;
  tools: ReactNode;
  skills: ReactNode;
  agent: ReactNode;
  alerts?: ReactNode;
  holds: readonly string[];
  location: ReactNode;
  options: ReactNode;
  chooser?: ReactNode;
}) {
  const { pending } = useFormStatus();
  const repository = useContext(LaunchRepositoryContext);
  const repoHoldId = `${id}-repository-hold`;
  const allHolds = prioritizeRepositoryHold(repository?.hold ? repoHoldId : undefined, holds);
  const dismiss = useRef<(() => void) | null>(null);
  const restore = useRef<HTMLElement | null>(null);
  const label = launchSendLabel(task, docker, Boolean(template));
  return (
    <ChipFocus.Provider value={{ dismiss, restore }}>
      <div
        data-launch-fields
        className="space-y-4 px-5 py-7 sm:px-8 sm:py-8 [&_button]:pointer-coarse:min-h-11 [&_a]:pointer-coarse:min-h-11"
      >
        <div className="space-y-1 pr-9">
          <DialogTitle className="text-balance text-2xl font-semibold tracking-tight sm:text-[28px]">
            {repository?.headline ?? headline}
          </DialogTitle>
          <DialogDescription className="sr-only">Compose a sandbox launch.</DialogDescription>
          {repository?.withoutRepository}
          {subline && <p className="text-sm text-muted-foreground">{subline}</p>}
        </div>
        {loadingError && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-warning p-3 text-sm text-foreground"
          >
            <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
            {loadingError}
          </p>
        )}
        {templatePill}
        <div className="rounded-2xl border bg-background p-2.5 shadow-sm focus-within:ring-2 focus-within:ring-ring">
          <ComposerTask id={id} value={task} onChange={onTask} template={template} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2 max-sm:w-full">
              {tools}
              {skills}
            </div>
            <div className="ml-auto flex min-w-0 max-w-full items-center gap-2 [&>button:first-of-type]:min-w-0 [&>button:first-of-type]:shrink">
              {agent}
              <Button
                data-launch-send
                type="submit"
                size={label === "Launch idle" ? "sm" : "icon"}
                className="shrink-0 rounded-full focus-visible:ring-ring aria-disabled:saturate-50 pointer-coarse:min-w-11"
                aria-label={label}
                aria-keyshortcuts="Meta+Enter Control+Enter"
                aria-disabled={pending || allHolds.length > 0}
                aria-describedby={allHolds.length ? allHolds.join(" ") : undefined}
                onClick={(event) => {
                  if (!pending && allHolds.length === 0) {
                    dismiss.current?.();
                    return;
                  }
                  event.preventDefault();
                  const alert = !pending && allHolds[0] ? document.getElementById(allHolds[0]) : null;
                  if (!alert) return;
                  if (dismiss.current) {
                    restore.current = alert;
                    dismiss.current();
                  } else {
                    alert.focus();
                  }
                }}
              >
                {pending ? (
                  <Loader2Icon className="animate-spin" />
                ) : label === "Launch idle" ? (
                  <>
                    Launch idle <SubmitShortcut />
                  </>
                ) : (
                  <ArrowUpIcon />
                )}
              </Button>
            </div>
          </div>
        </div>
        <p
          id={`${id}-hint`}
          role="status"
          data-docker-launch-progress={dockerHost || undefined}
          className="text-sm text-muted-foreground empty:hidden"
        >
          {pending
            ? dockerHost
              ? "Preparing the official Armada environment on your host and starting the sandbox… The first launch can take a few minutes."
              : "Launching…"
            : docker
              ? "Opens the sandbox page and its conversation."
              : label === "Launch idle"
                ? "Leave it empty to start the sandbox idle."
                : null}
        </p>
        <div className="space-y-2 empty:hidden [&_[role=alert]]:rounded-lg [&_[role=alert]]:border [&_[role=alert]]:p-3 [&_[role=alert]]:text-foreground [&_[role=alert].text-destructive]:border-destructive">
          {repository?.hold && (
            <div id={repoHoldId} role="alert" tabIndex={-1}>
              {repository.hold}
            </div>
          )}
          {alerts}
        </div>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex max-w-full flex-wrap gap-2">{location}</div>
          <div className="ml-auto flex max-w-full flex-wrap justify-end gap-2">{options}</div>
        </div>
        {!task.trim() && !template && chooser}
      </div>
    </ChipFocus.Provider>
  );
}

type DockerLimit = { name: string; reason: string };

export function DockerLimits({
  unavailable,
  details,
}: {
  unavailable?: readonly DockerLimit[] | undefined;
  details?: ReactNode;
}) {
  return (
    <LaunchChip label="Docker limits">
      <div className="space-y-2 p-2 text-sm">
        <p>The first launch on a Docker host downloads Armada’s base image; it can take a few minutes.</p>
        {unavailable ? <DockerLimitList unavailable={unavailable} /> : details}
      </div>
    </LaunchChip>
  );
}

export function DockerLimitList({ unavailable }: { unavailable: readonly DockerLimit[] }) {
  if (unavailable.length === 0) return null;
  return (
    <div data-docker-unavailable>
      <p className="font-medium">Not available on Docker hosts yet</p>
      <ul>
        {unavailable.map((entry) => (
          <li key={entry.name}>
            <span className="font-medium">{entry.name}</span>: {entry.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
