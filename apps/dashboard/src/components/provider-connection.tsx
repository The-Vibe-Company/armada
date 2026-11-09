"use client";

import type { SandboxProviderId } from "@armada/core";
import { ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { connectProvider, disconnectProvider } from "@/app/actions/provider-setup";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionResult } from "@/lib/action";
import { SETUP_PROVIDER_INFO } from "@/lib/provider-setup";
import { cn } from "@/lib/utils";

/** One provider as the server reports it for the active organization; `unavailable` when it could not be read. */
export type ProviderRowState = "connected" | "not-connected" | "unavailable";

const STATE_LABEL: Record<ProviderRowState, string> = {
  connected: "Connected",
  "not-connected": "Not connected",
  unavailable: "Unavailable",
};

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
  const info = SETUP_PROVIDER_INFO[provider];
  const connected = state === "connected";
  const [open, setOpen] = useState(false);
  const [result, action] = useActionState<ActionResult | null, FormData>(async (previous, data) => {
    const next = await connectProvider(previous, data);
    if (next.ok) setOpen(false);
    return next;
  }, null);
  const formId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // Closing the form returns focus to the button that opened it.
  useEffect(() => {
    if (wasOpen.current && !open) toggle.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const manageable = canManage && state !== "unavailable";

  return (
    <li className="space-y-4 p-4" data-provider-row={provider} data-provider-state={state}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="flex items-center gap-2 text-sm font-medium">
            {info.label}
            <Badge
              variant={connected ? "outline" : "secondary"}
              className={cn(connected && "border-success/40 text-success")}
            >
              {STATE_LABEL[state]}
            </Badge>
          </p>
          <p className="text-xs text-muted-foreground">{info.summary}</p>
        </div>
        {manageable && !open && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              ref={toggle}
              variant={connected ? "outline" : "default"}
              size="sm"
              aria-expanded={open}
              aria-controls={formId}
              onClick={() => setOpen(true)}
            >
              {connected ? `Replace ${provider === "boat" ? "key" : "token"}` : `Connect ${info.label}`}
            </Button>
            {connected && <DisconnectProvider orgId={orgId} orgName={orgName} provider={provider} />}
          </div>
        )}
      </div>

      {open && (
        <form id={formId} action={action} className="space-y-3 rounded-lg border bg-muted/30 p-4">
          <input type="hidden" name="org" value={orgId} />
          <input type="hidden" name="provider" value={provider} />
          <input type="hidden" name="mode" value={connected ? "replace" : "connect"} />
          <ProviderFields provider={provider} />
          {result && !result.ok && (
            <p role="alert" className="text-sm text-destructive">
              {result.error}
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
      {result?.ok && !open && (
        <p role="status" className="text-sm text-success">
          {result.message}
        </p>
      )}
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

/** Disconnects after a confirmation that says what stops and what stays. Stays open on a refusal. */
function DisconnectProvider({
  orgId,
  orgName,
  provider,
}: {
  orgId: string;
  orgName: string;
  provider: SandboxProviderId;
}) {
  const label = SETUP_PROVIDER_INFO[provider].label;
  const [state, action, pending] = useActionState(disconnectProvider, null);
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
            New {label} goldens, rebuilds and launches stop. Existing goldens and sandboxes on {label} stay listed.
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
