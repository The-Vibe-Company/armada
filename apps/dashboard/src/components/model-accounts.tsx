"use client";

import {
  type AgentDefault,
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
  pollModelAccounts,
  removeAccount,
  renameAccount,
  replaceAccountSecret,
  setPersonalAgentDefault,
  testAccountConnection,
  updateAccountLimits,
} from "@/app/actions/model-accounts";
import { SubmitButton } from "@/components/action-form";
import { PresetConnectionFields } from "@/components/connection-preset-fields";
import { ResultLine } from "@/components/connections";
import { CreateDialog } from "@/components/create-dialog";
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
  accountsFor,
  creditText,
  formatDuration,
  formatMoney,
  HARNESS_ORDER,
  HARNESS_PATH,
  KIND_INFO,
  kindNote,
  type LaunchDefault,
  MAX_ACCOUNT_NAME,
  type ModelAccount,
  orderAccounts,
  PASTE_SIGN_IN,
  relativeTime,
  shellQuote,
  type UsageView,
  usageView,
} from "@/lib/model-accounts";
import type { ConnectionTestChoices } from "@/lib/model-connection-check";
import { connectionModelsNote } from "@/lib/model-picker";
import { modelsPageDefault, modelsPageModel, modelsPageStatus } from "@/lib/models-page";
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
            Launch an idle Modal sandbox with this API-key account first. This sends one tiny billable request through
            its runtime, without starting or resuming a machine.
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
              <a href="/snapshots">Choose a snapshot</a>
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
      unknown: "Not reported",
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
        <ul className="grid gap-3">
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

type RowDialog = "limits" | "rename" | "replace" | "remove" | null;

const STATE_ICON = { ok: CircleCheckIcon, warn: CircleHelpIcon, error: CircleAlertIcon } as const;

/**
 * One account as a dense row (#805, ready for the Build skeleton of #808): name with a one-line meta and its scope
 * as a tag, its state in plain words, and the one expected action on the row: Reconnect when it cannot run, Make
 * default when it could be the default. Rename, replace and remove are rarer and sit in the row's menu.
 */
