"use client";

import {
  CONNECTION_PRESETS,
  type ConnectionPreset,
  type ConnectionPresetId,
  connectionPreset,
  type Harness,
} from "@armada/core";
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
  testAccountConnection,
} from "@/app/actions/model-accounts";
import { SubmitButton } from "@/components/action-form";
import { PresetConnectionFields } from "@/components/connection-preset-fields";
import { ChoiceCard, ResultLine } from "@/components/connections";
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
import { Checkbox } from "@/components/ui/checkbox";
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
import { NativeSelect } from "@/components/ui/native-select";
import { RadioGroup } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { usePreservedActionForm } from "@/components/use-preserved-action-form";
import type { ActionResult } from "@/lib/action";
import { HARNESS_LABELS } from "@/lib/labels";
import {
  ACCOUNT_KINDS,
  type AccountKind,
  type AccountUsage,
  type AuthCapabilities,
  accountProblem,
  accountState,
  creditText,
  formatDuration,
  formatMoney,
  HARNESS_PATH,
  KIND_INFO,
  kindNote,
  type LaunchDefault,
  MAX_ACCOUNT_NAME,
  type ModelAccount,
  PASTE_SIGN_IN,
  relativeTime,
  terminalLogin,
  type UsageView,
  usageView,
} from "@/lib/model-accounts";
import type { ConnectionTestChoices } from "@/lib/model-connection-check";
import { connectionModelsNote } from "@/lib/model-picker";
import { cn } from "@/lib/utils";

type Action = (previous: ActionResult | null, data: FormData) => Promise<ActionResult>;

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

