"use client";

import { KeyRoundIcon, UserIcon, UsersIcon } from "lucide-react";
import { type ReactNode, useActionState, useCallback, useEffect, useId, useRef, useState } from "react";
import { removeSkillpackKey, saveSkillpackKey } from "@/app/actions/skillpack-key";
import { SubmitButton } from "@/components/action-form";
import { ChoiceCard } from "@/components/connections";
import { CreateDialog } from "@/components/create-dialog";
import { PageHeader } from "@/components/page-header";
import { RowTag, StateCell } from "@/components/state-cell";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action";
import { type SkillpackKey, type SkillpackKeys, type SkillpackScope, skillpackAudience } from "@/lib/skillpack-key";

type Props = {
  title: string;
  description: string;
  orgId: string;
  orgName: string;
  isAdmin: boolean;
  keys: SkillpackKeys;
};

const SCOPES: readonly SkillpackScope[] = ["user", "org"];

/**
 * The Skills page (#957): the Skillpack key that installs private skills, the viewer's own and the organization's.
 * Adding and replacing share one {@link CreateDialog}, opened from the header or from a row with its scope chosen.
 * The key is an uncontrolled password field: sent once, emptied by React after the submission, and the dialog closes
 * on success, so it is kept nowhere in the page.
 */
export function SkillpackKeyView({ title, description, orgId, orgName, isAdmin, keys }: Props) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<SkillpackScope>("user");
  const [generation, setGeneration] = useState(0);
  const toast = useToast();
  // A row's Add or Replace opens the dialog without its trigger: closing goes back to that button, not the header's.
  const opener = useRef<HTMLElement | null>(null);
  const openFor = (next: SkillpackScope, from: HTMLElement | null = null) => {
    opener.current = from;
    setScope(next);
    setGeneration((value) => value + 1);
    setOpen(true);
  };
  const stored = useCallback(
    (message: string) => {
      toast({ tone: "success", title: message });
      setOpen(false);
    },
    [toast],
  );

  return (
    <>
      <PageHeader title={title} description={description}>
        <CreateDialog
          label="Add key"
          title="Add a Skillpack key"
          description="Armada uses it to install private skills in the sandboxes it launches."
          open={open}
          onOpenChange={(next) => {
            // Every opening from the header starts a clean form, on the viewer's own key.
            if (next) openFor("user");
            else setOpen(false);
          }}
          className="sm:max-w-lg"
          onCloseAutoFocus={(event) => {
            if (!opener.current?.isConnected) return;
            event.preventDefault();
            opener.current.focus();
          }}
          triggerAttrs={{ "data-add-skillpack-key": "" }}
        >
          <KeyForm
            key={generation}
            orgId={orgId}
            orgName={orgName}
            isAdmin={isAdmin}
            keys={keys}
            initialScope={scope}
            onDone={stored}
          />
        </CreateDialog>
      </PageHeader>

      <div className="space-y-3">
        <ul aria-label="Skillpack keys" className="@container divide-y overflow-hidden rounded-xl border bg-card">
          {SCOPES.map((item) => (
            <KeyRow
              key={item}
              scope={item}
              orgId={orgId}
              orgName={orgName}
              stored={keys[item]}
              canManage={item === "user" || isAdmin}
              onSet={(from) => openFor(item, from)}
            />
          ))}
        </ul>
        <p className="max-w-3xl text-xs text-pretty text-muted-foreground">
          Your key is used first; the organization's serves members without one. If your key is refused, Armada does not
          fall back to the organization's. Without a key, only public skills install. A key is write-only: once stored,
          nobody can read it back.
        </p>
      </div>
    </>
  );
}

function KeyRow({
  scope,
  orgId,
  orgName,
  stored,
  canManage,
  onSet,
}: {
  scope: SkillpackScope;
  orgId: string;
  orgName: string;
  stored: SkillpackKey | null;
  canManage: boolean;
  onSet: (from: HTMLElement) => void;
}) {
  const name = scope === "user" ? "Your key" : `${orgName} key`;
  const state = !stored
    ? { tone: "neutral" as const, label: "Not set" }
    : stored.usable
      ? { tone: "success" as const, label: "Active" }
      : { tone: "warning" as const, label: "Expired or revoked" };
  return (
    <li
      className="grid gap-x-4 gap-y-2 px-4 py-3 @3xl:grid-cols-[minmax(0,1fr)_10rem_minmax(0,11rem)_11rem] @3xl:items-center"
      data-skillpack-key={scope}
      data-skillpack-state={stored ? (stored.usable ? "active" : "unusable") : "not-set"}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-md border border-primary/25 bg-primary/10 text-primary [&_svg]:size-4"
        >
          <KeyRoundIcon />
        </span>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {name}
            <RowTag>
              {scope === "user" ? <UserIcon aria-hidden /> : <UsersIcon aria-hidden />}
              {scope === "user" ? "Personal" : "Org"}
            </RowTag>
          </p>
          <p className="text-xs text-muted-foreground">
            {stored?.setAt ? (
              <>
                Set <time dateTime={stored.setAt}>{stored.setAt.slice(0, 10)}</time> · value hidden
              </>
            ) : stored ? (
              "Value hidden"
            ) : (
              "No key stored"
            )}
          </p>
        </div>
      </div>
      <StateCell tone={state.tone} label={state.label} className="ps-11 @3xl:ps-0" />
      <p className="hidden truncate text-sm text-muted-foreground @3xl:block">{skillpackAudience(scope, orgName)}</p>
      <div className="flex flex-wrap items-center gap-2 ps-11 @3xl:justify-end @3xl:ps-0">
        {canManage ? (
          <>
            <Button
              size="sm"
              variant={stored ? "outline" : "default"}
              onClick={(event) => onSet(event.currentTarget)}
              data-skillpack-set
              aria-label={`${stored ? "Replace" : "Add"} ${scope === "user" ? "your" : "the organization's"} Skillpack key`}
            >
              {stored ? "Replace" : "Add"}
            </Button>
            {stored && <RemoveKey scope={scope} orgId={orgId} />}
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Only an admin changes it.</span>
        )}
      </div>
    </li>
  );
}