export function AccountRow({
  account,
  previousDefault,
  orgId,
  orgName,
  canManage,
  usage,
  now,
  testChoices,
}: {
  account: ModelAccount;
  previousDefault?: ModelAccount | undefined;
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
  const state = modelsPageStatus(account, now);
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
    <tr
      className="block border-b p-4 last:border-0 sm:table-row sm:p-0 [&>td]:py-1.5 sm:[&>td]:py-3 sm:[&>td]:px-3 [&>td]:align-top"
      data-account={account.name}
      aria-labelledby={headingId}
    >
      <td className="block min-w-0 space-y-1 sm:table-cell">
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
              <StarIcon className="fill-current" /> Account-wide default
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
        {/* OpenCode plan keys keep vendor-owned routing; only declared custom connections can be checked. */}
        {info.billing === "api" &&
          (account.kind !== "opencode" || !!account.models?.length) &&
          account.status === "active" && (
            <div className="pt-1.5">
              <ConnectionTestDialog account={account} orgId={orgId} choices={testChoices} />
            </div>
          )}
      </td>

      <td className="block sm:table-cell">
        <p
          className={cn("flex items-center gap-1.5 text-sm", STATE_TONE[state.tone])}
          data-account-status={account.status}
          data-account-state={state.label.toLowerCase()}
        >
          <StateIcon className="size-4 shrink-0" aria-hidden />
          {state.label === "Ready" ? "Connected" : state.label === "Expired" ? "Sign-in expired" : state.label}
        </p>
      </td>
      <td className="block text-sm sm:table-cell">
        <span className="text-muted-foreground sm:hidden">Works with: </span>
        {info.harnessLabel}
      </td>
      <td className="block tabular-nums sm:table-cell sm:text-right">
        <span className="text-muted-foreground sm:hidden">Agents running: </span>
        {account.runningAgents ?? 0}
        {account.maxAgents == null ? (
          <span className="block text-xs text-muted-foreground">no limit</span>
        ) : (
          ` of ${account.maxAgents}`
        )}
        {account.waitingAgents !== undefined && account.waitingAgents > 0 && (
          <span className="block text-xs text-muted-foreground">
            {account.waitingAgents} {account.waitingAgents === 1 ? "message" : "messages"} waiting
          </span>
        )}
      </td>
      <td className="block sm:table-cell">
        {info.billing === "subscription" && account.status === "active" ? (
          <UsagePanel usage={usage} account={account} now={now} />
        ) : (
          <span className="text-xs text-muted-foreground">Not reported</span>
        )}
      </td>
      <td className="block sm:table-cell">
        {canManage ? (
          <div className="flex flex-wrap items-center justify-end gap-1">
            {/* A default that cannot run would refuse launches that name no account: Reconnect leads instead. */}
            {state.needsAction ? (
              <Button
                ref={rowAction}
                size="sm"
                onClick={() => {
                  opener.current = "row";
                  setDialog("replace");
                }}
                aria-label={`${info.billing === "subscription" ? "Reconnect" : "Replace key"}, ${account.name}`}
              >
                {info.billing === "subscription" ? "Reconnect" : "Replace key"}
              </Button>
            ) : (
              <DefaultAccountAction account={account} previous={previousDefault} orgId={orgId} onResult={setResult} />
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
                {!state.needsAction && !account.isDefault && (
                  <DropdownMenuItem
                    onSelect={() =>
                      menuTrigger.current
                        ?.closest("tr")
                        ?.querySelector<HTMLButtonElement>('button[aria-label^="Make default"]')
                        ?.click()
                    }
                  >
                    Set account-wide default for {info.harnessLabel}
                  </DropdownMenuItem>
                )}

                <DropdownMenuItem onSelect={() => setDialog("limits")}>
                  <PencilIcon /> Agent limit
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDialog("rename")}>
                  <PencilIcon /> Rename
                </DropdownMenuItem>
                {!state.needsAction && (
                  <DropdownMenuItem onSelect={() => setDialog("replace")}>
                    <KeyRoundIcon /> {info.billing === "subscription" ? "Reconnect" : `Replace ${secretWord}`}
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
          <p className="text-right text-xs text-muted-foreground">Managed by the organization&apos;s admins.</p>
        )}
        <ResultLine result={result} />

        {canManage && (
          <>
            <LimitsDialog
              account={account}
              orgId={orgId}
              onResult={setResult}
              open={dialog === "limits"}
              onOpenChange={closeDialog}
              onCloseAutoFocus={restoreFocus}
            />
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
      </td>
    </tr>
  );
}

const STATE_TONE = { ok: "text-success", warn: "text-warning", error: "text-destructive" } as const;

function DefaultAccountAction({
  account,
  previous,
  orgId,
  onResult,
}: {
  account: ModelAccount;
  previous?: ModelAccount | undefined;
  orgId: string;
  onResult: (result: ActionResult) => void;
}) {
  const [undo, setUndo] = useState<ModelAccount | null>(null);
  const change = async (_: ActionResult | null, data: FormData) => {
    const result = await makeDefaultAccount(null, data);
    if (result.ok && previous) {
      try {
        const list = await pollModelAccounts(orgId);
        const current = list?.find((item) => item.id === previous.id);
        if (current) setUndo({ ...previous, version: current.version });
      } catch {
        // The default was saved; a failed follow-up read must not turn that success into an action error.
      }
    }
    onResult(result);
    return result;
  };
  return (
    <div className="space-y-1">
      {!account.isDefault && (
        <InlineAction
          action={change}
          fields={<TargetFields account={account} orgId={orgId} />}
          onResult={ignoreResult}
          label={`Make default account-wide, ${account.name}`}
        >
          Make account-wide default
        </InlineAction>
      )}
      {undo && (
        <InlineAction
          action={makeDefaultAccount}
          fields={<TargetFields account={undo} orgId={orgId} />}
          onResult={(result) => {
            onResult(result);
            if (result.ok) setUndo(null);
          }}
          label="Undo default change"
        >
          Undo
        </InlineAction>
      )}
    </div>
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

function LimitsDialog({
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
  const { state, formAction, generation } = useDialogAction(updateAccountLimits, onResult, onOpenChange);
  const id = useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Agent limit for {account.name}</DialogTitle>
          <DialogDescription>New starts are refused at the limit. Existing agents are not stopped.</DialogDescription>
        </DialogHeader>
        <form key={generation} action={formAction} className="space-y-4">
          <TargetFields account={account} orgId={orgId} />
          <AgentLimitField id={id} defaultValue={account.maxAgents ?? ""} />
          {state && !state.ok && <ResultLine result={state} />}
          <SubmitButton>Save limit</SubmitButton>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AgentLimitField({
  id,
  defaultValue,
  value,
  onChange,
}: {
  id: string;
  defaultValue?: number | string;
  value?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={`${id}-max-agents`}>Maximum agents running at the same time</Label>
      <Input
        id={`${id}-max-agents`}
        name="maxAgents"
        type="number"
        min="1"
        step="1"
        defaultValue={defaultValue}
        value={value}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        placeholder="Unlimited"
        aria-describedby={`${id}-max-agents-hint`}
      />
      <p id={`${id}-max-agents-hint`} className="text-xs text-muted-foreground">
        Leave empty for unlimited. Shared across all sandbox providers.
      </p>
    </div>
  );
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
            Available on Modal, Docker hosts and runtime-backed Boat. Claude Code supports Claude models only. Use the
            gateway base URL, not /v1/messages; it must support Anthropic Messages, streaming and tool use.
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
  defaultCustom = false,
}: {
  idPrefix: string;
  kind: "openai" | "anthropic";
  requireChoice?: boolean;
  defaultCustom?: boolean;
}) {
  const codex = kind === "openai";
  const [custom, setCustom] = useState(defaultCustom);
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
      ) : defaultCustom ? (
        <input type="hidden" name="customEndpoint" value="on" />
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
              ? "Azure AI Foundry or a Responses-compatible gateway. A pasted URL ending in /responses is accepted. Custom endpoints use the Armada runtime on Boat. Codex cannot use chat-completions-only endpoints such as DeepSeek."
              : "Available on Modal, Docker hosts and runtime-backed Boat. Claude Code supports Claude models only. Use the gateway base URL, not /v1/messages. The gateway must support Anthropic Messages, streaming and tool use."}
          </p>
          {codex ? (
            <p className="text-xs text-muted-foreground">Sent as Bearer (Authorization). This endpoint serves Codex.</p>
          ) : (
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-endpoint-auth`}>Sent as</Label>
              <NativeSelect id={`${idPrefix}-endpoint-auth`} name="endpointAuth" defaultValue="bearer">
                <option value="bearer">Bearer (Authorization)</option>
                <option value="api-key">x-api-key</option>
              </NativeSelect>
            </div>
          )}
          {codex && (
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-custom-models`}>Models it serves</Label>
              <Textarea
                id={`${idPrefix}-custom-models`}
                name="customModels"
                required
                rows={2}
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-xs"
                placeholder="your-deployment-name, another-model-id"
              />
              <p className="text-xs text-muted-foreground">
                List the exact models this endpoint serves. For Azure, use actual resource deployment names, not
                underlying model names. Official Azure addresses receive a tiny billable test request per deployment
                before saving; nothing is saved if a check fails. Other custom endpoints are not tested on save.
              </p>
            </div>
          )}
          <Disclosure summary="Prices and API version" defaultOpen={false}>
            <div className="space-y-3">
              {codex && (
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
              )}
              <ModelPriceFields idPrefix={idPrefix} />
            </div>
          </Disclosure>
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
type AddChoice = AccountKind | ConnectionPresetId | "your-endpoint" | "your-endpoint-claude";

/** One provider choice leads to the existing sign-in or key form, without a wall of connection cards. */
export function AddAccountDialog({
  orgId,
  orgName,
  isAdmin,
  capabilities: _capabilities,
  initialKind = "claude_oauth",
  triggerLabel = "Add account",
  triggerVariant: _triggerVariant = "default",
}: {
  orgId: string;
  orgName: string;
  isAdmin: boolean;
  capabilities: AuthCapabilities | null;
  initialKind?: AccountKind;
  triggerLabel?: string;
  triggerVariant?: "default" | "outline";
}) {
  const formRef = usePreservedActionForm();
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [state, formAction] = useActionState(addAccount, null);
  const [choice, setChoice] = useState<AddChoice>(initialKind);
  const preset = connectionPreset(choice);
  const kind: AccountKind =
    choice === "your-endpoint-claude"
      ? "anthropic"
      : choice === "your-endpoint"
        ? "openai"
        : preset
          ? preset.kind
          : (choice as AccountKind);
  const [scope, setScope] = useState<"user" | "org">("user");
  const [name, setName] = useState(KIND_INFO[initialKind].label);
  const [maxAgents, setMaxAgents] = useState(initialKind === "morph" ? "2" : "");
  const router = useRouter();
  const id = useId();
  const info = KIND_INFO[kind];
  const subscription = info.billing === "subscription";
  const pasteSignIn = PASTE_SIGN_IN[kind];
  const command = subscription
    ? `${kind === "claude_oauth" ? "claude setup-token && armada creds import claude" : "armada creds login codex"} --name ${shellQuote(name.trim() || info.label)}${scope === "org" ? ` --org ${shellQuote(orgId)}` : ""}${maxAgents ? ` --max-agents ${Number(maxAgents)}` : " --unlimited"}`
    : null;

  useEffect(() => {
    if (!state?.ok) return;
    setOpen(false);
    setGeneration((value) => value + 1);
  }, [state]);

  // Read only safe metadata. Capture a baseline so an existing namesake cannot close the dialog.
  useEffect(() => {
    if (!open || !subscription) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let baseline: Set<string> | null = null;
    const poll = async () => {
      try {
        const accounts = await pollModelAccounts(orgId);
        if (stopped) return;
        if (accounts) {
          if (!baseline) baseline = new Set(accounts.map((account) => `${account.id}:${account.version}`));
          else if (
            accounts.some(
              (account) =>
                account.kind === kind &&
                account.name === (name.trim() || info.label) &&
                account.scope === scope &&
                !baseline?.has(`${account.id}:${account.version}`),
            )
          ) {
            setOpen(false);
            router.refresh();
            return;
          }
        }
      } catch {
        // Keep the paste fallback and manual refresh available when the list cannot be read.
      }
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [open, subscription, orgId, kind, name, scope, info.label, router]);

  const endpoint = choice === "your-endpoint" || choice === "your-endpoint-claude";
  const secretFields = endpoint ? (
    <CustomEndpointFields
      key={choice}
      idPrefix={id}
      kind={kind === "anthropic" ? "anthropic" : "openai"}
      defaultCustom
    />
  ) : preset?.models === "choose" ? (
    <PresetConnectionFields key={preset.id} preset={preset} secretField={<SecretField idPrefix={id} kind={kind} />} />
  ) : kind === "openai" || kind === "anthropic" ? (
    <CustomEndpointFields key={kind} idPrefix={id} kind={kind} />
  ) : (
    <SecretField key={kind} idPrefix={id} kind={kind} />
  );
  const saveFields = (
    <>
      {secretFields}
      <Label htmlFor={`${id}-default-account`} className="flex items-center gap-2 text-sm font-normal">
        <Checkbox id={`${id}-default-account`} name="default" value="on" />
        Make it the default for {info.harnessLabel}
      </Label>
      {state && !state.ok && <ResultLine result={state} />}
      <SubmitButton>{preset?.deploymentNames ? "Test and add account" : "Add account"}</SubmitButton>
    </>
  );
  const choose = (next: AddChoice) => {
    const nextPreset = connectionPreset(next);
    const nextKind =
      next === "your-endpoint-claude"
        ? "anthropic"
        : next === "your-endpoint"
          ? "openai"
          : (nextPreset?.kind ?? (next as AccountKind));
    setChoice(next);
    setName(
      next === "your-endpoint" || next === "your-endpoint-claude"
        ? "Your endpoint"
        : (nextPreset?.label ?? KIND_INFO[nextKind].label),
    );
    setMaxAgents(nextKind === "morph" ? "2" : "");
  };
  return (
    <CreateDialog
      label={triggerLabel}
      title="Add an account"
      description="A subscription, an API key, or your own endpoint. Choose what you have."
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          choose(initialKind);
          setScope("user");
          setGeneration((value) => value + 1);
        }
      }}
    >
      <form ref={formRef} key={generation} action={formAction} className="min-w-0 space-y-4">
        <input type="hidden" name="org" value={orgId} />
        <input type="hidden" name="kind" value={kind} />
        {preset?.models === "choose" && <input type="hidden" name="preset" value={preset.id} />}
        <input type="hidden" name="scope" value={scope} />
        <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Account provider">
          {SUBSCRIPTION_KINDS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={choice === value}
              onClick={() => choose(value)}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none hover:bg-accent",
                choice === value && "border-primary bg-accent",
              )}
            >
              {value === "claude_oauth" ? "Claude" : "ChatGPT"}
              <span className="block text-xs text-muted-foreground">Subscription</span>
            </button>
          ))}
          <button
            type="button"
            aria-pressed={endpoint}
            onClick={() => choose("your-endpoint")}
            className={cn(
              "rounded-md border px-3 py-2 text-left text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none hover:bg-accent",
              endpoint && "border-primary bg-accent",
            )}
          >
            Your endpoint<span className="block text-xs text-muted-foreground">Azure, gateway</span>
          </button>
          {CONNECTION_PRESETS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={choice === option.id}
              onClick={() => choose(option.id)}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none hover:bg-accent",
                choice === option.id && "border-primary bg-accent",
              )}
            >
              {option.label}
              <span className="block text-xs text-muted-foreground">
                {option.models === "choose" ? "Connection" : "API key"}
              </span>
            </button>
          ))}
        </fieldset>
        <div
          key={choice}
          className="space-y-4 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-150"
        >
          {endpoint && (
            <div className="space-y-2">
              <Label htmlFor={`${id}-endpoint-agent`}>Agent</Label>
              <NativeSelect
                id={`${id}-endpoint-agent`}
                value={choice}
                onChange={(event) => choose(event.target.value as AddChoice)}
              >
                <option value="your-endpoint">Codex</option>
                <option value="your-endpoint-claude">Claude Code</option>
              </NativeSelect>
            </div>
          )}
          <p className="text-xs text-muted-foreground" data-connection-availability>
            Works with {info.harnessLabel}.{" "}
            {kind === "morph"
              ? "One Morph key for Claude Code, Codex and OpenCode."
              : "Stored encrypted, never shown again."}
          </p>
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
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {isAdmin && (
              <div className="space-y-2">
                <Label htmlFor={`${id}-scope`}>Who uses it</Label>
                <NativeSelect
                  id={`${id}-scope`}
                  value={scope}
                  onChange={(event) => setScope(event.target.value as "user" | "org")}
                >
                  <option value="user">Only you</option>
                  <option value="org">{orgName}</option>
                </NativeSelect>
              </div>
            )}
            <AgentLimitField id={id} value={maxAgents} onChange={setMaxAgents} />
          </div>
          {command ? (
            <>
              <TerminalSignIn
                command={command}
                onDone={() => {
                  setOpen(false);
                  router.refresh();
                }}
              />
              <Disclosure summary="No terminal here, or on a phone? Paste a sign-in token instead" defaultOpen={false}>
                <div className="space-y-4">
                  {pasteSignIn && <PasteSignIn key={kind} command={pasteSignIn.command} paste={pasteSignIn.paste} />}
                  {saveFields}
                </div>
              </Disclosure>
            </>
          ) : (
            saveFields
          )}
        </div>
      </form>
    </CreateDialog>
  );
}