/** Testing uses only a bound running sandbox; account secrets/endpoint details never enter this form. */
function ConnectionTestDialog({
  account,
  orgId,
  choices,
}: {
  account: ModelAccount;
  orgId: string;
  choices: ConnectionTestChoices;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`Test connection, ${account.name}`}>
          Test connection
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Test {account.name}</DialogTitle>
          <DialogDescription>
            Custom endpoints only. Launch an idle Modal sandbox with this account first. This sends one tiny billable
            request through its runtime, without starting or resuming a machine.
          </DialogDescription>
        </DialogHeader>
        <ConnectionTestForm
          key={`${account.id}:${account.version}:${orgId}`}
          account={account}
          orgId={orgId}
          choices={choices}
        />
      </DialogContent>
    </Dialog>
  );
}
function ConnectionTestForm({
  account,
  orgId,
  choices,
}: {
  account: ModelAccount;
  orgId: string;
  choices: ConnectionTestChoices;
}) {
  const [state, action, pending] = useActionState(testAccountConnection, null);
  const candidates =
    choices.state === "ready"
      ? choices.sandboxes.filter((sandbox) => sandbox.accountId === account.id && sandbox.version === account.version)
      : [];

  const [edited, setEdited] = useState(false);
  const formRef = usePreservedActionForm();
  const id = useId();
  return (
    <form
      ref={formRef}
      action={action}
      onChange={() => setEdited(true)}
      onSubmit={() => setEdited(false)}
      className="space-y-4"
    >
      <TargetFields account={account} orgId={orgId} />
      {candidates.length > 0 ? (
        <div className="space-y-2">
          <Label htmlFor={`${id}-sandbox`}>Running sandbox</Label>
          <NativeSelect id={`${id}-sandbox`} name="sandboxId" required defaultValue={candidates[0]?.id}>
            {candidates.map((sandbox) => (
              <option key={sandbox.id} value={sandbox.id}>
                {HARNESS_LABELS[sandbox.harness]} —{" "}
                {new Date(sandbox.createdAt).toLocaleString("en", {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: "UTC",
                })}{" "}
                UTC
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : (
        <div className="space-y-2 rounded-md border p-3 text-sm" role="status">
          <p>
            {choices.state === "unavailable"
              ? "Available sandboxes could not be loaded. Reload Models to check again."
              : "No matching sandbox is running. Launch a Modal sandbox with this account, then reload Models to test it."}
          </p>
          <Button asChild variant="outline" size="sm">
            {choices.state === "unavailable" ? (
              <a href={HARNESS_PATH}>Reload Models</a>
            ) : (
              <a href="/environments">Choose a snapshot</a>
            )}
          </Button>
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor={`${id}-model`}>Deployment or model name</Label>
        <Input
          id={`${id}-model`}
          name="model"
          required
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          // The connection's declared models are offered; any other deployment can still be typed.
          defaultValue={account.models?.[0]?.model ?? ""}
          list={account.models?.length ? `${id}-models` : undefined}
          placeholder="Your endpoint's deployment/model"
        />
        {account.models?.length ? (
          <datalist id={`${id}-models`}>
            {account.models.map((info) => (
              <option key={info.model} value={info.model} />
            ))}
          </datalist>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Only your recent running Modal sandboxes using this account are listed. No machine is started or resumed. A
        successful check does not prove streaming or tool compatibility.
      </p>
      {pending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Checking the runtime connection…
        </p>
      ) : (
        !edited && <ResultLine result={state} />
      )}
      <SubmitButton {...(candidates.length === 0 ? { disabled: true } : {})}>
        {pending ? "Checking…" : "Send tiny check"}
      </SubmitButton>
    </form>
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
  testChoices,
}: {
  account: ModelAccount;
  orgId: string;
  orgName: string;
  canManage: boolean;
  testChoices: ConnectionTestChoices;
  /** The account's usage report, or null when this server does not report usage. */
  usage: AccountUsage | null;
  now: number;
}) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [dialog, setDialog] = useState<RowDialog>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const rowAction = useRef<HTMLButtonElement>(null);
  /** Which control opened the dialog, so closing it gives focus back there. */
  const opener = useRef<"menu" | "row">("menu");
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
    // A successful reconnect removes the row's button: the menu is then the next control.
    (opener.current === "row" && rowAction.current?.isConnected ? rowAction.current : menuTrigger.current)?.focus();
    opener.current = "menu";
  }, []);

  return (
    <li className="px-4 py-3" data-account={account.name} aria-labelledby={headingId}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 sm:grid-cols-[minmax(0,1fr)_9rem_11rem]">
        <div className="col-span-2 min-w-0 space-y-0.5 sm:col-span-1">
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
          {account.models?.length ? (
            <p data-account-models className="text-xs text-muted-foreground">
              {connectionModelsNote(account.models.map((declared) => declared.model))}
            </p>
          ) : null}
          {/* The check runs Codex and Claude endpoints only; an OpenCode account would always be refused. */}
          {info.billing === "api" && account.kind !== "opencode" && account.status === "active" && (
            <div className="pt-1.5">
              <ConnectionTestDialog account={account} orgId={orgId} choices={testChoices} />
            </div>
          )}
          {/* A revoked or removed account has no usage to read: its state already says what to do. */}
          {info.billing === "subscription" && account.status === "active" && (
            <div className="pt-1.5">
              <UsagePanel usage={usage} account={account} now={now} />
            </div>
          )}
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
          <div className="flex items-center justify-end gap-1">
            {/* A default that cannot run would refuse launches that name no account: Reconnect leads instead. */}
            {state.needsAction ? (
              <Button
                ref={rowAction}
                size="sm"
                onClick={() => {
                  opener.current = "row";
                  setDialog("replace");
                }}
                aria-label={`Reconnect, ${account.name}`}
              >
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
          <p className="text-right text-xs text-muted-foreground">Managed by the org&apos;s admins.</p>
        )}
      </div>
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
  const formRef = usePreservedActionForm();
  const info = KIND_INFO[account.kind];
  const id = useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>
            {reconnect ? "Reconnect" : "Replace the"}{" "}
            {reconnect ? account.name : `${info.valueLabel} of ${account.name}`}
          </DialogTitle>
          {/* Both sentences describe the dialog, so screen readers announce the effect along with the hint. */}
          <DialogDescription asChild>
            <div className="space-y-2">
              <p>{info.hint}</p>
              {account.kind === "openai" && (
                <p>
                  Choose the destination again: existing endpoint details are not returned. To keep a custom endpoint,
                  re-enter its URL and key. Choosing OpenAI default changes routing to OpenAI.
                </p>
              )}
              {account.kind === "opencode" && (
                <p>
                  Choose the destination again: an existing provider address and models are not returned. To keep a
                  DeepSeek, OpenRouter or other connection, choose it and tick its models again.
                </p>
              )}
              {account.kind === "anthropic" && (
                <p>
                  Choose the destination again: existing gateway details are not returned. To keep a custom gateway,
                  re-enter its URL, authentication and key. Choosing Anthropic default changes routing to Anthropic.
                </p>
              )}
              <p data-replace-effect>
                Saving a new {info.valueLabel} creates a new version of {account.name}. Sandboxes launched with the
                current version keep their files and conversations, but new messages to them are refused. Launch a new
                sandbox to use the new version.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <form ref={formRef} key={generation} action={formAction} className="space-y-4">
          <TargetFields account={account} orgId={orgId} />
          <input type="hidden" name="kind" value={account.kind} />
          <input type="hidden" name="name" value={account.name} />
          {account.kind === "openai" ? (
            <CustomEndpointFields idPrefix={id} kind="openai" requireChoice />
          ) : account.kind === "anthropic" ? (
            <ClaudeReplacementFields idPrefix={id} />
          ) : account.kind === "opencode" ? (
            <OpenCodeReplacementFields idPrefix={id} />
          ) : (
            <SecretField idPrefix={id} kind={account.kind} />
          )}
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
          data-secret-value
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

/** Gateway rotation requires a conscious destination; no sealed metadata or key is prefilled. */
function ClaudeReplacementFields({ idPrefix }: { idPrefix: string }) {
  const [mode, setMode] = useState("");
  const [auth, setAuth] = useState("bearer");
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-connection-mode`}>Connection type</Label>
        <NativeSelect
          id={`${idPrefix}-connection-mode`}
          name="connectionMode"
          required
          value={mode}
          onChange={(event) => setMode(event.target.value)}
        >
          <option value="" disabled>
            Choose a destination
          </option>
          <option value="anthropic">Anthropic default endpoint</option>
          <option value="custom">Custom gateway (Modal)</option>
        </NativeSelect>
      </div>
      {mode === "custom" && (
        <fieldset className="min-w-0 space-y-3 rounded-lg border bg-muted/30 p-4">
          <legend className="px-1 text-sm font-medium">Claude gateway</legend>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-gateway-url`}>Base URL</Label>
            <Input
              id={`${idPrefix}-gateway-url`}
              name="baseUrl"
              type="url"
              required
              spellCheck={false}
              autoComplete="off"
              aria-describedby={`${idPrefix}-gateway-hint`}
              placeholder="https://gateway.example.com/anthropic"
            />
          </div>
          <p id={`${idPrefix}-gateway-hint`} className="text-xs text-muted-foreground">
            Modal only. Claude Code supports Claude models only. Use the gateway base URL, not /v1/messages; it must
            support Anthropic Messages, streaming and tool use.
          </p>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-gateway-auth`}>Gateway authentication</Label>
            <NativeSelect
              id={`${idPrefix}-gateway-auth`}
              name="endpointAuth"
              value={auth}
              onChange={(event) => setAuth(event.target.value)}
            >
              <option value="bearer">Bearer token (Authorization)</option>
              <option value="api-key">API key (x-api-key)</option>
            </NativeSelect>
          </div>
          <ModelPriceFields idPrefix={idPrefix} />
        </fieldset>
      )}
      {mode && <SecretField key={`${mode}:${auth}`} idPrefix={idPrefix} kind="anthropic" />}
    </div>
  );
}

/** Optional prices are non-secret; saved only as part of the server-composed connection. */
function ModelPriceFields({ idPrefix }: { idPrefix: string }) {
  const [enabled, setEnabled] = useState(false);
  return (
    <div className="space-y-3">
      <Label htmlFor={`${idPrefix}-prices`} className="flex items-center gap-2 text-sm font-normal">
        <Checkbox id={`${idPrefix}-prices`} checked={enabled} onCheckedChange={(value) => setEnabled(value === true)} />
        Set model prices (optional)
      </Label>
      {enabled && (
        <fieldset className="space-y-3" aria-describedby={`${idPrefix}-prices-hint`}>
          <legend className="sr-only">Model prices</legend>
          <p id={`${idPrefix}-prices-hint`} className="text-xs text-muted-foreground">
            USD per million tokens for the exact model ID reported by the agent. Missing prices mean unknown, not zero.
            Replacement does not keep old prices: re-enter them to retain them.
          </p>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-price-model`}>Priced model ID</Label>
            <Input
              id={`${idPrefix}-price-model`}
              name="priceModel"
              required
              maxLength={256}
              autoComplete="off"
              spellCheck={false}
              placeholder="Your deployment/model ID"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {(
              [
                ["priceInput", "Input"],
                ["priceCachedInput", "Cached input (optional)"],
                ["priceOutput", "Output"],
              ] as const
            ).map(([name, label]) => (
              <div className="space-y-2" key={name}>
                <Label htmlFor={`${idPrefix}-${name}`}>{label}</Label>
                <Input
                  id={`${idPrefix}-${name}`}
                  name={name}
                  inputMode="decimal"
                  required={name !== "priceCachedInput"}
                  autoComplete="off"
                  placeholder="USD / million"
                />
              </div>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}

/** Non-secret endpoint fields are opt-in; the key remains an uncontrolled password input. */
function CustomEndpointFields({
  idPrefix,
  kind,
  requireChoice = false,
}: {
  idPrefix: string;
  kind: "openai" | "anthropic";
  requireChoice?: boolean;
}) {
  const codex = kind === "openai";
  const [custom, setCustom] = useState(false);
  const [chosen, setChosen] = useState(!requireChoice);
  // Replacement may re-enter a provider-preset connection with its models (#1483).
  const [preset, setPreset] = useState<ConnectionPreset | null>(null);
  return (
    <div className="space-y-4">
      {requireChoice ? (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-mode`}>Connection type</Label>
          <NativeSelect
            id={`${idPrefix}-mode`}
            name="connectionMode"
            required
            value={chosen ? (preset ? preset.id : custom ? "custom" : "openai") : ""}
            onChange={(event) => {
              setChosen(Boolean(event.target.value));
              setCustom(event.target.value === "custom");
              setPreset(replacementPreset(kind, event.target.value));
            }}
          >
            <option value="" disabled>
              Choose a destination
            </option>
            <option value="openai">OpenAI default endpoint</option>
            <option value="custom">Custom endpoint (Modal)</option>
            {replacementPresets(kind).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : (
        <Label htmlFor={`${idPrefix}-custom`} className="flex items-center gap-2 text-sm font-normal">
          <Checkbox
            id={`${idPrefix}-custom`}
            name="customEndpoint"
            value="on"
            checked={custom}
            onCheckedChange={(value) => setCustom(value === true)}
          />
          Use a custom endpoint (Modal)
        </Label>
      )}
      {custom && (
        <fieldset className="min-w-0 space-y-3 rounded-lg border bg-muted/30 p-4">
          <legend className="px-1 text-sm font-medium">{codex ? "Codex connection" : "Claude gateway"}</legend>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-base-url`}>Base URL</Label>
            <Input
              id={`${idPrefix}-base-url`}
              name="baseUrl"
              type="url"
              required
              spellCheck={false}
              autoComplete="off"
              aria-describedby={`${idPrefix}-endpoint-hint`}
              placeholder={
                codex ? "https://resource.services.ai.azure.com/…/openai/v1" : "https://gateway.example.com/anthropic"
              }
            />
          </div>
          <p id={`${idPrefix}-endpoint-hint`} className="text-xs text-muted-foreground">
            {codex
              ? "Azure AI Foundry or a Responses-compatible gateway. A pasted URL ending in /responses is accepted. Modal only. Codex cannot use chat-completions-only endpoints such as DeepSeek."
              : "Modal only. Claude Code supports Claude models only. Use the gateway base URL, not /v1/messages. The gateway must support Anthropic Messages, streaming and tool use."}
          </p>
          {codex ? (
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-api-version`}>API version (optional)</Label>
              <Input
                id={`${idPrefix}-api-version`}
                name="apiVersion"
                autoComplete="off"
                spellCheck={false}
                placeholder="Not needed for Foundry v1"
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-endpoint-auth`}>Gateway authentication</Label>
              <NativeSelect id={`${idPrefix}-endpoint-auth`} name="endpointAuth" defaultValue="bearer">
                <option value="bearer">Bearer token (Authorization)</option>
                <option value="api-key">API key (x-api-key)</option>
              </NativeSelect>
            </div>
          )}
          <ModelPriceFields idPrefix={idPrefix} />
        </fieldset>
      )}
      {preset ? (
        <>
          <input type="hidden" name="preset" value={preset.id} />
          <PresetConnectionFields
            key={preset.id}
            preset={preset}
            secretField={<SecretField idPrefix={idPrefix} kind={kind} />}
          />
        </>
      ) : (
        chosen && <SecretField key={`${kind}:${custom}`} idPrefix={idPrefix} kind={kind} />
      )}
    </div>
  );
}

/** The provider presets that save this kind with chosen models: what a replacement may re-enter. */
function replacementPresets(kind: AccountKind): ConnectionPreset[] {
  return CONNECTION_PRESETS.filter((option) => option.kind === kind && option.models === "choose");
}

function replacementPreset(kind: AccountKind, value: string): ConnectionPreset | null {
  return replacementPresets(kind).find((option) => option.id === value) ?? null;
}

/** OpenCode rotation names its destination: a plan key, or a provider connection re-entered with its models. */
function OpenCodeReplacementFields({ idPrefix }: { idPrefix: string }) {
  const [mode, setMode] = useState("");
  const preset = replacementPreset("opencode", mode);
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-connection-mode`}>Connection type</Label>
        <NativeSelect
          id={`${idPrefix}-connection-mode`}
          name="connectionMode"
          required
          value={mode}
          onChange={(event) => setMode(event.target.value)}
        >
          <option value="" disabled>
            Choose a destination
          </option>
          <option value="opencode">OpenCode plan key</option>
          {replacementPresets("opencode").map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      {preset ? (
        <>
          <input type="hidden" name="preset" value={preset.id} />
          <PresetConnectionFields
            key={preset.id}
            preset={preset}
            secretField={<SecretField idPrefix={idPrefix} kind="opencode" />}
          />
        </>
      ) : (
        mode && <SecretField idPrefix={idPrefix} kind="opencode" />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- add an account */

/** Subscriptions sign in; every other connection starts from a provider preset (#1483). */
const SUBSCRIPTION_KINDS = ACCOUNT_KINDS.filter((value) => KIND_INFO[value].billing === "subscription");
/** A subscription kind, or a provider preset; a plain-key kind's id is also its preset's id. */
type AddChoice = AccountKind | ConnectionPresetId;

/** Adds subscriptions and API keys in one short form, with equal-weight connection choices. */
export function AddAccountDialog({
  orgId,
  orgName,
  isAdmin,
  capabilities,
  initialKind = "claude_oauth",
  triggerLabel = "Add a model account",
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
  const formRef = usePreservedActionForm();
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [state, formAction] = useActionState(addAccount, null);
  const [choice, setChoice] = useState<AddChoice>(initialKind);
  const preset = connectionPreset(choice);
  const kind: AccountKind = preset ? preset.kind : (choice as AccountKind);
  const [scope, setScope] = useState<"user" | "org">("user");
  const [name, setName] = useState("");
  const router = useRouter();
  const id = useId();
  const info = KIND_INFO[kind];
  const subscription = info.billing === "subscription";
  const pasteSignIn = PASTE_SIGN_IN[kind];
  // Only a personal account signs in from the terminal; an org account is pasted by its admin.
  const terminal = scope === "user" ? terminalLogin(capabilities, kind, name) : null;
  const defaultBox = (
    <Label htmlFor={`${id}-default-account`} className="flex items-center gap-2 text-sm font-normal">
      <Checkbox id={`${id}-default-account`} name="default" value="on" />
      Make it the default for {info.harnessLabel}
    </Label>
  );

  // Each opening leads with the subscription sign-in again (#805): an API key chosen last time is not kept.
  useEffect(() => {
    if (state?.ok) {
      setName("");
      setChoice(initialKind);
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
          setChoice(initialKind);
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
            <DialogTitle>Add a model account</DialogTitle>
            <DialogDescription>
              {preset?.models === "choose"
                ? "Paste the key and tick the models you want. Billed per token by the provider."
                : subscription
                  ? "Sign in with the plan you already pay for. Add as many as you have; each launch names the one it bills."
                  : "Billed per token by the provider. Add as many as you have; each launch names the one it bills."}
            </DialogDescription>
          </DialogHeader>
          <form ref={formRef} key={generation} action={formAction} className="min-w-0 space-y-5">
            <input type="hidden" name="org" value={orgId} />
            <input type="hidden" name="kind" value={kind} />
            {preset?.models === "choose" && <input type="hidden" name="preset" value={preset.id} />}
            <input type="hidden" name="scope" value={scope} />
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Connection</legend>
              <RadioGroup
                value={choice}
                onValueChange={(value) => setChoice(value as AddChoice)}
                aria-label="Connection"
                className="sm:grid-cols-2"
              >
                {SUBSCRIPTION_KINDS.map((value) => (
                  <ChoiceCard
                    key={value}
                    value={value}
                    icon={<StarIcon />}
                    title={KIND_INFO[value].label}
                    hint={`For ${KIND_INFO[value].harnessLabel}`}
                  />
                ))}
                {CONNECTION_PRESETS.map((option) => (
                  <ChoiceCard
                    key={option.id}
                    value={option.id}
                    icon={<KeyRoundIcon />}
                    title={option.label}
                    hint={`For ${KIND_INFO[option.kind].harnessLabel} · ${option.hint}`}
                  />
                ))}
              </RadioGroup>
            </fieldset>

            {isAdmin && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Who uses it</legend>
                <RadioGroup
                  value={scope}
                  onValueChange={(value) => setScope(value as "user" | "org")}
                  aria-label="Who uses it"
                  className="sm:grid-cols-2"
                >
                  <ChoiceCard value="user" icon={<UserIcon />} title="Only you" hint="Your launches." />
                  <ChoiceCard value="org" icon={<UsersIcon />} title={orgName} hint="Every member's launches." />
                </RadioGroup>
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
                placeholder="Choose a name"
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
                    {pasteSignIn ? (
                      <PasteSignIn key={kind} command={pasteSignIn.command} paste={pasteSignIn.paste} />
                    ) : (
                      <p className="text-xs text-muted-foreground">{info.hint}</p>
                    )}
                    {kind === "openai" || kind === "anthropic" ? (
                      <CustomEndpointFields key={kind} idPrefix={id} kind={kind} />
                    ) : (
                      <SecretField idPrefix={id} kind={kind} />
                    )}
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
                    <span className="text-muted-foreground">
                      {pasteSignIn
                        ? "The vendor's own CLI signs you in; Armada stores the result encrypted."
                        : preset?.models === "choose" || kind === "opencode"
                          ? (preset?.keyHint ?? info.hint)
                          : kind === "openai"
                            ? "From OpenAI or your gateway. Billed per token."
                            : kind === "anthropic"
                              ? "From Anthropic or your gateway. Billed per token."
                              : info.hint}
                    </span>
                  </p>
                  {pasteSignIn && <PasteSignIn key={kind} command={pasteSignIn.command} paste={pasteSignIn.paste} />}
                  {preset?.models === "choose" ? (
                    <PresetConnectionFields
                      key={preset.id}
                      preset={preset}
                      secretField={<SecretField idPrefix={id} kind={kind} />}
                    />
                  ) : kind === "openai" || kind === "anthropic" ? (
                    <CustomEndpointFields key={kind} idPrefix={id} kind={kind} />
                  ) : (
                    <SecretField idPrefix={id} kind={kind} />
                  )}
                </div>
                {defaultBox}
                {state && !state.ok && <ResultLine result={state} />}
                <SubmitButton>
                  {subscription ? "Add subscription" : preset?.models === "choose" ? "Add connection" : "Add API key"}
                </SubmitButton>
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
      <CommandLine command={command} onCopied={setCopied} />
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

/** One step for a pasted subscription (#1483): the exact command to run locally, then what to paste. */
function PasteSignIn({ command, paste }: { command: string; paste: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="min-w-0 space-y-2" data-paste-sign-in>
      <p className="text-sm text-muted-foreground">Run this on your computer:</p>
      <CommandLine command={command} onCopied={setCopied} />
      <p className="text-xs text-muted-foreground">
        {paste}{" "}
        <span role="status">
          {copied === "copied" ? "Copied." : copied === "failed" ? "Copy failed: select the command instead." : ""}
        </span>
      </p>
    </div>
  );
}

/** A command shown whole, with a Copy button. */
function CommandLine({ command, onCopied }: { command: string; onCopied: (state: "copied" | "failed") => void }) {
  return (
    /* The command wraps rather than scrolls: on a phone the quoted --name must stay on screen. */
    <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2">
      <code className="min-w-0 flex-1 self-center font-mono text-xs break-words whitespace-pre-wrap">{command}</code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          // No clipboard outside a secure context: say so rather than throw.
          if (!navigator.clipboard) return onCopied("failed");
          navigator.clipboard.writeText(command).then(
            () => onCopied("copied"),
            () => onCopied("failed"),
          );
        }}
      >
        <CopyIcon /> Copy
      </Button>
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
  testChoices,
}: {
  testChoices: ConnectionTestChoices;
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
  const subscriptionAvailable = ACCOUNT_KINDS.some(
    (kind) => KIND_INFO[kind].harness === harness && KIND_INFO[kind].billing === "subscription",
  );
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
          <Empty
            icon={<KeyRoundIcon />}
            title={`No ${harnessLabel} ${subscriptionAvailable ? "subscription" : "account"} yet`}
            action={emptyAction}
          >
            {subscriptionAvailable ? (
              <>Add one to launch {harnessLabel}. An API key works too.</>
            ) : (
              <>
                Add an OpenCode plan key, or connect DeepSeek, OpenRouter or another OpenAI-compatible provider. Modal
                only.
              </>
            )}
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
              testChoices={testChoices}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
