"use client";

import type { Harness } from "@armada/core";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CopyIcon,
  EllipsisIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  StarIcon,
  Trash2Icon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useActionState, useCallback, useEffect, useId, useRef, useState } from "react";
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
import { Empty } from "@/components/page-header";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action";
import {
  type AccountKind,
  type AccountUsage,
  type AuthCapabilities,
  accountProblem,
  accountState,
  addChoices,
  creditText,
  formatDuration,
  formatMoney,
  KIND_INFO,
  kindNote,
  type LaunchDefault,
  MAX_ACCOUNT_NAME,
  type ModelAccount,
  otherBilling,
  relativeTime,
  terminalLogin,
  type UsageView,
  usageView,
} from "@/lib/model-accounts";
import { cn } from "@/lib/utils";

type Action = (previous: ActionResult | null, data: FormData) => Promise<ActionResult>;

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
      No subscription yet. Add one to launch {harnessLabel}.
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

type RowDialog = "rename" | "replace" | "remove" | null;

const STATE_ICON = { ok: CircleCheckIcon, warn: CircleHelpIcon, error: CircleAlertIcon } as const;

/**
 * One account as a dense row (#805, ready for the Build skeleton of #808): name with a one-line meta and its scope
 * as a tag, its state in plain words, and the one expected action on the row: Reconnect when it cannot run, Make
 * default when it could be the default. Rename, replace and remove are rarer and sit in the row's menu.
 */
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
  const [dialog, setDialog] = useState<RowDialog>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const info = KIND_INFO[account.kind];
  const state = accountState(account, now);
  const StateIcon = STATE_ICON[state.tone];
  const headingId = `account-${account.id}`;
  const expiry = account.expiresAt
    ? Date.parse(account.expiresAt) <= now
      ? `Expired ${day(account.expiresAt)}`
      : `Expires ${day(account.expiresAt)}`
    : null;
  const secretWord = info.billing === "api" ? "key" : "token";
  // Stable, so a dialog's success effect runs once per result rather than on every render of the row.
  const closeDialog = useCallback((next: boolean) => {
    if (!next) setDialog(null);
  }, []);
  const restoreFocus = useCallback((event: Event) => {
    event.preventDefault();
    menuTrigger.current?.focus();
  }, []);

  return (
    <li className="px-4 py-3" data-account={account.name} aria-labelledby={headingId}>
      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-[minmax(0,1fr)_8rem_auto] sm:items-center">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={headingId} className="font-medium break-all">
              {account.name}
            </h3>
            <Badge variant="secondary" className="gap-1" data-account-scope={account.scope}>
              {account.scope === "user" ? <UserIcon /> : <UsersIcon />}
              {account.scope === "user" ? "Personal" : orgName}
            </Badge>
            {account.isDefault && (
              <Badge variant="outline" className="gap-1" data-default>
                <StarIcon className="fill-current" /> Default
              </Badge>
            )}
          </div>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>{kindNote(account) ?? info.label}</span>
            {expiry && <span className={cn(expiry.startsWith("Expired") && "text-destructive")}>{expiry}</span>}
            <span>
              Updated <time dateTime={account.updatedAt}>{relativeTime(account.updatedAt, now)}</time>
            </span>
          </p>
        </div>

        <p
          className={cn("flex items-center gap-1.5 text-sm", STATE_TONE[state.tone])}
          data-account-status={account.status}
          data-account-state={state.label.toLowerCase()}
        >
          <StateIcon className="size-4 shrink-0" aria-hidden />
          {state.label}
        </p>

        {canManage ? (
          <div className="flex items-center gap-1 sm:justify-end">
            {/* A default that cannot run would refuse launches that name no account: Reconnect leads instead. */}
            {state.needsAction ? (
              <Button size="sm" onClick={() => setDialog("replace")} aria-label={`Reconnect, ${account.name}`}>
                Reconnect
              </Button>
            ) : (
              !account.isDefault && (
                <InlineAction
                  action={makeDefaultAccount}
                  fields={<TargetFields account={account} orgId={orgId} />}
                  onResult={setResult}
                  label={`Make default, ${account.name}`}
                >
                  Make default
                </InlineAction>
              )
            )}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  ref={menuTrigger}
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`More actions for ${account.name}`}
                >
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuItem onSelect={() => setDialog("rename")}>
                  <PencilIcon /> Rename
                </DropdownMenuItem>
                {!state.needsAction && (
                  <DropdownMenuItem onSelect={() => setDialog("replace")}>
                    <KeyRoundIcon /> Replace {secretWord}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setDialog("remove")}>
                  <Trash2Icon /> Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground sm:text-right">Managed by the org&apos;s admins.</p>
        )}
      </div>
      {/* A revoked or removed account has no usage to read: its status already says what to do. */}
      {info.billing === "subscription" && account.status === "active" && (
        <div className="mt-2 max-w-2xl">
          <UsagePanel usage={usage} account={account} now={now} />
        </div>
      )}
      <ResultLine result={result} />

      {canManage && (
        <>
          <RenameDialog
            account={account}
            orgId={orgId}
            onResult={setResult}
            open={dialog === "rename"}
            onOpenChange={closeDialog}
            onCloseAutoFocus={restoreFocus}
          />
          <ReplaceDialog
            account={account}
            orgId={orgId}
            reconnect={state.needsAction}
            onResult={setResult}
            open={dialog === "replace"}
            onOpenChange={closeDialog}
            onCloseAutoFocus={restoreFocus}
          />
          <RemoveDialog
            account={account}
            orgId={orgId}
            open={dialog === "remove"}
            onOpenChange={closeDialog}
            onCloseAutoFocus={restoreFocus}
          />
        </>
      )}
    </li>
  );
}

