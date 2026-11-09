"use client";

import type { Harness } from "@armada/core";
import { CopyIcon, KeyRoundIcon, PlusIcon, StarIcon, UserIcon, UsersIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useActionState, useEffect, useId, useState } from "react";
import {
  addAccount,
  makeDefaultAccount,
  removeAccount,
  renameAccount,
  replaceAccountSecret,
} from "@/app/actions/model-accounts";
import { SubmitButton } from "@/components/action-form";
import { ChoiceCard } from "@/components/connections";
import { Disclosure } from "@/components/disclosure";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action";
import {
  type AccountKind,
  type AccountUsage,
  type AuthCapabilities,
  accountProblem,
  creditText,
  formatDuration,
  formatMoney,
  KIND_INFO,
  kindNote,
  type LaunchDefault,
  MAX_ACCOUNT_NAME,
  type ModelAccount,
  relativeTime,
  STATUS_INFO,
  terminalLogin,
  type UsageView,
  usageView,
} from "@/lib/model-accounts";
import { cn } from "@/lib/utils";

type Action = (previous: ActionResult | null, data: FormData) => Promise<ActionResult>;

const TONE: Record<string, string> = {
  ok: "border-success/40 bg-success/10 text-success",
  warn: "border-warning/40 bg-warning/10 text-warning",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
  muted: "text-muted-foreground",
};

