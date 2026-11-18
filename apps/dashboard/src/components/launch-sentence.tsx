"use client";

import type { Harness } from "@armada/core";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { LaunchChip } from "@/components/launch-composer";
import type { ModelCatalog } from "@/components/model-fields";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { EFFORT_LABEL, HARNESS_LABELS } from "@/lib/labels";
import { launchAgentSummary } from "@/lib/launch-composer";
import { initialLaunchSelection, launchPickerGroups } from "@/lib/launch-picker";
import { accountProblem, accountsFor, KIND_INFO, type LaunchAccounts } from "@/lib/model-accounts";
import { cn } from "@/lib/utils";

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
  const [editingAccount, setEditingAccount] = useState(false);
  const accountSearch = useRef<HTMLInputElement>(null);
  const accountLine = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open && editingAccount) accountSearch.current?.focus();
  }, [open, editingAccount]);

  const rows = accounts.state === "ready" ? accountsFor(accounts.accounts, harness) : [];
  const chosen = rows.find((row) => row.id === account);
  const entry = catalog[harness];
  const efforts = entry.models.find((row) => row.id === model.trim())?.reasoningEfforts ?? entry.reasoningEfforts;
  const selectedEffort = efforts.includes(effort) ? effort : (efforts[0] ?? entry.defaultReasoningEffort);
  const defaultEffort = (agent: Harness, modelId: string) => {
    const catalogEntry = catalog[agent];
    const allowed =
      catalogEntry.models.find((row) => row.id === modelId)?.reasoningEfforts ?? catalogEntry.reasoningEfforts;
    return allowed.includes(catalogEntry.defaultReasoningEffort)
      ? catalogEntry.defaultReasoningEffort
      : (allowed[0] ?? catalogEntry.defaultReasoningEffort);
  };

  function chooseModel(next: string, agent = harness) {
    setModel(next);
    setEffort(defaultEffort(agent, next));
    setOther(false);
    setInvalidOther(false);
  }

  if (modelHarness !== harness) {
    setModelHarness(harness);
    chooseModel(initialLaunchSelection(accounts, catalog, harness).model);
  }

  function changeAgent(next: Harness) {
    onHarness(next);
    setModelHarness(next);
    const selection = initialLaunchSelection(accounts, catalog, next);
    onAccount(selection.credentialId);
    chooseModel(selection.model, next);
    setEditingAccount(false);
  }

  const groups = launchPickerGroups(rows, catalog, harness, accounts.state === "ready" ? accounts.now : 0);
  const accountGroup = groups.find((group) => group.account.id === account);
  const selectedProblem = accountGroup?.reason;
  const models = accountGroup?.options ?? (accounts.state === "legacy" ? entry.models : []);
  useEffect(
    () => onBlocked(accounts.state === "unavailable" || (accounts.state === "ready" && (!chosen || !!selectedProblem))),
    [onBlocked, accounts.state, chosen, selectedProblem],
  );

  function changeOpen(next: boolean) {
    if (!next) setEditingAccount(false);
    setOpen(next);
  }

  const picker = (
    <Command key={harness} label="Search models">
      <CommandInput placeholder="Search models" />
      <CommandList label="Models">
        <CommandEmpty>No matching models.</CommandEmpty>
        {models.map((option) => (
          <CommandItem
            key={option.id}
            value={option.id}
            keywords={[option.label]}
            onSelect={() => {
              chooseModel(option.id);
              changeOpen(false);
            }}
          >
            <span className="min-w-0 break-all">{option.label}</span>
            {option.id === (chosen?.models?.[0]?.model ?? entry.defaultModel) && (
              <span className="shrink-0 text-xs text-muted-foreground">Default</span>
            )}
            {option.id === model && !other && <CheckIcon aria-label="Selected model" className="ml-auto" />}
          </CommandItem>
        ))}
        <CommandItem
          onSelect={() => {
            if (!other) {
              chooseModel("");
              setOther(true);
            }
          }}
        >
          Other model id…
        </CommandItem>
      </CommandList>
    </Command>
  );
  const warning = accounts.state === "unavailable" || (accounts.state === "ready" && (!chosen || !!selectedProblem));
  const accountLabel = rows.length > 1 || warning ? (chosen?.name ?? "Choose an account") : undefined;
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
      <LaunchChip label={summary} title="Model" warning={warning} open={open} onOpenChange={changeOpen}>
        <fieldset className="flex flex-wrap gap-1 border-b p-2 text-sm">
          <legend className="sr-only">Agent</legend>
          {(["claude", "codex", "opencode"] as const).map((agent) => {
            const reason = !allowedHarnesses.includes(agent)
              ? "This agent is not available on this server."
              : agent === "opencode" && boatOpenCodeDisabled
                ? "OpenCode is not available on this snapshot."
                : null;
            return (
              <label
                key={agent}
                className={cn(
                  "relative flex min-h-9 cursor-pointer items-center rounded-md px-2 font-medium has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring pointer-coarse:min-h-11",
                  harness === agent && "bg-muted",
                  reason && "cursor-default text-muted-foreground",
                )}
              >
                <input
                  type="radio"
                  name={`${id}-agent`}
                  className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-default"
                  aria-label={HARNESS_LABELS[agent]}
                  aria-describedby={reason ? `${id}-agent-${agent}` : undefined}
                  checked={agent === harness}
                  disabled={Boolean(reason)}
                  onChange={() => changeAgent(agent)}
                />
                <span>
                  {HARNESS_LABELS[agent]}
                  {reason && (
                    <span id={`${id}-agent-${agent}`} className="block text-xs font-normal">
                      {reason}
                    </span>
                  )}
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
                setEffort(defaultEffort(harness, event.target.value.trim()));
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

        {accounts.state !== "legacy" && (
          <div className="border-t p-2">
            <Button
              ref={accountLine}
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={editingAccount}
              aria-controls={`${id}-accounts`}
              className="w-full justify-between whitespace-normal text-left"
              onClick={() => setEditingAccount(!editingAccount)}
            >
              <span className="min-w-0 truncate">
                {chosen ? `as ${chosen.name} · ${KIND_INFO[chosen.kind].label}` : "Choose an account"}
              </span>
              <ChevronDownIcon aria-hidden="true" />
            </Button>
            {editingAccount && (
              <Command id={`${id}-accounts`} label="Search accounts">
                <CommandInput ref={accountSearch} placeholder="Search accounts" />
                <CommandList label={`${HARNESS_LABELS[harness]} accounts`}>
                  <CommandEmpty>No matching accounts.</CommandEmpty>
                  {groups.map((group) => (
                    <CommandItem
                      key={group.account.id}
                      value={group.account.id}
                      keywords={[group.account.name, KIND_INFO[group.account.kind].label, group.reason ?? ""]}
                      disabled={!!group.reason}
                      className="data-[disabled=true]:opacity-100"
                      onSelect={() => {
                        onAccount(group.account.id);
                        chooseModel(
                          group.options.find(
                            (option) => option.id === (chosen?.models?.[0]?.model ?? entry.defaultModel),
                          )?.id ??
                            group.options[0]?.id ??
                            entry.defaultModel,
                        );
                        setEditingAccount(false);
                        accountLine.current?.focus();
                      }}
                    >
                      <span className="min-w-0 break-all">
                        <span className="font-medium">{group.account.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {KIND_INFO[group.account.kind].label} ·{" "}
                          {group.account.scope === "user" ? "Only you" : "Organization"}
                          {group.account.runningAgents !== undefined &&
                            ` · ${group.account.runningAgents} agents running`}
                        </span>
                        {group.reason && <span className="block text-xs text-muted-foreground">{group.reason}</span>}
                      </span>
                      {group.account.id === account && <CheckIcon aria-label="Selected account" className="ml-auto" />}
                    </CommandItem>
                  ))}
                </CommandList>
                <Link href="/harness" className="mt-1 px-2 py-1 text-sm underline">
                  Manage accounts
                </Link>
              </Command>
            )}
          </div>
        )}
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
