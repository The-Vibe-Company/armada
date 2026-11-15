"use client";

import type { Harness } from "@armada/core";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ModelCatalog } from "@/components/model-fields";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { EFFORT_LABEL, HARNESS_LABELS } from "@/lib/labels";
import { launchPickerGroups } from "@/lib/launch-picker";
import { KIND_INFO, type LaunchAccounts, launchDefault } from "@/lib/model-accounts";

const word =
  "max-w-full [overflow-wrap:anywhere] rounded-sm border-b border-dotted border-muted-foreground px-1 text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
export function LaunchSentence({
  idPrefix,
  onBlocked,
  harness,
  onHarness,
  account,
  onAccount,
  accounts,
  catalog,
  boatOpenCodeDisabled,
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
}) {
  const root = useRef<HTMLElement>(null);
  const [model, setModel] = useState(() =>
    accounts.state === "ready"
      ? (accounts.accounts.find((row) => row.id === account)?.models?.[0]?.model ?? catalog[harness].defaultModel)
      : catalog[harness].defaultModel,
  );
  const [effort, setEffort] = useState(catalog[harness].defaultReasoningEffort);
  const [other, setOther] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
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
    const resolved = accounts.state === "ready" ? launchDefault(rows, next, accounts.now) : null;
    const nextAccount = resolved?.state === "resolved" ? resolved.account : undefined;
    onAccount(nextAccount?.id ?? "");
    setModel(nextAccount?.models?.[0]?.model ?? catalog[next].defaultModel);
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
    () => onBlocked(accounts.state === "ready" && (!chosen || !!selectedProblem)),
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
                      setOpen(phone);
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
                  setOpen(phone);
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
      <div className="text-xl leading-relaxed">
        Launch{" "}
        <select
          aria-label="Agent"
          className={word}
          value={harness}
          onChange={(e) => changeAgent(e.target.value as Harness)}
        >
          {(["claude", "codex", "opencode"] as const).map((agent) => (
            <option key={agent} value={agent} disabled={agent === "opencode" && boatOpenCodeDisabled}>
              {HARNESS_LABELS[agent]}
            </option>
          ))}
        </select>{" "}
        running{" "}
        {phone ? (
          <button type="button" className={word} onClick={() => setOpen(true)}>
            {model}
          </button>
        ) : (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button type="button" className={word}>
                {model}
              </button>
            </PopoverTrigger>
            <PopoverContent
              className="w-[min(540px,calc(100vw-2rem))] p-0 duration-150 motion-reduce:animate-none data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100"
              align="start"
            >
              {picker}
            </PopoverContent>
          </Popover>
        )}{" "}
        on{" "}
        <button type="button" className={word} onClick={() => setOpen(true)}>
          {chosen?.name ?? "choose an account"}
        </button>
        , reasoning effort{" "}
        <select
          aria-label="Reasoning effort"
          name="reasoning_effort"
          className={word}
          value={efforts.includes(effort) ? effort : entry.defaultReasoningEffort}
          onChange={(e) => setEffort(e.target.value)}
        >
          {efforts.map((level) => (
            <option key={level} value={level}>
              {EFFORT_LABEL[level] ?? level}
            </option>
          ))}
        </select>
        .
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
      {accounts.state === "unavailable" && (
        <p id={`${idPrefix}-account-unavailable`} role="alert" className="text-sm text-destructive">
          {accounts.reason}
        </p>
      )}
      {!chosen && accounts.state === "ready" && (
        <p className="text-sm text-muted-foreground">
          {HARNESS_LABELS[harness]} has no account selected.{" "}
          <Link href="/harness" className="underline">
            Add account
          </Link>
        </p>
      )}
      {selectedProblem && (
        <p role="alert" className="text-sm text-destructive">
          {selectedProblem}
        </p>
      )}
      <Sheet open={open && phone} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] overflow-y-auto data-[state=open]:duration-150 data-[state=closed]:duration-150 motion-reduce:animate-none"
        >
          <SheetTitle>Choose model and account</SheetTitle>
          {picker}
          <p className="text-sm">
            {HARNESS_LABELS[harness]} running {model} on {chosen?.name ?? "no account"}.
          </p>
          <label htmlFor="launch-sheet-effort" className="text-sm">
            Reasoning effort
            <NativeSelect
              id="launch-sheet-effort"
              aria-label="Sheet reasoning effort"
              value={efforts.includes(effort) ? effort : entry.defaultReasoningEffort}
              onChange={(e) => setEffort(e.target.value)}
            >
              {efforts.map((level) => (
                <option key={level} value={level}>
                  {EFFORT_LABEL[level] ?? level}
                </option>
              ))}
            </NativeSelect>
          </label>
          <button
            type="button"
            className="sticky bottom-0 rounded-md bg-primary p-3 text-primary-foreground"
            onClick={() => {
              setOpen(false);
              root.current?.closest("form")?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
            }}
          >
            Launch
          </button>
        </SheetContent>
      </Sheet>
    </section>
  );
}
