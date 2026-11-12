"use client";

import {
  BracesIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  Loader2Icon,
  LockIcon,
  LockKeyholeIcon,
  PencilIcon,
  Trash2Icon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import { type ReactNode, useActionState, useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import {
  addVaultItem,
  deleteVaultItem,
  readVariableValue,
  replaceSecret,
  revokeVaultItem,
  updateVariable,
} from "@/app/actions/variables";
import { SubmitButton } from "@/components/action-form";
import { ChoiceCard } from "@/components/connections";
import { CopyButton } from "@/components/copy-button";
import { CreateDialog } from "@/components/create-dialog";
import { CreatedAt } from "@/components/created-at";
import { useResourceSelected, visibleResourcePanelTitle } from "@/components/resource-browser";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { usePreservedActionForm } from "@/components/use-preserved-action-form";
import type { ActionResult } from "@/lib/action";
import { cn } from "@/lib/utils";
import {
  audience,
  expiryLabel,
  itemKey,
  MAX_VALUE_BYTES,
  nameProblem,
  type VaultItem,
  type VaultKind,
  type VaultScope,
} from "@/lib/variables";

type Action = (previous: ActionResult | null, data: FormData) => Promise<ActionResult>;

function ResultLine({ result, className }: { result: ActionResult | null; className?: string }) {
  if (!result) return null;
  return (
    <p
      role={result.ok ? "status" : "alert"}
      className={cn("text-sm", result.ok ? "text-success" : "text-destructive", className)}
    >
      {result.ok ? result.message : result.error}
    </p>
  );
}

/** A variable's or a secret's mark on its row: braces for readable configuration, a lock for a write-only value. */
export function VaultMark({ kind }: { kind: VaultKind }) {
  const Icon = kind === "secret" ? LockKeyholeIcon : BracesIcon;
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md border [&_svg]:size-4",
        kind === "secret" ? "border-primary/25 bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
      )}
    >
      <Icon />
    </span>
  );
}

/** A name field that writes environment-style names (APP_REGION) as the person types, and says what is wrong. */
function NameField({
  id,
  kind,
  value,
  onChange,
}: {
  id: string;
  kind: VaultKind;
  value: string;
  onChange: (value: string) => void;
}) {
  const problem = value ? nameProblem(value, kind) : null;
  return (
    <div className="space-y-2">
      <Label htmlFor={`${id}-name`}>Name</Label>
      <Input
        id={`${id}-name`}
        name="name"
        value={value}
        onChange={(event) => onChange(event.target.value.toUpperCase().replace(/[\s-]/g, "_"))}
        required
        maxLength={128}
        autoComplete="off"
        spellCheck={false}
        placeholder={kind === "secret" ? "STRIPE_API_KEY" : "APP_REGION"}
        aria-invalid={problem ? true : undefined}
        aria-describedby={`${id}-name-hint`}
        className="font-mono"
      />
      <p id={`${id}-name-hint`} className={cn("text-xs", problem ? "text-destructive" : "text-muted-foreground")}>
        {problem ?? "The environment variable name agents will see."}
      </p>
    </div>
  );
}

/**
 * The Variables page's create flow (#935), the dashboard's {@link CreateDialog} pattern: one short form for a
 * variable or a secret. Kind and scope are the two choices that cannot be undone, so both are marked. A secret's
 * value is an uncontrolled password field: it is sent once, React empties it after the submission, and the dialog
 * closes on success, so the value is kept nowhere in the page.
 */
export function AddVaultDialog({ orgId, orgName, isAdmin }: { orgId: string; orgName: string; isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const toast = useToast();
  const done = useCallback(
    (message: string) => {
      toast({ tone: "success", title: message });
      setOpen(false);
    },
    [toast],
  );
  return (
    <CreateDialog
      label="Add"
      title="Add a variable or secret"
      description="Values your agents will read from their environment."
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Every opening starts a clean form.
        if (next) setGeneration((value) => value + 1);
      }}
      triggerAttrs={{ "data-add-vault": "" }}
    >
      <AddVaultForm key={generation} orgId={orgId} orgName={orgName} isAdmin={isAdmin} onDone={done} />
    </CreateDialog>
  );
}