function KeyForm({
  orgId,
  orgName,
  isAdmin,
  keys,
  initialScope,
  onDone,
}: {
  orgId: string;
  orgName: string;
  isAdmin: boolean;
  keys: SkillpackKeys;
  initialScope: SkillpackScope;
  onDone: (message: string) => void;
}) {
  const [state, formAction] = useActionState(saveSkillpackKey, null);
  const [scope, setScope] = useState<SkillpackScope>(isAdmin ? initialScope : "user");
  const id = useId();
  useEffect(() => {
    if (state?.ok) onDone(state.message);
  }, [state, onDone]);

  return (
    <form action={formAction} className="space-y-4" data-skillpack-form>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="scope" value={scope} />
      <p className="text-sm text-muted-foreground" data-skillpack-scope-note>
        We recommend a read-only key with the <code className="font-mono text-xs">skills:read</code> scope.
      </p>
      <div className="space-y-2">
        <Label htmlFor={`${id}-value`}>Key</Label>
        <Input
          id={`${id}-value`}
          name="value"
          type="password"
          required
          autoComplete="off"
          spellCheck={false}
          placeholder="cmp_pat_…"
          aria-describedby={`${id}-value-hint`}
          className="font-mono"
        />
        <p id={`${id}-value-hint`} className="text-xs text-muted-foreground">
          Stored encrypted. Nobody can read it back, admins included.
        </p>
      </div>
      <Choice legend="Who uses it">
        <ChoiceCard
          name={`${id}-scope`}
          checked={scope === "user"}
          onChange={() => setScope("user")}
          icon={<UserIcon />}
          title="Personal"
          hint="Only you. Used before the organization's key."
        />
        <ChoiceCard
          name={`${id}-scope`}
          checked={scope === "org"}
          onChange={() => setScope("org")}
          disabled={!isAdmin}
          icon={<UsersIcon />}
          title={`Org (${orgName})`}
          hint={isAdmin ? "Members without a key of their own." : "Only an org admin sets it."}
        />
      </Choice>
      {keys[scope] && (
        <p className="text-xs text-muted-foreground" data-skillpack-replaces>
          This replaces the {scope === "user" ? "personal" : "organization"} key stored now.
        </p>
      )}
      {state && !state.ok && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <div className="flex justify-end">
        <SubmitButton>Store key</SubmitButton>
      </div>
    </form>
  );
}

function Choice({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

/**
 * Remove, confirmed. The form lives inside the dialog's content, which unmounts on close, so a refusal is not shown
 * again on the next opening. Focus returns to Remove, or once the key is gone to the row's Add button.
 */
function RemoveKey({ scope, orgId }: { scope: SkillpackScope; orgId: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const whose = scope === "user" ? "your" : "the organization's";
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        ref={button}
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        aria-label={`Remove ${whose} Skillpack key`}
      >
        Remove
      </Button>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (button.current?.isConnected) return button.current.focus();
          document.querySelector<HTMLElement>(`[data-skillpack-key="${scope}"] [data-skillpack-set]`)?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {whose} Skillpack key?</AlertDialogTitle>
          <AlertDialogDescription>
            {scope === "user"
              ? "Your launches then use the organization's key, or install public skills only."
              : "Members without a key of their own can then install public skills only."}{" "}
            Revoke the key in Skillpack too if you no longer need it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <RemoveForm scope={scope} orgId={orgId} onRemoved={() => setOpen(false)} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RemoveForm({ scope, orgId, onRemoved }: { scope: SkillpackScope; orgId: string; onRemoved: () => void }) {
  const toast = useToast();
  const [state, formAction] = useActionState(async (previous: ActionResult | null, data: FormData) => {
    const result = await removeSkillpackKey(previous, data);
    if (result.ok) {
      toast({ tone: "success", title: result.message });
      onRemoved();
    }
    return result;
  }, null);
  return (
    <>
      {state && !state.ok && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <form action={formAction}>
          <input type="hidden" name="org" value={orgId} />
          <input type="hidden" name="scope" value={scope} />
          <SubmitButton variant="destructive">Remove key</SubmitButton>
        </form>
      </AlertDialogFooter>
    </>
  );
}
