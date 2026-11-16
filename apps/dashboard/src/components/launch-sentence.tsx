"use client";

import type { Harness } from "@armada/core";
import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CatalogHarnessMark } from "@/components/catalog-harness-mark";
import { LaunchChoice, LaunchSetting } from "@/components/launch-surface";
import type { ModelCatalog } from "@/components/model-fields";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { EFFORT_LABEL, HARNESS_LABELS } from "@/lib/labels";
import { initialLaunchSelection, launchPickerGroups } from "@/lib/launch-picker";
import { accountProblem, KIND_INFO, type LaunchAccounts } from "@/lib/model-accounts";

export function LaunchSentence({
  onBlocked,
  harness,
  onHarness,
  account,
  onAccount,
  accounts,
  catalog,
  boatOpenCodeDisabled,
  allowedHarnesses = ["claude", "codex", "opencode"],
  showHeading = false,
}: {
  idPrefix: string;
  onBlocked: (blocked: boolean) => void;
  harness: Harness;
  onHarness: (value: Harness) => void;
  account: string;
  onAccount: (value: string) => void;
  accounts: LaunchAccounts;
  catalog: ModelCatalog;
  boatOpenCodeDisabled: boolean;
  allowedHarnesses?: readonly Harness[];
  showHeading?: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const [model, setModel] = useState(() => initialLaunchSelection(accounts, catalog, harness).model);
  const [effort, setEffort] = useState(catalog[harness].defaultReasoningEffort);
  const [other, setOther] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [pickerSource, setPickerSource] = useState<"model" | "account">("model");
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const media = matchMedia("(max-width: 639px)");
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const rows = accounts.state === "ready" ? accounts.accounts : [];
  const chosen = rows.find((row) => row.id === account);
  const entry = catalog[harness];
  const efforts = entry.models.find((row) => row.id === model)?.reasoningEfforts ?? entry.reasoningEfforts;
  function changeAgent(next: Harness) {
    onHarness(next);
    const selection = initialLaunchSelection(accounts, catalog, next);
    onAccount(selection.credentialId);
    setModel(selection.model);
    setEffort(catalog[next].defaultReasoningEffort);
    setOther(false);
  }
  const groups = launchPickerGroups(rows, catalog, harness, accounts.state === "ready" ? accounts.now : 0).map(
    (group) => ({
      ...group,
      reason:
        group.reason ??
        (boatOpenCodeDisabled && group.options.every((option) => option.harness === "opencode")
          ? "OpenCode is not available on this snapshot."
          : null),
    }),
  );
  const matches = (group: (typeof groups)[number]) =>
    (group.account.name + " " + group.options.map((row) => row.label + " " + row.id).join(" "))
      .toLowerCase()
      .includes(query.toLowerCase());
  const selectedProblem = groups.find((group) => group.account.id === account)?.reason;
  useEffect(
    () => onBlocked(accounts.state === "unavailable" || (accounts.state === "ready" && (!chosen || !!selectedProblem))),
    [onBlocked, accounts.state, chosen, selectedProblem],
  );
  const picker = (
    <Command
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.stopPropagation();
          root.current?.closest("form")?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
        }
      }}
    >
      <CommandInput placeholder="Search models and accounts" value={query} onValueChange={setQuery} />
      <CommandList>
        {!groups.some((group) => group.reason && matches(group)) && (
          <CommandEmpty>No matching models or accounts.</CommandEmpty>
        )}
        {groups
          .filter(
            (group) =>
              !group.reason ||
              (group.account.name + " " + group.options.map((row) => row.label + " " + row.id).join(" "))
                .toLowerCase()
                .includes(query.toLowerCase()),
          )
          .map((group) => (
            <CommandGroup
              key={group.account.id}
              forceMount={!!group.reason}
              className="[&_[cmdk-group-heading]]:sticky [&_[cmdk-group-heading]]:top-0 [&_[cmdk-group-heading]]:z-10 [&_[cmdk-group-heading]]:bg-popover"
              heading={
                <span>
                  {group.account.name} ·{" "}
                  {KIND_INFO[group.account.kind].billing === "subscription" ? "subscription" : "API key"} ·{" "}
                  {group.account.scope === "user"
                    ? "only you"
                    : accounts.state === "ready"
                      ? accounts.orgName
                      : "organization"}
                  {group.account.runningAgents !== undefined && (
                    <span className="block">{group.account.runningAgents} agents running</span>
                  )}
                </span>
              }
            >
              {group.options.map((option) => {
                const reason =
                  group.reason ??
                  (!allowedHarnesses.includes(option.harness) ? "This agent is not available on this server." : null) ??
                  (option.harness === "opencode" && boatOpenCodeDisabled
                    ? "OpenCode is not available on this snapshot."
                    : null);
                if (reason)
                  return (
                    <div
                      key={option.harness + option.id}
                      role="option"
                      aria-selected={false}
                      aria-disabled="true"
                      tabIndex={0}
                      className="rounded-sm px-2 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span title={option.id} className="[overflow-wrap:anywhere]">
                        {option.label}
                      </span>
                      <span className="block text-xs text-muted-foreground">{reason}</span>
                    </div>
                  );
                return (
                  <CommandItem
                    key={option.harness + option.id}
                    value={group.account.id + option.harness + option.id}
                    keywords={[group.account.name, option.label, option.id, HARNESS_LABELS[option.harness]]}
                    aria-disabled={!!reason}
                    onSelect={() => {
                      if (reason) return;
                      onHarness(option.harness);
                      onAccount(group.account.id);
                      setModel(option.id);
                      setEffort(catalog[option.harness].defaultReasoningEffort);
                      setOther(false);
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0">
                      <span title={option.id}>
                        {option.label.length > 44
                          ? option.label.slice(0, 22) + "…" + option.label.slice(-18)
                          : option.label}
                      </span>
                      {option.isDefault && <span className="ml-2 text-xs text-muted-foreground">default</span>}
                      <span className="block text-xs text-muted-foreground">
                        {reason ??
                          (option.harness !== harness
                            ? `Switches the agent to ${HARNESS_LABELS[option.harness]}.`
                            : "")}
                      </span>
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
        {accounts.state === "legacy" && (
          <CommandGroup heading={HARNESS_LABELS[harness]}>
            {entry.models.map((option) => (
              <CommandItem
                key={option.id}
                onSelect={() => {
                  setModel(option.id);
                  setOther(false);
                  setOpen(false);
                }}
              >
                {option.label}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandItem
          onSelect={() => {
            setOther(true);
            setOpen(false);
          }}
        >
          Other model id…
        </CommandItem>
      </CommandList>
      <p className="border-t p-3 text-xs text-muted-foreground">↑↓ choose · ↵ select · ⌘↵ launch</p>
    </Command>
  );
  return (
    <section ref={root} className="space-y-3">
      <input type="hidden" name="harness" value={harness} />
      <input type="hidden" name="credential" value={account} />
      <input type="hidden" name="model" value={other ? "other" : model} />
      <input
        type="hidden"
        name="reasoning_effort"
        value={efforts.includes(effort) ? effort : entry.defaultReasoningEffort}
      />
      {showHeading && <p className="text-[13px] font-medium">Settings</p>}
      <div className="overflow-hidden rounded-[10px] border [&>button]:border-b [&>span]:border-b [&>span:last-child]:border-b-0">
        <LaunchSetting
          label="Agent"
          value={HARNESS_LABELS[harness]}
          description={`${model} · ${EFFORT_LABEL[efforts.includes(effort) ? effort : entry.defaultReasoningEffort] ?? effort} effort`}
          mark={
            <span className="[&_svg]:size-6">
              <CatalogHarnessMark harness={harness} />
            </span>
          }
        >
          <LaunchChoice
            label="Agent"
            value={harness}
            tone={
              accounts.state === "unavailable" || (accounts.state === "ready" && !chosen) ? "destructive" : undefined
            }
            options={allowedHarnesses.map((value) => ({
              value,
              label: HARNESS_LABELS[value],
              reason:
                value === "opencode" && boatOpenCodeDisabled
                  ? "OpenCode is not available on this snapshot."
                  : undefined,
            }))}
            onChange={(value) => changeAgent(value as Harness)}
          />
          <Popover open={open && !phone && pickerSource === "model"} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`Model: ${entry.models.find((row) => row.id === model)?.label ?? model}`}
                className="grid min-h-[52px] w-full grid-cols-[84px_minmax(0,1fr)_auto] items-center gap-3 border-b px-3.5 py-2 text-left text-[13px] hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setPickerSource("model");
                  setOpen(true);
                }}
              >
                <span className="text-muted-foreground">Model</span>
                <span className="truncate font-medium">
                  {entry.models.find((row) => row.id === model)?.label ?? <span className="font-mono">{model}</span>}
                </span>
                <span aria-hidden="true" className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span className="max-sm:sr-only">Change</span>
                  <ChevronDownIcon className="size-3.5" />
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-[min(540px,calc(100vw-2rem))] p-0" align="start">
              {picker}
            </PopoverContent>
          </Popover>
          <span className="block">
            <LaunchChoice
              label="Effort"
              value={efforts.includes(effort) ? effort : entry.defaultReasoningEffort}
              options={efforts.map((value) => ({ value, label: EFFORT_LABEL[value] ?? value }))}
              onChange={setEffort}
            />
          </span>
        </LaunchSetting>
        <Popover open={open && !phone && pickerSource === "account"} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Account: ${chosen?.name ?? "Choose an account"}`}
              data-launch-account-picker
              className={`grid min-h-[52px] w-full grid-cols-[84px_minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-2 text-left text-[13px] hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${selectedProblem ? "text-warning" : ""}`}
              onClick={() => {
                setPickerSource("account");
                setOpen(true);
              }}
            >
              <span className="text-muted-foreground">Account</span>
              <span className={`min-w-0 truncate font-medium ${selectedProblem ? "text-warning" : ""}`}>
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="[&_svg]:size-6">
                    <CatalogHarnessMark harness={harness} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate">{chosen?.name ?? "Choose an account"}</span>
                    <span className="block truncate text-xs font-normal text-muted-foreground">
                      {chosen
                        ? `${KIND_INFO[chosen.kind].label} · ${chosen.scope === "org" ? "Organization" : "Only you"}`
                        : "Connect an account to continue"}
                    </span>
                  </span>
                </span>
              </span>
              <span aria-hidden="true" className="flex items-center gap-1 text-xs text-muted-foreground">
                <span className="max-sm:sr-only">Change</span>
                <ChevronDownIcon className="size-3.5" />
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-[min(540px,calc(100vw-2rem))] p-0" align="start">
            {picker}
          </PopoverContent>
        </Popover>
      </div>
      {other && (
        <Input
          name="other_model"
          aria-label="Other model id"
          required
          placeholder="Model id"
          onChange={(e) => setModel(e.target.value)}
        />
      )}
      <Sheet open={open && phone} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] overflow-y-auto data-[state=open]:duration-150 data-[state=closed]:duration-150 motion-reduce:animate-none"
        >
          <SheetTitle>Choose model and account</SheetTitle>
          {picker}
          <button type="button" className="rounded-md border p-3 text-sm" onClick={() => setOpen(false)}>
            Done
          </button>
        </SheetContent>
      </Sheet>
    </section>
  );
}

/** Keep the reason, its repairs and the disabled launch together in the pinned footer. */
export function LaunchAccountNotice({
  idPrefix,
  harness,
  account,
  accounts,
  onPick,
}: {
  idPrefix?: string;
  harness: Harness;
  account: string;
  accounts: LaunchAccounts;
  onPick: () => void;
}) {
  if (accounts.state === "legacy") return null;
  if (accounts.state === "unavailable")
    return (
      <p
        id={idPrefix ? `${idPrefix}-account-unavailable` : undefined}
        role="alert"
        className="mr-auto text-xs text-destructive"
      >
        {accounts.reason}
      </p>
    );
  const chosen = accounts.accounts.find((row) => row.id === account);
  const problem = chosen ? accountProblem(chosen, accounts.now) : null;
  const full = chosen?.maxAgents != null && (chosen.runningAgents ?? 0) >= chosen.maxAgents;
  if (chosen && !problem && !full) return null;
  return (
    <>
      <p
        id={idPrefix ? `${idPrefix}-account-unavailable` : undefined}
        role="alert"
        className="min-w-0 flex-1 text-xs text-warning"
      >
        {!chosen
          ? `${HARNESS_LABELS[harness]} has no account selected.`
          : full
            ? `${chosen.runningAgents ?? 0} of ${chosen.maxAgents} agents are working on ${chosen.name}.`
            : `${chosen.name} is ${problem}.`}
      </p>
      <Button asChild variant="outline" size="sm">
        <Link href="/harness">{!chosen ? "Add an account" : full ? "Change account limit" : "Reconnect account"}</Link>
      </Button>
      {accounts.accounts.length > 0 && (
        <Button type="button" variant="ghost" size="sm" onClick={onPick}>
          Pick another account
        </Button>
      )}
    </>
  );
}