function AddVaultForm({
  orgId,
  orgName,
  isAdmin,
  onDone,
}: {
  orgId: string;
  orgName: string;
  isAdmin: boolean;
  onDone: (message: string) => void;
}) {
  const [state, formAction] = useActionState(addVaultItem, null);
  const formRef = usePreservedActionForm();
  const [kind, setKind] = useState<VaultKind>("variable");
  const [scope, setScope] = useState<VaultScope>("personal");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const id = useId();
  useEffect(() => {
    if (state?.ok) onDone(state.message);
  }, [state, onDone]);

  return (
    <form ref={formRef} action={formAction} className="space-y-4" data-add-vault-form>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="scope" value={scope} />
      <Choice legend="Kind" value={kind} onValueChange={(value) => setKind(value as VaultKind)}>
        <ChoiceCard
          value="variable"
          icon={<BracesIcon />}
          title="Variable"
          hint="Readable configuration. Anyone who can use it can see it."
        />
        <ChoiceCard
          value="secret"
          icon={<LockKeyholeIcon />}
          title="Secret"
          hint="Write-only. Stored encrypted; nobody can read it back."
        />
      </Choice>
      <NameField id={id} kind={kind} value={name} onChange={setName} />
      {kind === "secret" ? (
        // Keyed per kind: a variable's text must never carry over, hidden, into the secret it becomes.
        <ValueField key="secret" id={id} kind="secret" />
      ) : (
        <ValueField key="variable" id={id} kind="variable" value={value} onValue={setValue} />
      )}
      <Choice legend="Who can use it" value={scope} onValueChange={(value) => setScope(value as VaultScope)}>
        <ChoiceCard
          value="personal"
          icon={<UserIcon />}
          title="Personal"
          hint="Only you, in the sandboxes you launch."
        />
        <ChoiceCard
          value="org"
          disabled={!isAdmin}
          icon={<UsersIcon />}
          title={`Org (${orgName})`}
          hint={isAdmin ? "Every member. Only admins change it." : "Only an org admin adds these."}
        />
      </Choice>
      {state && !state.ok && <ResultLine result={state} />}
      <div className="flex justify-end">
        <SubmitButton>{kind === "secret" ? "Store secret" : "Save variable"}</SubmitButton>
      </div>
    </form>
  );
}

/** A two-card choice that cannot be changed after creation, marked as such. */
function Choice({
  legend,
  children,
  value,
  onValueChange,
}: {
  legend: string;
  children: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm font-medium">
        {legend}
        <span className="inline-flex items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning [&_svg]:size-3">
          <LockIcon aria-hidden /> Cannot be changed later
        </span>
      </legend>
      <RadioGroup value={value} onValueChange={onValueChange} aria-label={legend} className="sm:grid-cols-2">
        {children}
      </RadioGroup>
    </fieldset>
  );
}

/**
 * The value. A variable's is controlled, so a refused submission keeps what was typed. A secret's is uncontrolled
 * and masked: React empties it after every submission, and it is kept nowhere else. Both are multi-line, so a key or
 * a certificate keeps its line breaks.
 */
function ValueField(
  props: { id: string } & ({ kind: "secret" } | { kind: "variable"; value: string; onValue: (value: string) => void }),
) {
  const { id, kind } = props;
  return (
    <div className="space-y-2">
      <Label htmlFor={`${id}-value`}>{kind === "secret" ? "Secret value" : "Value"}</Label>
      {props.kind === "secret" ? (
        <Textarea
          id={`${id}-value`}
          name="value"
          required
          rows={2}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Paste the value"
          aria-describedby={`${id}-value-hint`}
          className="max-h-40 font-mono [-webkit-text-security:disc]"
          data-1p-ignore
          data-secret-value
        />
      ) : (
        <Textarea
          id={`${id}-value`}
          name="value"
          value={props.value}
          onChange={(event) => props.onValue(event.target.value)}
          rows={2}
          spellCheck={false}
          autoComplete="off"
          placeholder="eu-west-1"
          aria-describedby={`${id}-value-hint`}
          className="max-h-40 font-mono"
        />
      )}
      <p id={`${id}-value-hint`} className="text-xs text-muted-foreground">
        {kind === "secret"
          ? "Line breaks are kept. After saving, nobody can read it back, admins included."
          : `Up to ${MAX_VALUE_BYTES / 1024} KiB. May be empty.`}
      </p>
    </div>
  );
}

