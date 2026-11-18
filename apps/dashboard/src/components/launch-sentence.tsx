"use client";

import type { Harness } from "@armada/core";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { LaunchChip } from "@/components/launch-composer";
import type { ModelCatalog } from "@/components/model-fields";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { EFFORT_LABEL, HARNESS_LABELS } from "@/lib/labels";
import { launchAgentSummary } from "@/lib/launch-composer";
import { initialLaunchSelection, launchPickerGroups } from "@/lib/launch-picker";
import { accountProblem, accountsFor, KIND_INFO, type LaunchAccounts } from "@/lib/model-accounts";

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
  open,
  onOpenChange: setOpen,
}: {
  onBlocked: (blocked: boolean) => void;
  harness: Harness;
  onHarness: (value: Harness) => void;
  account: string;
  onAccount: (value: string) => void;
  accounts: LaunchAccounts;
  catalog: ModelCatalog;
  boatOpenCodeDisabled: boolean;
  allowedHarnesses?: readonly Harness[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const [modelHarness, setModelHarness] = useState(harness);
  const [model, setModel] = useState(() => initialLaunchSelection(accounts, catalog, harness).model);
  const [effort, setEffort] = useState(catalog[harness].defaultReasoningEffort);
  const [other, setOther] = useState(false);
  const [invalidOther, setInvalidOther] = useState(false);
  const otherField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open && other && invalidOther) otherField.current?.focus();
  }, [open, other, invalidOther]);
  const [query, setQuery] = useState("");
  const rows = accounts.state === "ready" ? accounts.accounts : [];
  const chosen = rows.find((row) => row.id === account);
  const entry = catalog[harness];
  const efforts = entry.models.find((row) => row.id === model)?.reasoningEfforts ?? entry.reasoningEfforts;
  const selectedEffort = efforts.includes(effort) ? effort : (efforts[0] ?? entry.defaultReasoningEffort);
  const defaultEffort = (agent: Harness, modelId: string) => {
    const catalogEntry = catalog[agent];
    const allowed =
      catalogEntry.models.find((row) => row.id === modelId)?.reasoningEfforts ?? catalogEntry.reasoningEfforts;
    return allowed.includes(catalogEntry.defaultReasoningEffort)
      ? catalogEntry.defaultReasoningEffort
      : (allowed[0] ?? catalogEntry.defaultReasoningEffort);
  };
  if (modelHarness !== harness) {
    const selection = initialLaunchSelection(accounts, catalog, harness);
    setModelHarness(harness);
    setModel(selection.model);
    setEffort(defaultEffort(harness, selection.model));
    setOther(false);
    setInvalidOther(false);
  }
  function changeAgent(next: Harness) {
    onHarness(next);
    setModelHarness(next);
    const selection = initialLaunchSelection(accounts, catalog, next);
    onAccount(selection.credentialId);
    setModel(selection.model);
    setEffort(defaultEffort(next, selection.model));
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
    <Command>
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
                      setModelHarness(option.harness);
                      onAccount(group.account.id);
                      setModel(option.id);
                      setEffort(defaultEffort(option.harness, option.id));
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
                  setEffort(defaultEffort(harness, option.id));
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
            if (!other) {
              setModel("");
              setInvalidOther(false);
              setEffort(defaultEffort(harness, ""));
            }
            setOther(true);
          }}
        >
          Other model id…
        </CommandItem>
      </CommandList>
    </Command>
  );
  const warning = accounts.state === "unavailable" || (accounts.state === "ready" && (!chosen || !!selectedProblem));
  const accountLabel =
    accountsFor(rows, harness).length > 1 || warning ? (chosen?.name ?? "Choose an account") : undefined;
  const summary = launchAgentSummary(
    HARNESS_LABELS[harness],
    other ? model || "Other model id…" : (entry.models.find((row) => row.id === model)?.label ?? model),
    EFFORT_LABEL[selectedEffort] ?? selectedEffort,
    accountLabel,
  );
  return (
    <>
      <input type="hidden" name="harness" value={harness} />
      <input type="hidden" name="credential" value={account} />
      <input type="hidden" name="model" value={other ? "other" : model} />
      <input type="hidden" name="reasoning_effort" value={selectedEffort} />
      {other && (
        <input
          name="other_model"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          required
          pattern=".*\S.*"
          onInvalid={(event) => {
            event.preventDefault();
            setInvalidOther(true);
            setOpen(true);
            otherField.current?.focus();
          }}
        />
      )}
      <LaunchChip label={summary} title="Agent, model and account" warning={warning} open={open} onOpenChange={setOpen}>
        <fieldset className="flex flex-wrap gap-x-3 border-b p-2 text-sm">
          <legend className="px-2 font-medium">Agent</legend>
          {(["claude", "codex", "opencode"] as const).map((agent) => {
            const reason = !allowedHarnesses.includes(agent)
              ? "This agent is not available on this server."
              : agent === "opencode" && boatOpenCodeDisabled
                ? "OpenCode is not available on this snapshot."
                : null;
            return (
              <label key={agent} className="flex min-h-8 items-center gap-1.5 pointer-coarse:min-h-11">
                <input
                  type="radio"
                  name={`${id}-agent`}
                  checked={agent === harness}
                  disabled={Boolean(reason)}
                  onChange={() => changeAgent(agent)}
                />
                <span>
                  {HARNESS_LABELS[agent]}
                  {reason && <span className="block text-xs text-muted-foreground">{reason}</span>}
                </span>
              </label>
            );
          })}
        </fieldset>
        {picker}
        {other && (
          <div className="space-y-1 p-2">
            <Input
              ref={(input) => {
                otherField.current = input;
                if (input && !model) input.focus();
              }}
              aria-label="Other model id"
              aria-required="true"
              aria-invalid={invalidOther}
              aria-describedby={invalidOther ? `${id}-model-required` : undefined}
              placeholder="Model id"
              value={model}
              onChange={(event) => {
                setInvalidOther(false);
                setModel(event.target.value);
              }}
            />
            {invalidOther && (
              <p id={`${id}-model-required`} role="alert" className="text-sm text-destructive">
                Enter a model id.
              </p>
            )}
          </div>
        )}
        <fieldset className="flex flex-wrap gap-x-3 border-t p-2 text-sm">
          <legend className="px-2 font-medium">Effort</legend>
          {efforts.map((value) => (
            <label key={value} className="flex min-h-8 items-center gap-1.5 pointer-coarse:min-h-11">
              <input
                type="radio"
                name={`${id}-effort`}
                checked={value === selectedEffort}
                onChange={() => {
                  setEffort(value);
                }}
              />
              {EFFORT_LABEL[value] ?? value}
            </label>
          ))}
        </fieldset>
      </LaunchChip>
    </>
  );
}