/** Polling belongs to the dialog; a manual refresh remains available if its list read fails. */
function TerminalSignIn({ command, onDone }: { command: string; onDone: () => void }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing the command invalidates copy feedback.
  useEffect(() => setCopied("idle"), [command]);
  return (
    <div className="min-w-0 space-y-3 rounded-md border p-3" data-terminal-login>
      <p className="text-sm font-medium">Sign in from your terminal</p>
      <CommandLine command={command} onCopied={setCopied} />
      <p className="text-xs text-muted-foreground">
        It opens the official sign-in and saves the account here. This dialog closes when the account arrives.
      </p>
      <p className="text-xs text-muted-foreground">
        Needs the Armada CLI: <code className="break-all">npm i -g @the-vibe-company/armada</code>
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="text-xs text-muted-foreground">
          {copied === "copied"
            ? "Copied. Waiting for the sign-in…"
            : copied === "failed"
              ? "Copy failed: select the command instead."
              : "Waiting for the sign-in…"}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          I signed in
        </Button>
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

/** One account appears once, even when it serves more than one agent. */
export function ModelsOverview({
  accounts,
  orgId,
  orgName,
  isAdmin,
  usage,
  now,
  testChoices,
  emptyAction,
  defaults,
}: {
  defaults?: AgentDefault[] | undefined;
  accounts: ModelAccount[];
  orgId: string;
  orgName: string;
  isAdmin: boolean;
  usage: Record<string, AccountUsage | null>;
  now: number;
  testChoices: ConnectionTestChoices;
  emptyAction: ReactNode;
}) {
  return (
    <div className="space-y-8">
      <section aria-labelledby="launch-defaults" className="rounded-lg border px-5 py-2">
        <h2 id="launch-defaults" className="pt-3 text-sm font-medium text-muted-foreground">
          When you launch
        </h2>
        {HARNESS_ORDER.map((harness) => (
          <PersonalDefaultSentence
            key={harness}
            harness={harness}
            accounts={accounts}
            defaults={defaults}
            now={now}
            orgId={orgId}
            isAdmin={isAdmin}
            emptyAction={emptyAction}
          />
        ))}
      </section>
      <section aria-labelledby="all-accounts" className="space-y-3">
        <h2 id="all-accounts" className="text-base font-semibold">
          Accounts
        </h2>
        {accounts.length ? (
          <div className="rounded-lg border">
            <table className="block w-full table-fixed text-sm sm:table">
              <thead className="hidden border-b text-left text-xs text-muted-foreground sm:table-header-group">
                <tr>
                  {["Account", "Status", "Works with", "Agents running", "Usage", "Actions"].map((label) => (
                    <th key={label} className={cn("px-3 py-3 font-medium", label === "Agents running" && "text-right")}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="block sm:table-row-group">
                {orderAccounts(accounts, now).map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    previousDefault={accounts.find(
                      (other) =>
                        other.id !== account.id &&
                        other.scope === account.scope &&
                        other.isDefault &&
                        accountsFor([other], KIND_INFO[account.kind].harness).length > 0,
                    )}
                    orgId={orgId}
                    orgName={orgName}
                    canManage={account.scope === "user" || isAdmin}
                    usage={usage[account.id] ?? null}
                    now={now}
                    testChoices={testChoices}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="Connect what your agents run on" action={emptyAction}>
            A subscription you already pay for, an API key, or your own endpoint. One is enough to launch.
          </Empty>
        )}
      </section>
    </div>
  );
}

/** These controls store personal per-agent choices, not the account-wide legacy default. */
function PersonalDefaultSentence({
  harness,
  accounts,
  defaults,
  now,
  orgId,
  isAdmin,
  emptyAction,
}: {
  harness: Harness;
  accounts: ModelAccount[];
  defaults: AgentDefault[] | undefined;
  now: number;
  orgId: string;
  isAdmin: boolean;
  emptyAction: ReactNode;
}) {
  const router = useRouter();
  const original = defaults?.find((row) => row.harness === harness) ?? { harness, credentialId: null, model: null };
  const [local, setLocal] = useState<AgentDefault | null>(null);
  const current = local ?? original;
  const [undo, setUndo] = useState<AgentDefault | null>(null);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolved = modelsPageDefault(accounts, harness, now, [current]);
  const account = resolved.state === "resolved" || resolved.state === "unusable" ? resolved.account : null;
  const id = useId();
  const save = async (next: AgentDefault, restoring = false) => {
    setPending(true);
    setError(null);
    const data = new FormData();
    data.set("org", orgId);
    data.set("harness", harness);
    data.set("credentialId", next.credentialId ?? "");
    data.set("model", next.model ?? "");
    try {
      const result = await setPersonalAgentDefault(null, data);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setUndo(restoring ? null : current);
      setLocal(next);
      setOpen(false);
      router.refresh();
    } catch {
      setError("The default could not be confirmed. Reload Models before trying again.");
    } finally {
      setPending(false);
    }
  };
  const word =
    "rounded-sm border-b border-dotted text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b py-4 last:border-0">
      <div className="min-w-0">
        <p className="text-lg">
          {HARNESS_LABELS[harness]}{" "}
          {account ? (
            <>
              runs{" "}
              <button
                type="button"
                className={cn(word, "break-all font-mono text-base")}
                onClick={(event) => {
                  opener.current = event.currentTarget;
                  setOpen(true);
                }}
                aria-label={`Change default model for ${HARNESS_LABELS[harness]}`}
              >
                {current.model ?? modelsPageModel(account, harness)}
              </button>{" "}
              on{" "}
              <button
                type="button"
                className={word}
                onClick={(event) => {
                  opener.current = event.currentTarget;
                  setOpen(true);
                }}
                aria-label={`Change default account for ${HARNESS_LABELS[harness]}`}
              >
                {account.name}
              </button>
            </>
          ) : resolved.state === "missing" ? (
            "has an unavailable default account"
          ) : resolved.state === "ambiguous" ? (
            "needs a default account"
          ) : (
            "has no account yet"
          )}
        </p>
        {account && accountProblem(account, now) && (
          <p className="text-sm text-destructive">
            ● {account.name}: {accountProblem(account, now)}. Repair this account below before launching.
          </p>
        )}
        {resolved.state === "missing" && (
          <p className="text-sm text-destructive">
            ● Choose another account or clear your personal selection before launching.
          </p>
        )}
        {account && modelsPageStatus(account, now).label === "At its limit" && (
          <p className="text-sm text-warning">
            {account.runningAgents} of {account.maxAgents} agents running. New launches are refused until one finishes.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {undo && (
          <Button variant="link" size="sm" disabled={pending} onClick={() => void save(undo, true)}>
            Undo default change
          </Button>
        )}
      </div>
      {account && accountProblem(account, now) && (account.scope === "user" || isAdmin) && (
        <Button
          size="sm"
          onClick={() =>
            document
              .getElementById(`account-${account.id}`)
              ?.closest("tr")
              ?.querySelector<HTMLButtonElement>('button[aria-label^="Reconnect"], button[aria-label^="Replace key"]')
              ?.click()
          }
        >
          {KIND_INFO[account.kind].billing === "subscription" ? "Reconnect" : "Replace key"}
        </Button>
      )}
      {!account &&
        (resolved.state === "missing" || accountsFor(accounts, harness).length ? (
          <Button
            variant="outline"
            size="sm"
            onClick={(event) => {
              opener.current = event.currentTarget;
              setOpen(true);
            }}
          >
            Choose default
          </Button>
        ) : (
          emptyAction
        ))}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="sm:max-w-md"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            opener.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{HARNESS_LABELS[harness]} launch default</DialogTitle>
            <DialogDescription>
              Only your launches change. Other agents and account-wide defaults stay unchanged.
            </DialogDescription>
          </DialogHeader>
          <form
            key={`${open}:${current.credentialId}:${current.model}`}
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void save({
                harness,
                credentialId: String(data.get("credentialId") || "") || null,
                model: String(data.get("model") || "").trim() || null,
              });
            }}
          >
            <div className="space-y-2">
              <Label htmlFor={`${id}-account`}>Account</Label>
              <NativeSelect
                id={`${id}-account`}
                name="credentialId"
                defaultValue={current.credentialId ?? account?.id ?? ""}
              >
                <option value="">Use account-wide defaults</option>
                {accountsFor(accounts, harness).map((choice) => (
                  <option key={choice.id} value={choice.id} disabled={!!accountProblem(choice, now)}>
                    {choice.name}
                    {accountProblem(choice, now) ? ` — ${accountProblem(choice, now)}` : ""}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${id}-model`}>Model ID</Label>
              <Input
                id={`${id}-model`}
                name="model"
                defaultValue={current.model ?? ""}
                placeholder="Use the agent's default model"
                maxLength={256}
              />
              <p className="text-xs text-muted-foreground">
                Use the exact catalog or endpoint model ID. Leave empty to use its default.
              </p>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => void save({ harness, credentialId: null, model: null })}
              >
                Clear selection
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : "Save default"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