type PanelDialog = "edit" | "replace" | "revoke" | "delete" | null;

/**
 * Everything about one variable or secret, in the page's detail panel: its state, who can use and change it, its
 * version and dates, and its management. A variable's value is read on request; a secret has no value to show,
 * only the way to replace it. A member who does not manage an item reads the same facts without the controls.
 */
export function VaultPanel({
  item,
  orgName,
  canManage,
  now,
}: {
  item: VaultItem;
  orgName: string;
  canManage: boolean;
  now: number;
}) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [dialog, setDialog] = useState<PanelDialog>(null);
  const selected = useResourceSelected(itemKey(item));
  const selectedRef = useRef(selected);
  const editRequest = useRef(0);
  selectedRef.current = selected;
  // The retained detail must not leave a portalled editor/confirmation alive
  // after Back closes it, especially an unsubmitted secret replacement.
  useEffect(() => {
    if (!selected) {
      editRequest.current++;
      setDialog(null);
    }
  }, [selected]);
  const active = item.status === "active";
  const fields = {
    org: item.orgId,
    id: item.id,
    kind: item.kind,
    version: String(item.version),
    name: item.name,
  };
  const value = useVariableValue(item);

  const toast = useToast();
  const opener = useRef<HTMLElement | null>(null);
  // A dialog closes back onto the button that opened it. A revoke removes that button and a delete the whole panel:
  // the focus then goes to the panel's title, or to the page's Add button.
  const restoreFocus = useCallback((event: Event) => {
    event.preventDefault();
    if (opener.current?.isConnected) {
      if (opener.current.getClientRects().length) opener.current.focus();
      return; // The parent restores row focus when a retained opener is hidden.
    }
    const title = visibleResourcePanelTitle();
    if (title && !title.closest("[hidden]")) return title.focus();
    document.querySelector<HTMLElement>("[data-add-vault]")?.focus();
  }, []);
  const close = useCallback((next: boolean) => {
    if (!next) setDialog(null);
  }, []);
  const onResult = useCallback((next: ActionResult) => setResult(next), []);
  // The panel goes away with the item, so a deletion is confirmed where it stays visible.
  const onDeleted = useCallback(
    (next: ActionResult) => {
      if (next.ok) toast({ tone: "success", title: next.message });
    },
    [toast],
  );
  function open(next: PanelDialog) {
    return (event: { currentTarget: HTMLElement }) => {
      opener.current = event.currentTarget;
      setResult(null);
      setDialog(next);
    };
  }

  return (
    <div className="space-y-4" data-vault-panel={item.name} data-vault-kind={item.kind}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Kind</dt>
        <dd>{item.kind === "secret" ? "Secret (write-only)" : "Variable (readable)"}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd data-vault-status={item.status}>{active ? "Active" : "Revoked"}</dd>
        <dt className="text-muted-foreground">Who can use it</dt>
        <dd>{audience(item, orgName)}</dd>
        <dt className="text-muted-foreground">Who can change it</dt>
        <dd>{item.scope === "personal" ? "Only you" : `${orgName}'s admins`}</dd>
        <dt className="text-muted-foreground">Version</dt>
        <dd className="tabular-nums">{item.version}</dd>
        <dt className="text-muted-foreground">Created</dt>
        <dd>
          <CreatedAt iso={item.createdAt} now={now} />
        </dd>
        <dt className="text-muted-foreground">Last changed</dt>
        <dd>
          <CreatedAt iso={item.updatedAt} now={now} />
        </dd>
        {item.expiresAt && (
          <>
            <dt className="text-muted-foreground">Expires</dt>
            <dd>{expiryLabel(item.expiresAt, now)}</dd>
          </>
        )}
      </dl>

      <section aria-label="Value" className="space-y-2 border-t pt-4">
        {!active ? (
          <p className="text-sm text-muted-foreground">
            Revoked: its value was erased and it cannot be restored. Delete it to reuse the name.
          </p>
        ) : item.kind === "secret" ? (
          <div className="flex gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm" data-write-only>
            <LockKeyholeIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
            <p>
              <span className="font-medium">Write-only.</span>{" "}
              <span className="text-muted-foreground">
                The value is stored encrypted and is never shown, copied or exported, to you or to admins. To change it,
                replace it.
              </span>
            </p>
          </div>
        ) : (
          <VariableValue name={item.name} value={value} />
        )}
      </section>

      {canManage ? (
        <div className="flex flex-wrap gap-2 border-t pt-4">
          {active && item.kind === "variable" && (
            <Button
              variant="outline"
              size="sm"
              onClick={(event) => {
                opener.current = event.currentTarget;
                setResult(null);
                // The form starts from the current value: read it first.
                const request = ++editRequest.current;
                void value.load().then((loaded) => {
                  if (loaded && selectedRef.current && request === editRequest.current) setDialog("edit");
                });
              }}
            >
              <PencilIcon /> Edit
            </Button>
          )}
          {active && item.kind === "secret" && (
            <Button variant="outline" size="sm" onClick={open("replace")}>
              <KeyRoundIcon /> Replace value
            </Button>
          )}
          {active && (
            <Button variant="destructive-outline" size="sm" onClick={open("revoke")}>
              Revoke
            </Button>
          )}
          <Button variant="destructive-outline" size="sm" onClick={open("delete")}>
            <Trash2Icon /> Delete
          </Button>
        </div>
      ) : (
        <p className="border-t pt-4 text-xs text-muted-foreground">Managed by {orgName}'s admins.</p>
      )}
      <div className="empty:hidden">
        <ResultLine result={result} />
      </div>

      {canManage && (
        <>
          {item.kind === "variable" && value.state.status === "shown" && (
            <EditVariableDialog
              open={selected && dialog === "edit"}
              onOpenChange={close}
              onCloseAutoFocus={restoreFocus}
              onResult={onResult}
              fields={fields}
              value={value.state.value}
            />
          )}
          {item.kind === "secret" && (
            <ReplaceSecretDialog
              open={selected && dialog === "replace"}
              onOpenChange={close}
              onCloseAutoFocus={restoreFocus}
              onResult={onResult}
              fields={fields}
            />
          )}
          <ConfirmAction
            open={selected && dialog === "revoke"}
            onOpenChange={close}
            onCloseAutoFocus={restoreFocus}
            onResult={onResult}
            action={revokeVaultItem}
            fields={fields}
            title={`Revoke ${item.name}?`}
            description={`Its value is erased now and it can no longer be used. A revoked ${item.kind} cannot be restored or replaced: to reuse the name, delete it and add it again.`}
            confirm="Revoke"
          />
          <ConfirmAction
            open={selected && dialog === "delete"}
            onOpenChange={close}
            onCloseAutoFocus={restoreFocus}
            onResult={onDeleted}
            action={deleteVaultItem}
            fields={fields}
            title={`Delete ${item.name}?`}
            description={`It is removed from this list and its value is erased. This cannot be undone.`}
            confirm="Delete"
          />
        </>
      )}
    </div>
  );
}