/** Keep the reason, its repairs and the disabled launch together in the pinned footer. */
export function LaunchAccountNotice({
  idPrefix,
  harness,
  account,
  accounts,
  onPick,
  requireNamedAccount = false,
}: {
  idPrefix?: string;
  harness: Harness;
  account: string;
  accounts: LaunchAccounts;
  onPick: () => void;
  requireNamedAccount?: boolean;
}) {
  if (accounts.state === "legacy" && !requireNamedAccount) return null;
  if (accounts.state === "unavailable")
    return (
      <p
        id={idPrefix ? `${idPrefix}-account-unavailable` : undefined}
        role="alert"
        tabIndex={-1}
        className="mr-auto text-xs text-destructive"
      >
        {accounts.reason}
      </p>
    );
  const entries = accounts.state === "ready" ? accounts.accounts : [];
  const chosen = entries.find((row) => row.id === account);
  const problem = chosen && accounts.state === "ready" ? accountProblem(chosen, accounts.now) : null;
  const full = chosen?.maxAgents != null && (chosen.runningAgents ?? 0) >= chosen.maxAgents;
  if (chosen && !problem && !full) return null;
  return (
    <>
      <p
        id={idPrefix ? `${idPrefix}-account-unavailable` : undefined}
        role="alert"
        tabIndex={-1}
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
      {entries.length > 0 && (
        <Button type="button" variant="ghost" size="sm" onClick={onPick}>
          Pick another account
        </Button>
      )}
    </>
  );
}