const STATE_TONE = { ok: "text-success", warn: "text-warning", error: "text-destructive" } as const;

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

function ignoreResult() {}

/** The row owns which dialog is open; the menu and the row's action open them, and closing gives focus back. */
type Controlled = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
};

/** A dialog whose form closes it on success and keeps a refusal inside it, next to the fields. */
function useDialogAction(
  action: Action,
  onResult: (result: ActionResult) => void,
  onOpenChange: (open: boolean) => void,
) {
  const [generation, setGeneration] = useState(0);
  const [state, formAction] = useActionState(action, null);
  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      onResult(state);
      onOpenChange(false);
      setGeneration((value) => value + 1);
    }
  }, [state, onResult, onOpenChange]);
  return { state, formAction, generation };
}

function RenameDialog({
  account,
  orgId,
  onResult,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  account: ModelAccount;
  orgId: string;
  onResult: (result: ActionResult) => void;
} & Controlled) {
  const { state, formAction, generation } = useDialogAction(renameAccount, onResult, onOpenChange);
  const id = useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
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
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  account: ModelAccount;
  orgId: string;
  /** The account cannot run now (expired, say): replacing its token is how it reconnects. */
  reconnect: boolean;
  onResult: (result: ActionResult) => void;
} & Controlled) {
  const { state, formAction, generation } = useDialogAction(replaceAccountSecret, onResult, onOpenChange);
  const info = KIND_INFO[account.kind];
  const id = useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>
            {reconnect ? "Reconnect" : "Replace the"}{" "}
            {reconnect ? account.name : `${info.valueLabel} of ${account.name}`}
          </DialogTitle>
          {/* Both sentences describe the dialog, so screen readers announce the effect along with the hint. */}
          <DialogDescription asChild>
            <div className="space-y-2">
              <p>{info.hint}</p>
              <p data-replace-effect>
                Saving a new {info.valueLabel} creates a new version of {account.name}. Sandboxes launched with the
                current version keep their files and conversations, but new messages to them are refused. Launch a new
                sandbox to use the new version.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
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

/** A successful removal takes the account's row, and its result line, off the page: a toast names what went. */
function RemoveDialog({
  account,
  orgId,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: { account: ModelAccount; orgId: string } & Controlled) {
  const toast = useToast();
  const remove = useCallback(
    async (previous: ActionResult | null, data: FormData) => {
      const result = await removeAccount(previous, data);
      if (result.ok) toast({ tone: "success", title: `Removed ${account.name}.` });
      return result;
    },
    [toast, account.name],
  );
  const { state, formAction } = useDialogAction(remove, ignoreResult, onOpenChange);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
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

/**
 * Adds a subscription (#805): the dialog leads with the subscription sign-in of each harness, and an API key is the
 * secondary way in ("Use an API key instead"), for the same harness. Until the server offers a native sign-in, the
 * account is added from a value the person produces on their own machine and pastes here.
 */
export function AddAccountDialog({
  orgId,
  orgName,
  isAdmin,
  capabilities,
  initialKind = "claude_oauth",
  triggerLabel = "Add a subscription",
  triggerVariant = "default",
}: {
  orgId: string;
  orgName: string;
  isAdmin: boolean;
  /** What this deployment offers for connecting accounts; null offers paste only. */
  capabilities: AuthCapabilities | null;
  initialKind?: AccountKind;
  /** The trigger's words, when it opens on one harness's kind (an empty harness's "Add a Codex subscription"). */
  triggerLabel?: string;
  triggerVariant?: "default" | "outline";
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
  const subscription = info.billing === "subscription";
  // Only a personal account signs in from the terminal; an org account is pasted by its admin.
  const terminal = scope === "user" ? terminalLogin(capabilities, kind, name) : null;
  const defaultBox = (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name="default" className="size-4 accent-primary" />
      Make it the default for {info.harnessLabel}
    </label>
  );

  // Each opening leads with the subscription sign-in again (#805): an API key chosen last time is not kept.
  useEffect(() => {
    if (state?.ok) {
      setName("");
      setKind(initialKind);
      setScope("user");
      setOpen(false);
      setGeneration((value) => value + 1);
    }
  }, [state, initialKind]);

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
          if (next) return;
          setKind(initialKind);
          setScope("user");
          setGeneration((value) => value + 1);
        }}
      >
        <DialogTrigger asChild>
          <Button size="sm" variant={triggerVariant}>
            <PlusIcon /> {triggerLabel}
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{subscription ? "Add a subscription" : "Add an API key"}</DialogTitle>
            <DialogDescription>
              {subscription
                ? "Sign in with the plan you already pay for. Add as many as you have; each launch names the one it bills."
                : "Billed per token by the provider. Add as many as you have; each launch names the one it bills."}
            </DialogDescription>
          </DialogHeader>
          <form key={generation} action={formAction} className="min-w-0 space-y-5">
            <input type="hidden" name="org" value={orgId} />
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="scope" value={scope} />
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{subscription ? "Subscription" : "API key"}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {addChoices(info.billing).map((value) => (
                  <ChoiceCard
                    key={value}
                    name={`${id}-kind`}
                    checked={kind === value}
                    onChange={() => setKind(value)}
                    icon={subscription ? <StarIcon /> : <KeyRoundIcon />}
                    title={KIND_INFO[value].label}
                    hint={`${KIND_INFO[value].harnessLabel}${subscription ? "" : ", billed per token"}`}
                  />
                ))}
              </div>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto px-0 text-muted-foreground"
                data-billing-switch
                onClick={() => setKind(otherBilling(kind))}
              >
                {subscription ? "Use an API key instead" : "Use a subscription instead"}
              </Button>
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
                placeholder={subscription ? "Work, Personal…" : "Team key"}
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
                    <SubmitButton>{subscription ? "Add subscription" : "Add API key"}</SubmitButton>
                  </div>
                </Disclosure>
              </>
            ) : (
              <>
                <div className="space-y-3 rounded-md border p-3">
                  <p className="text-sm">
                    <span className="font-medium">{subscription ? "Sign in on your machine" : "Paste the key"}.</span>{" "}
                    <span className="text-muted-foreground">{info.hint}</span>
                  </p>
                  <SecretField idPrefix={id} kind={kind} />
                </div>
                {defaultBox}
                {state && !state.ok && <ResultLine result={state} />}
                <SubmitButton>{subscription ? "Add subscription" : "Add API key"}</SubmitButton>
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
  emptyAction,
}: {
  harness: Harness;
  harnessLabel: string;
  /** What fills an agent with no account yet: the add dialog opened on its kind. */
  emptyAction?: ReactNode;
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
        {accounts.length > 0 && <LaunchUses resolved={resolved} harnessLabel={harnessLabel} now={now} />}
      </div>
      {accounts.length === 0 && (
        <div data-launch-uses="none">
          <Empty icon={<KeyRoundIcon />} title={`No ${harnessLabel} subscription yet`} action={emptyAction}>
            Add one to launch {harnessLabel}. An API key works too.
          </Empty>
        </div>
      )}
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