type ValueState =
  | { status: "hidden" }
  | { status: "loading" }
  | { status: "shown"; value: string }
  | { status: "failed"; error: string };

/** A readable variable's value, fetched only when asked for and dropped when hidden or when the item changes. */
function useVariableValue(item: VaultItem) {
  const [state, setState] = useState<ValueState>({ status: "hidden" });
  const [, startTransition] = useTransition();
  // A new version (an edit elsewhere) or a revocation drops what was read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the item's identity, version or status changes
  useEffect(() => setState({ status: "hidden" }), [item.id, item.version, item.status]);
  const load = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        setState({ status: "loading" });
        startTransition(async () => {
          const read = await readVariableValue(item.orgId, item.id);
          setState(read.ok ? { status: "shown", value: read.value } : { status: "failed", error: read.error });
          resolve(read.ok);
        });
      }),
    [item.orgId, item.id],
  );
  const hide = useCallback(() => setState({ status: "hidden" }), []);
  return { state, load, hide };
}

function VariableValue({ name, value }: { name: string; value: ReturnType<typeof useVariableValue> }) {
  const { state } = value;
  if (state.status === "shown") {
    return (
      <div className="space-y-2">
        <div className="flex items-start gap-1 rounded-md border bg-muted/40 px-3 py-2">
          <pre className="min-w-0 flex-1 font-mono text-xs break-all whitespace-pre-wrap" data-variable-value>
            {state.value === "" ? <span className="text-muted-foreground italic">Empty</span> : state.value}
          </pre>
          <CopyButton value={state.value} label={`Copy ${name}`} />
        </div>
        <Button variant="ghost" size="sm" onClick={value.hide}>
          <EyeOffIcon /> Hide value
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Button variant="outline" size="sm" onClick={() => void value.load()} disabled={state.status === "loading"}>
        {state.status === "loading" ? <Loader2Icon className="animate-spin" /> : <EyeIcon />} Show value
      </Button>
      {state.status === "failed" && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </div>
  );
}

type Controlled = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
  onResult: (result: ActionResult) => void;
  fields: Record<string, string>;
};

/** Closes the dialog on a success and reports it on the panel; a failure stays in the dialog to retry. */
function useDialogAction(action: Action, { onResult, onOpenChange }: Pick<Controlled, "onResult" | "onOpenChange">) {
  // Reported by the action, not by an effect on its state: the refresh that follows may unmount this dialog (a
  // deletion removes the whole panel).
  const run = useCallback(
    async (previous: ActionResult | null, data: FormData) => {
      const next = await action(previous, data);
      if (next.ok) {
        onResult(next);
        onOpenChange(false);
      }
      return next;
    },
    [action, onResult, onOpenChange],
  );
  const [state, formAction] = useActionState(run, null);
  return [state, formAction] as const;
}

function Hidden({ fields }: { fields: Record<string, string> }) {
  return Object.entries(fields).map(([key, value]) => <input key={key} type="hidden" name={key} value={value} />);
}

function EditVariableDialog({ value, ...props }: Controlled & { value: string }) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto sm:max-w-lg"
        onCloseAutoFocus={props.onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>Edit {props.fields.name}</DialogTitle>
          <DialogDescription>Saving makes a new version. Who can use it stays the same.</DialogDescription>
        </DialogHeader>
        {props.open && <EditVariableForm {...props} value={value} />}
      </DialogContent>
    </Dialog>
  );
}