function ResultLine({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  return (
    <p role={result.ok ? "status" : "alert"} className={cn("text-sm", result.ok ? "text-success" : "text-destructive")}>
      {result.ok ? result.message : result.error}
    </p>
  );
}

function day(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** Hidden fields naming one account the way every account action addresses it. */
function TargetFields({ account, orgId }: { account: ModelAccount; orgId: string }) {
  return (
    <>
      <input type="hidden" name="scope" value={account.scope} />
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="id" value={account.id} />
      <input type="hidden" name="version" value={account.version} />
    </>
  );
}

/* ---------------------------------------------------------------- which account launches use */

/** The one line that says which account a new launch of this agent bills, before anyone opens the dialog. */
export function LaunchUses({
  resolved,
  harnessLabel,
  now,
}: {
  resolved: LaunchDefault;
  harnessLabel: string;
  now: number;
}) {
  if (resolved.state === "resolved" || resolved.state === "unusable") {
    const why = {
      "personal-default": "your default",
      "personal-only": "your only account",
      "org-default": "the org's default",
      "org-only": "the org's only account",
    }[resolved.why];
    if (resolved.state === "unusable")
      return (
        <p className="text-sm text-warning" data-launch-uses="unusable">
          Launch would preselect {resolved.account.name}, {why}, but it is {accountProblem(resolved.account, now)}.
          Replace its token or make another account the default.
        </p>
      );
    return (
      <p className="text-sm text-muted-foreground" data-launch-uses={resolved.account.id}>
        Launch preselects <span className="font-medium text-foreground">{resolved.account.name}</span>, {why}.
      </p>
    );
  }
  if (resolved.state === "ambiguous")
    return (
      <p className="text-sm text-muted-foreground" data-launch-uses="ambiguous">
        No default: each launch asks which account to use.
      </p>
    );
  return (
    <p className="text-sm text-muted-foreground" data-launch-uses="none">
      No account yet. Add one to launch {harnessLabel}.
    </p>
  );
}

/* ---------------------------------------------------------------- usage */

/**
 * When one part of a report was read, when that differs from the report itself: a sparse update keeps an older
 * window or balance with its own time, and it is never shown as read with the rest.
 */
function ReadAt({ at, report, now, lead }: { at: string | null; report: string; now: number; lead?: boolean }) {
  if (at === null || at === report) return null;
  return (
    <span data-read-at={at}>
      {lead ? "Read " : ", read "}
      <time dateTime={at}>{relativeTime(at, now)}</time>
    </span>
  );
}

/**
 * An account's allowance windows. Each window says what share is left, what was used, and when it resets. A
 * stale report keeps its numbers but says how old they are; nothing reported is said in words, never as zero.
 */
export function UsagePanel({
  usage,
  account,
  now,
}: {
  usage: AccountUsage | null;
  account: Pick<ModelAccount, "version">;
  now: number;
}) {
  const view: UsageView = usageView(usage, account);
  if ("reason" in view) {
    const label = {
      unknown: "Usage unknown",
      unavailable: "Usage unavailable",
      error: "Usage not read",
      unreadable: "Usage not shown",
    }[view.kind];
    return (
      <p
        className={cn("text-xs", view.kind === "error" ? "text-warning" : "text-muted-foreground")}
        data-usage={view.kind}
      >
        <span className="font-medium text-foreground/80">{label}.</span> {view.reason}
      </p>
    );
  }
  return (
    <div className="space-y-2" data-usage={view.kind}>
      {view.windows.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2">
          {view.windows.map((window) => {
            const left = window.usedPercent === null ? null : Math.round(100 - window.usedPercent);
            return (
              <li key={window.id} className="min-w-0 space-y-1" data-window={window.id}>
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate font-medium" title={window.label}>
                    {window.label}
                    {window.durationMins !== null && (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        · {formatDuration(window.durationMins)}
                      </span>
                    )}
                  </span>
                  <span className={cn("shrink-0 tabular-nums", view.kind === "stale" && "text-muted-foreground")}>
                    {left === null ? "Unavailable" : `${left}% left`}
                  </span>
                </div>
                {/* No track for an unavailable reading: an empty bar would read as 0% used. */}
                {window.usedPercent !== null && (
                  <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        view.kind === "stale"
                          ? "bg-muted-foreground/40"
                          : window.usedPercent >= 90
                            ? "bg-destructive"
                            : window.usedPercent >= 70
                              ? "bg-warning"
                              : "bg-foreground/70",
                      )}
                      style={{ width: `${window.usedPercent}%` }}
                    />
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  {window.usedPercent === null ? "Reading unavailable" : `${Math.round(window.usedPercent)}% used`}
                  {window.resetsAt ? (
                    <>
                      , resets <time dateTime={window.resetsAt}>{relativeTime(window.resetsAt, now)}</time>
                    </>
                  ) : null}
                  <ReadAt at={window.observedAt} report={view.observedAt} now={now} />
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {view.credits.length > 0 && (
        <div className="space-y-1" data-credits>
          <p className="text-xs font-medium">Credits</p>
          <ul className="grid gap-x-3 gap-y-1 sm:grid-cols-2">
            {view.credits.map((meter) => (
              <li key={meter.key} className="min-w-0 text-xs" data-credit-source={meter.sourceId ?? ""}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-muted-foreground" title={meter.label}>
                    {meter.label}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 break-all text-right tabular-nums",
                      view.kind === "stale" && "text-muted-foreground",
                    )}
                  >
                    {creditText(meter)}
                  </span>
                </div>
                {meter.observedAt !== view.observedAt && meter.observedAt !== null && (
                  <p className="text-muted-foreground">
                    <ReadAt at={meter.observedAt} report={view.observedAt} now={now} lead />
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {view.hiddenWindows > 0 && (
        <p className="text-xs text-muted-foreground">
          {view.hiddenWindows === 1 ? "1 window" : `${view.hiddenWindows} windows`} in a form this dashboard cannot read
          yet.
        </p>
      )}
      {view.hiddenCredits > 0 && (
        <p className="text-xs text-muted-foreground">
          {view.hiddenCredits === 1 ? "1 credit balance" : `${view.hiddenCredits} credit balances`} in a form this
          dashboard cannot read yet.
        </p>
      )}
      {view.extra && (
        <p className="text-xs text-muted-foreground">
          Extra usage: {formatMoney(view.extra.used, view.extra.currency)}
          {view.extra.limit !== null ? ` of ${formatMoney(view.extra.limit, view.extra.currency)}` : ""}
        </p>
      )}
      <p className={cn("text-xs", view.kind === "stale" ? "text-warning" : "text-muted-foreground")}>
        {view.kind === "stale" ? "Last known, " : "Reported "}
        <time dateTime={view.observedAt}>{relativeTime(view.observedAt, now)}</time>.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- one account */

export function AccountRow({
  account,
  orgId,
  orgName,
  canManage,
  usage,
  now,
}: {
  account: ModelAccount;
  orgId: string;
  orgName: string;
  canManage: boolean;
  /** The account's usage report, or null when this server does not report usage. */
  usage: AccountUsage | null;
  now: number;
}) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const info = KIND_INFO[account.kind];
  const status = STATUS_INFO[account.status];
  const headingId = `account-${account.id}`;
  const problem = accountProblem(account, now);
  const expiry = account.expiresAt
    ? Date.parse(account.expiresAt) <= now
      ? `Expired ${day(account.expiresAt)}`
      : `Expires ${day(account.expiresAt)}`
    : null;

  return (
    <li className="space-y-3 p-4" data-account={account.name} aria-labelledby={headingId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={headingId} className="font-medium break-all">
              {account.name}
            </h3>
            {account.isDefault && (
              <Badge variant="outline" className="gap-1" data-default>
                <StarIcon className="fill-current" /> Default
              </Badge>
            )}
            {account.status !== "active" && (
              <Badge variant="outline" className={TONE[status.tone]} data-account-status={account.status}>
                {status.label}
              </Badge>
            )}
          </div>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {kindNote(account) && <span>{kindNote(account)}</span>}
            <span className="inline-flex items-center gap-1">
              {account.scope === "user" ? <UserIcon className="size-3" /> : <UsersIcon className="size-3" />}
              {account.scope === "user" ? "Yours" : orgName}
            </span>
            {expiry && <span className={cn(expiry.startsWith("Expired") && "text-destructive")}>{expiry}</span>}
            <span>
              Updated <time dateTime={account.updatedAt}>{relativeTime(account.updatedAt, now)}</time>
            </span>
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-1">
            {!account.isDefault && (
              <InlineAction
                action={makeDefaultAccount}
                fields={<TargetFields account={account} orgId={orgId} />}
                onResult={setResult}
                label={`Make default, ${account.name}`}
              >
                Make default
              </InlineAction>
            )}
            <RenameDialog account={account} orgId={orgId} onResult={setResult} />
            <ReplaceDialog account={account} orgId={orgId} reconnect={problem !== null} onResult={setResult} />
            <RemoveDialog account={account} orgId={orgId} onResult={setResult} />
          </div>
        )}
      </div>
      {/* A revoked or removed account has no usage to read: its status already says what to do. */}
      {info.billing === "subscription" && account.status === "active" && (
        <UsagePanel usage={usage} account={account} now={now} />
      )}
      <ResultLine result={result} />
    </li>
  );
}

function InlineAction({
  action,
  fields,
  onResult,
  label,
  children,
}: {
  action: Action;
  fields: ReactNode;
  onResult: (result: ActionResult) => void;
  label: string;
  children: ReactNode;
}) {
  const [state, formAction] = useActionState(action, null);
  useEffect(() => {
    if (state) onResult(state);
  }, [state, onResult]);
  return (
    <form action={formAction}>
      {fields}
      <SubmitButton variant="outline" size="sm" aria-label={label}>
        {children}
      </SubmitButton>
    </form>
  );
}

/** A dialog whose form closes it on success and keeps a refusal inside it, next to the fields. */
function useDialogAction(action: Action, onResult: (result: ActionResult) => void) {
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [state, formAction] = useActionState(action, null);
  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      onResult(state);
      setOpen(false);
      setGeneration((value) => value + 1);
    }
  }, [state, onResult]);
  return { open, setOpen, state, formAction, generation };
}

function RenameDialog({
  account,
  orgId,
  onResult,
}: {
  account: ModelAccount;
  orgId: string;
  onResult: (result: ActionResult) => void;
}) {
  const { open, setOpen, state, formAction, generation } = useDialogAction(renameAccount, onResult);
  const id = useId();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`Rename ${account.name}`}>
          Rename
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename {account.name}</DialogTitle>
          <DialogDescription>Only the name changes. Its token and running sandboxes are untouched.</DialogDescription>
        </DialogHeader>
        <form key={generation} action={formAction} className="space-y-4">
          <TargetFields account={account} orgId={orgId} />
          <div className="space-y-2">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input
              id={`${id}-name`}
              name="name"
              defaultValue={account.name}
              required
              maxLength={MAX_ACCOUNT_NAME}
              autoComplete="off"
            />
          </div>
          {state && !state.ok && <ResultLine result={state} />}
          <SubmitButton>Save name</SubmitButton>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A new token for the same account: its id, name and default stay. This explicit replacement increments the account
 * version (#612). Sandboxes pinned to the earlier version keep their files and conversations, but the server refuses
 * new messages to them; a new launch uses the new version. A routine native auth refresh keeps its own revision and
 * does not change the account version.
 */
function ReplaceDialog({
  account,
  orgId,
  reconnect,
  onResult,
}: {
  account: ModelAccount;
  orgId: string;
  /** The account cannot run now (expired, say): replacing its token is the next step, so it leads. */
  reconnect: boolean;
  onResult: (result: ActionResult) => void;
}) {
  const { open, setOpen, state, formAction, generation } = useDialogAction(replaceAccountSecret, onResult);
  const info = KIND_INFO[account.kind];
  const id = useId();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant={reconnect ? "default" : "ghost"}
          size="sm"
          aria-label={`${reconnect ? "Reconnect" : `Replace ${info.billing === "api" ? "key" : "token"}`}, ${account.name}`}
        >
          {reconnect ? "Reconnect" : `Replace ${info.billing === "api" ? "key" : "token"}`}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {reconnect ? "Reconnect" : "Replace the"}{" "}
            {reconnect ? account.name : `${info.valueLabel} of ${account.name}`}
          </DialogTitle>
          <DialogDescription>{info.hint}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground" data-replace-effect>
          Saving a new {info.valueLabel} creates a new version of {account.name}. Sandboxes launched with the current
          version keep their files and conversations, but new messages to them are refused. Launch a new sandbox to use
          the new version.
        </p>
        <form key={generation} action={formAction} className="space-y-4">
          <TargetFields account={account} orgId={orgId} />
          <input type="hidden" name="kind" value={account.kind} />
          <input type="hidden" name="name" value={account.name} />
          <SecretField idPrefix={id} kind={account.kind} />
          {state && !state.ok && <ResultLine result={state} />}
          <SubmitButton>Save {info.valueLabel}</SubmitButton>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveDialog({
  account,
  orgId,
  onResult,
}: {
  account: ModelAccount;
  orgId: string;
  onResult: (result: ActionResult) => void;
}) {
  const { open, setOpen, state, formAction } = useDialogAction(removeAccount, onResult);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          aria-label={`Remove ${account.name}`}
        >
          Remove
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {account.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            New launches can no longer use it. Sandboxes launched with it keep their files and conversations, but new
            messages to them are refused; a new launch needs another usable account.
            {account.isDefault
              ? " It is the default: until you choose another, launches without an explicit account fail rather than bill a different one."
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {state && !state.ok && <ResultLine result={state} />}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <form action={formAction}>
            <TargetFields account={account} orgId={orgId} />
            <SubmitButton variant="destructive">Remove account</SubmitButton>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The pasted value: a password field for a token or key, a text area for a Codex auth.json. Never prefilled. */
function SecretField({ idPrefix, kind }: { idPrefix: string; kind: AccountKind }) {
  const info = KIND_INFO[kind];
  return (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-value`}>{info.valueLabel}</Label>
      {kind === "codex_auth" ? (
        <Textarea
          id={`${idPrefix}-value`}
          name="value"
          rows={4}
          required
          spellCheck={false}
          autoComplete="off"
          className="font-mono text-xs [-webkit-text-security:disc]"
          placeholder='{"tokens": …}'
        />
      ) : (
        <Input
          id={`${idPrefix}-value`}
          name="value"
          type="password"
          required
          spellCheck={false}
          autoComplete="off"
          placeholder="Paste the value"
        />
      )}
      <p className="text-xs text-muted-foreground">Stored encrypted. Never shown again.</p>
    </div>
  );
}

/* ---------------------------------------------------------------- add an account */

const KIND_ORDER: AccountKind[] = ["claude_oauth", "codex_auth", "anthropic", "openai"];

/**
 * Adds a named account. The subscription kinds come first: what a person usually has. Until the server offers a
 * native sign-in, the account is added from a value the person produces on their own machine and pastes here.
 */
export function AddAccountDialog({
  orgId,
  orgName,
  isAdmin,
  capabilities,
  initialKind = "claude_oauth",
}: {
  orgId: string;
  orgName: string;
  isAdmin: boolean;
  /** What this deployment offers for connecting accounts; null offers paste only. */
  capabilities: AuthCapabilities | null;
  initialKind?: AccountKind;
}) {
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [state, formAction] = useActionState(addAccount, null);
  const [kind, setKind] = useState<AccountKind>(initialKind);
  const [scope, setScope] = useState<"user" | "org">("user");
  const [name, setName] = useState("");
  const router = useRouter();
  const id = useId();
  const info = KIND_INFO[kind];
  // Only a personal account signs in from the terminal; an org account is pasted by its admin.
  const terminal = scope === "user" ? terminalLogin(capabilities, kind, name) : null;
  const defaultBox = (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name="default" className="size-4 accent-primary" />
      Make it the default for {info.harnessLabel}
    </label>
  );

  useEffect(() => {
    if (state?.ok) {
      setName("");
      setOpen(false);
      setGeneration((value) => value + 1);
    }
  }, [state]);

  return (
    <>
      {state?.ok && !open && (
        <p role="status" className="text-sm text-success">
          {state.message}
        </p>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setGeneration((value) => value + 1);
        }}
      >
        <DialogTrigger asChild>
          <Button size="sm">
            <PlusIcon /> Add account
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add a model account</DialogTitle>
            <DialogDescription>Add as many as you have. Each one is chosen by name when you launch.</DialogDescription>
          </DialogHeader>
          <form key={generation} action={formAction} className="min-w-0 space-y-5">
            <input type="hidden" name="org" value={orgId} />
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="scope" value={scope} />
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Account</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {KIND_ORDER.map((value) => (
                  <ChoiceCard
                    key={value}
                    name={`${id}-kind`}
                    checked={kind === value}
                    onChange={() => setKind(value)}
                    icon={KIND_INFO[value].billing === "subscription" ? <StarIcon /> : <KeyRoundIcon />}
                    title={KIND_INFO[value].label}
                    hint={`${KIND_INFO[value].harnessLabel}${KIND_INFO[value].billing === "api" ? ", billed per token" : ""}`}
                  />
                ))}
              </div>
            </fieldset>

            {isAdmin && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Who uses it</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <ChoiceCard
                    name={`${id}-scope`}
                    checked={scope === "user"}
                    onChange={() => setScope("user")}
                    icon={<UserIcon />}
                    title="Only you"
                    hint="Your launches."
                  />
                  <ChoiceCard
                    name={`${id}-scope`}
                    checked={scope === "org"}
                    onChange={() => setScope("org")}
                    icon={<UsersIcon />}
                    title={orgName}
                    hint="Every member's launches."
                  />
                </div>
              </fieldset>
            )}

            <div className="space-y-2">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={MAX_ACCOUNT_NAME}
                autoComplete="off"
                placeholder={info.billing === "subscription" ? "Work, Personal…" : "Team key"}
              />
            </div>

            {terminal ? (
              <>
                <TerminalSignIn
                  command={terminal}
                  onDone={() => {
                    setOpen(false);
                    router.refresh();
                  }}
                />
                <Disclosure summary={`Paste ${info.valueLabel} instead`} defaultOpen={false}>
                  <div className="space-y-4">
                    <p className="text-xs text-muted-foreground">{info.hint}</p>
                    <SecretField idPrefix={id} kind={kind} />
                    {defaultBox}
                    {state && !state.ok && <ResultLine result={state} />}
                    <SubmitButton>Add account</SubmitButton>
                  </div>
                </Disclosure>
              </>
            ) : (
              <>
                <div className="space-y-3 rounded-md border p-3">
                  <p className="text-sm">
                    <span className="font-medium">
                      {info.billing === "subscription" ? "Sign in on your machine" : "Paste the key"}.
                    </span>{" "}
                    <span className="text-muted-foreground">{info.hint}</span>
                  </p>
                  <SecretField idPrefix={id} kind={kind} />
                </div>
                {defaultBox}
                {state && !state.ok && <ResultLine result={state} />}
                <SubmitButton>Add account</SubmitButton>
              </>
            )}
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The terminal sign-in: one command, copied rather than run for the person, that opens the service's own login.
 * The account appears on this page when the command finishes; nothing here waits on it.
 */
function TerminalSignIn({ command, onDone }: { command: string; onDone: () => void }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  // A new name is a new command: "Copied." would otherwise describe the previous one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the reset is keyed on the command on purpose.
  useEffect(() => setCopied("idle"), [command]);
  return (
    <div className="min-w-0 space-y-3 rounded-md border p-3" data-terminal-login>
      <p className="text-sm">
        <span className="font-medium">Sign in from your terminal.</span>{" "}
        <span className="text-muted-foreground">It opens the official sign-in, then saves the account here.</span>
      </p>
      {/* The command wraps rather than scrolls: on a phone the quoted --name must stay on screen. */}
      <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2">
        <code className="min-w-0 flex-1 self-center font-mono text-xs break-words whitespace-pre-wrap">{command}</code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            // No clipboard outside a secure context: say so rather than throw.
            if (!navigator.clipboard) return setCopied("failed");
            navigator.clipboard.writeText(command).then(
              () => setCopied("copied"),
              () => setCopied("failed"),
            );
          }}
        >
          <CopyIcon /> Copy
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          I signed in
        </Button>
        <p role="status" className="text-xs text-muted-foreground">
          {copied === "copied" ? "Copied." : copied === "failed" ? "Copy failed: select the command instead." : ""}
        </p>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- the page's groups */

export function HarnessAccounts({
  harness,
  harnessLabel,
  resolved,
  accounts,
  orgId,
  orgName,
  isAdmin,
  usage,
  now,
}: {
  harness: Harness;
  harnessLabel: string;
  resolved: LaunchDefault;
  accounts: ModelAccount[];
  orgId: string;
  orgName: string;
  isAdmin: boolean;
  usage: Record<string, AccountUsage | null>;
  now: number;
}) {
  const headingId = `accounts-${harness}`;
  return (
    <section className="space-y-3" aria-labelledby={headingId} data-harness={harness}>
      <div className="space-y-0.5">
        <h2 id={headingId} className="text-base font-semibold">
          {harnessLabel}
        </h2>
        <LaunchUses resolved={resolved} harnessLabel={harnessLabel} now={now} />
      </div>
      {accounts.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              orgId={orgId}
              orgName={orgName}
              canManage={account.scope === "user" || isAdmin}
              usage={usage[account.id] ?? null}
              now={now}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
