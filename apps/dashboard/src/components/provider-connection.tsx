"use client";

import type { SandboxProviderId } from "@armada/core";
import { ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { connectProvider, disconnectProvider } from "@/app/actions/provider-setup";
import { CatalogDrawer } from "@/components/catalog-drawer";
import { ProviderMark, ProviderName } from "@/components/provider-mark";
import { ConnectionBadge } from "@/components/status-badge";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePreservedActionForm } from "@/components/use-preserved-action-form";
import type { ActionResult } from "@/lib/action";
import { clientMutation } from "@/lib/client-mutation";
import { SETUP_PROVIDER_INFO } from "@/lib/provider-setup";

/** One provider as the server reports it for the active organization; `unavailable` when it could not be read. */
export type ProviderRowState = "connected" | "not-connected" | "unavailable";

/**
 * One sandbox provider of the active organization: its status and, for an admin, connect, replace and disconnect.
 * Only this provider's fields are in its form; they are password inputs, never filled back in, and emptied after a
 * successful save. Members see the status alone.
 */
export function ProviderConnection({
  orgId,
  orgName,
  provider,
  state,
  canManage,
}: {
  orgId: string;
  orgName: string;
  provider: SandboxProviderId;
  state: ProviderRowState;
  canManage: boolean;
}) {
  const preserve = usePreservedActionForm();
  const info = SETUP_PROVIDER_INFO[provider];
  const connected = state === "connected";
  const [open, setOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsTrigger = useRef<HTMLButtonElement>(null);
  // The last outcome, and the status it reported: a success is shown only while the row is still in that status, and
  // an error only in the form that caused it, so neither outlives a later change.
  const [feedback, setFeedback] = useState<{ result: ActionResult; state: ProviderRowState } | null>(null);
  const [, action] = useActionState<ActionResult | null, FormData>(async (previous, data) => {
    const next = await clientMutation(() => connectProvider(previous, data));
    setFeedback({ result: next, state: next.ok ? "connected" : state });
    if (next.ok) setOpen(false);
    return next;
  }, null);
  const toggle = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const previousState = useRef(state);
  // Closing the form, or a disconnect that removed the dialog's button, returns focus to this row's main button.
  useEffect(() => {
    if (wasOpen.current && !open) toggle.current?.focus();
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (previousState.current === "connected" && state === "not-connected") toggle.current?.focus();
    previousState.current = state;
  }, [state]);
  const manageable = canManage && state !== "unavailable";
  const success = feedback?.result.ok && feedback.state === state && !open ? feedback.result.message : null;
  const error = feedback && !feedback.result.ok && open ? feedback.result.error : null;

  return (
    <li
      className="min-w-0 overflow-hidden rounded-[10px] border bg-card transition-colors hover:border-foreground/25"
      data-provider-row={provider}
      data-provider-state={state}
    >
      <button
        ref={detailsTrigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={detailsOpen}
        onClick={() => setDetailsOpen(true)}
        className="flex w-full items-start gap-3 p-4 text-left focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="flex size-9 shrink-0 items-center justify-center [&_svg]:size-8">
          <ProviderMark provider={provider} />
        </span>
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block text-sm font-semibold">{info.label}</span>
          <span className="block text-xs text-muted-foreground">
            {connected
              ? `${orgName}’s account`
              : state === "not-connected"
                ? "No account yet"
                : "Account status unavailable"}
          </span>
        </span>
        <ConnectionBadge state={state} />
      </button>
      <div className="border-t bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground">Organization cloud account</div>
      <CatalogDrawer
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        title={info.label}
        subtitle={`${orgName} · Organization cloud account`}
        mark={
          <span className="flex size-10 items-center justify-center [&_svg]:size-8">
            <ProviderMark provider={provider} />
          </span>
        }
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          detailsTrigger.current?.focus();
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <p className="flex items-center gap-2 text-sm font-medium">
              <ProviderName provider={provider} /> cloud
            </p>
            <p className="text-xs text-muted-foreground">
              {connected
                ? `${orgName}’s account`
                : state === "not-connected"
                  ? "No account yet"
                  : "Account status unavailable"}
            </p>
            <ConnectionBadge state={state} />
            {state === "not-connected" && (
              <p className="text-xs text-muted-foreground">
                {provider === "modal" ? "Needs a Modal token (two values)." : "Needs a Boat API key."}
              </p>
            )}
          </div>
          {manageable && !open && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                ref={toggle}
                variant={connected ? "outline" : "default"}
                size="sm"
                onClick={() => {
                  setFeedback(null);
                  setOpen(true);
                }}
              >
                {connected ? `Replace ${info.credentialNoun}` : "Connect"}
              </Button>
              {connected && (
                <DisconnectProvider
                  orgId={orgId}
                  orgName={orgName}
                  provider={provider}
                  onDisconnected={(result) => setFeedback({ result, state: "not-connected" })}
                />
              )}
            </div>
          )}
        </div>

        {open && (
          <form
            ref={preserve}
            action={action}
            aria-label={`${connected ? "Replace" : "Connect"} ${info.label}`}
            className="space-y-3 rounded-lg border bg-muted/30 p-4"
          >
            <input type="hidden" name="org" value={orgId} />
            <input type="hidden" name="provider" value={provider} />
            <input type="hidden" name="mode" value={connected ? "replace" : "connect"} />
            <ProviderFields provider={provider} />
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <ConnectButton label={info.label} replacing={connected} />
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
        {success && (
          <p role="status" className="text-sm text-success">
            {success}
          </p>
        )}
      </CatalogDrawer>
    </li>
  );
}

function ProviderFields({ provider }: { provider: SandboxProviderId }) {
  const id = useId();
  if (provider === "boat")
    return (
      <div className="space-y-2">
        <Label htmlFor={`${id}-boat`}>Boat API key</Label>
        <Input
          id={`${id}-boat`}
          name="boat_key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          autoFocus
          aria-describedby={`${id}-help`}
        />
        <p id={`${id}-help`} className="text-xs">
          <DocsLink provider="boat" />
        </p>
      </div>
    );
  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${id}-modal-id`}>Token ID</Label>
          <Input
            id={`${id}-modal-id`}
            name="modal_token_id"
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            autoFocus
            placeholder="ak-…"
            aria-describedby={`${id}-help`}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-modal-secret`}>Token secret</Label>
          <Input
            id={`${id}-modal-secret`}
            name="modal_token_secret"
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            placeholder="as-…"
            aria-describedby={`${id}-help`}
          />
        </div>
      </div>
      <p id={`${id}-help`} className="text-xs">
        <DocsLink provider="modal" />
      </p>
    </div>
  );
}

function DocsLink({ provider }: { provider: SandboxProviderId }) {
  const info = SETUP_PROVIDER_INFO[provider];
  return (
    <a
      href={info.docs}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4"
    >
      {info.docsLabel}
      <ExternalLinkIcon className="size-3" aria-hidden />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

function ConnectButton({ label, replacing }: { label: string; replacing: boolean }) {
  const { pending } = useFormStatus();
  return (
    <>
      <Button type="submit" size="sm" disabled={pending}>
        {pending && <Loader2Icon className="animate-spin" />}
        {pending ? `Checking with ${label}…` : replacing ? "Save and replace" : `Connect ${label}`}
      </Button>
      <p role="status" className="sr-only">
        {pending ? `Checking the credentials with ${label}…` : ""}
      </p>
    </>
  );
}

/**
 * Disconnects after a confirmation that says what stops and what stays. Stays open on a refusal; a success is
 * reported by the row, since this dialog leaves with its button.
 */
function DisconnectProvider({
  orgId,
  orgName,
  provider,
  onDisconnected,
}: {
  orgId: string;
  orgName: string;
  provider: SandboxProviderId;
  onDisconnected: (result: ActionResult) => void;
}) {
  const label = SETUP_PROVIDER_INFO[provider].label;
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(async (previous, data) => {
    const next = await clientMutation(() => disconnectProvider(previous, data));
    if (next.ok) onDisconnected(next);
    return next;
  }, null);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive">
          Disconnect
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Disconnect {label} from {orgName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            New {label} snapshots, rebuilds and launches stop. Existing snapshots and sandboxes on {label} stay listed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {state && !state.ok && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <form action={action}>
            <input type="hidden" name="org" value={orgId} />
            <input type="hidden" name="provider" value={provider} />
            <Button type="submit" variant="destructive" disabled={pending} className="w-full">
              {pending && <Loader2Icon className="animate-spin" />}
              Disconnect {label}
            </Button>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