function EditVariableForm({ value, fields, onResult, onOpenChange }: Controlled & { value: string }) {
  const [state, formAction] = useDialogAction(updateVariable, { onResult, onOpenChange });
  const { name: current = "", ...target } = fields;
  const [name, setName] = useState(current);
  const [edited, setEdited] = useState(value);
  const id = useId();
  return (
    <form action={formAction} className="space-y-4">
      <Hidden fields={target} />
      <NameField id={id} kind="variable" value={name} onChange={setName} />
      <ValueField id={id} kind="variable" value={edited} onValue={setEdited} />
      {state && !state.ok && <ResultLine result={state} />}
      <div className="flex justify-end">
        <SubmitButton>Save changes</SubmitButton>
      </div>
    </form>
  );
}

function ReplaceSecretDialog(props: Controlled) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="gap-5 sm:max-w-lg" onCloseAutoFocus={props.onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Replace {props.fields.name}</DialogTitle>
          <DialogDescription>
            The current value is overwritten and cannot be recovered. Agents launched afterwards get the new one.
          </DialogDescription>
        </DialogHeader>
        {props.open && <ReplaceSecretForm {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function ReplaceSecretForm({ fields, onResult, onOpenChange }: Controlled) {
  const [state, formAction] = useDialogAction(replaceSecret, { onResult, onOpenChange });
  const id = useId();
  return (
    <form action={formAction} className="space-y-4">
      <Hidden fields={fields} />
      <ValueField id={id} kind="secret" />
      {state && !state.ok && <ResultLine result={state} />}
      <div className="flex justify-end">
        <SubmitButton>Replace value</SubmitButton>
      </div>
    </form>
  );
}

function ConfirmAction({
  action,
  title,
  description,
  confirm,
  ...props
}: Controlled & { action: Action; title: string; description: string; confirm: string }) {
  const [state, formAction] = useDialogAction(action, props);
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent onCloseAutoFocus={props.onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {state && !state.ok && <ResultLine result={state} />}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <form action={formAction}>
            <Hidden fields={props.fields} />
            <SubmitButton variant="destructive">{confirm}</SubmitButton>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
