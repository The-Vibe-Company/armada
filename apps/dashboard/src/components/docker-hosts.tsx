"use client";

import { CircleCheckIcon, Loader2Icon, ServerIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import {
  dockerHostConnected,
  registerDockerHost,
  revokeDockerHost,
  updateDockerHostLimits,
} from "@/app/actions/docker-hosts";
import { ConfirmedAction } from "@/components/confirmed-action";
import { CopyButton } from "@/components/copy-button";
import { CreateDialog } from "@/components/create-dialog";
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
import { type DockerHost, expiryCountdown, HOST_NAME_MAX, revokeWarning } from "@/lib/docker-hosts";
import { cn } from "@/lib/utils";

/** How often the open dialog asks whether the new host has connected; the daemon itself polls every 20 seconds. */
const CONNECT_POLL_MS = 5_000;
/** A host that used its token just before expiry may connect a little later: the dialog keeps asking that long. */
const CONNECT_GRACE_MS = 60_000;

export function HostMark() {
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground ring-1 ring-border [&_svg]:size-4"
    >
      <ServerIcon />
    </span>
  );
}

/**
 * The Hosts page's add flow (#1471): an optional name, then the one command to paste on the machine with a copy
 * button and its expiry, then "Connected" when the host checks in. The command lives only in this dialog's state:
 * closing the dialog drops it, and every opening starts clean.
 */
export function AddHostDialog({ orgId }: { orgId: string }) {
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  // While a command is being issued or shown and the host has not connected, only the close button closes the dialog.
  const [guarded, setGuarded] = useState(false);
  return (
    <CreateDialog
      dismissible={!guarded}
      label="Add host"
      title="Add a Docker host"
      description="Run one command on a Linux machine you own that has Docker, so sandboxes can run on it."
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setGeneration((value) => value + 1);
        setGuarded(false);
      }}
      triggerAttrs={{ "data-add-host": "" }}
    >
      {open && <AddHostForm key={generation} orgId={orgId} onGuard={setGuarded} />}
    </CreateDialog>
  );
}

function AddHostForm({ orgId, onGuard }: { orgId: string; onGuard: (guarded: boolean) => void }) {
  const [state, formAction, pending] = useActionState(registerDockerHost, null);
  const [name, setName] = useState("");
  const issued = state?.ok === true;
  const connected = useCallback(() => onGuard(false), [onGuard]);
  useEffect(() => {
    onGuard(pending || issued);
  }, [pending, issued, onGuard]);

  // The same form, hidden, issues a new command once this one has expired: same organization, same name.
  const fields = (
    <>
      <input type="hidden" name="org" value={orgId} />
      {state?.ok && <input type="hidden" name="name" value={name} />}
    </>
  );

  if (state?.ok)
    return (
      <form action={formAction} data-add-host-form>
        {fields}
        <Registration
          key={state.hostId}
          orgId={orgId}
          hostId={state.hostId}
          command={state.command}
          expiresAt={state.expiresAt}
          renewing={pending}
          onConnected={connected}
        />
      </form>
    );

  return (
    <form action={formAction} className="space-y-4" data-add-host-form>
      {fields}
      <div className="space-y-1.5">
        <Label htmlFor="host-name">
          Name <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="host-name"
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={HOST_NAME_MAX}
          placeholder="build-box"
          autoComplete="off"
        />
      </div>
      {state && !state.ok && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending && <Loader2Icon aria-hidden className="animate-spin" />}
          {pending ? "Creating command…" : "Get install command"}
        </Button>
      </div>
    </form>
  );
}

function Registration({
  orgId,
  hostId,
  command,
  expiresAt,
  renewing,
  onConnected,
}: {
  orgId: string;
  hostId: string;
  command: string;
  expiresAt: string;
  renewing: boolean;
  onConnected: () => void;
}) {
  const router = useRouter();
  const [connected, setConnected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const heading = useRef<HTMLHeadingElement>(null);
  // The form and its button are gone: focus lands on the command, the one thing to act on now.
  useEffect(() => heading.current?.focus(), []);

  const left = expiryCountdown(expiresAt, now);
  useEffect(() => {
    if (connected !== null || left === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [connected, left]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const until = Date.parse(expiresAt) + CONNECT_GRACE_MS;
    const ask = async () => {
      if (stopped) return;
      const answer = await dockerHostConnected(orgId, hostId).catch(() => null);
      if (stopped) return;
      if (answer) {
        setConnected(answer.name);
        onConnected();
        router.refresh();
        return;
      }
      if (Date.now() > until) return;
      timer = setTimeout(ask, CONNECT_POLL_MS);
    };
    timer = setTimeout(ask, CONNECT_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [orgId, hostId, expiresAt, router, onConnected]);

  if (connected !== null)
    return (
      <p role="status" className="flex items-center gap-2 text-sm" data-host-connected={hostId}>
        <CircleCheckIcon aria-hidden className="size-4 shrink-0 text-success" />
        <span>
          Connected: <span className="font-medium">{connected}</span> is online. You can close this dialog.
        </span>
      </p>
    );

  return (
    <div className="space-y-4" data-host-registration={hostId}>
      <section className="space-y-1.5">
        <h3 ref={heading} tabIndex={-1} className="text-sm font-medium outline-none">
          Run this command on the machine
        </h3>
        <div
          className="flex items-start gap-1 rounded-md border bg-muted/50 py-2 pr-1.5 pl-3"
          data-expired={left === null ? "" : undefined}
        >
          <pre
            className={cn(
              "min-w-0 flex-1 overflow-x-auto font-mono text-xs leading-6 whitespace-pre",
              left === null && "text-muted-foreground line-through",
            )}
            data-registration-command
          >
            {command}
          </pre>
          {left !== null && <CopyButton value={command} label="Copy command" />}
        </div>
        <p className="text-xs text-muted-foreground">
          Run it only on a machine you own: Docker access there is as powerful as root.
        </p>
      </section>
      {left === null ? (
        <div className="flex items-center justify-between gap-3" data-registration-expired>
          <p role="status" className="text-sm text-muted-foreground">
            This command has expired.
          </p>
          <Button type="submit" variant="outline" size="sm" disabled={renewing}>
            {renewing && <Loader2Icon aria-hidden className="animate-spin" />}
            {renewing ? "Creating command…" : "Generate a new command"}
          </Button>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon aria-hidden className="size-4 animate-spin" />
          <span role="status">Waiting for the host to connect…</span>
          <span className="ml-auto font-mono text-xs tabular-nums" data-registration-expires>
            Expires in {left}
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * Revoke from a host's row. The host's credential stops working at once, so it can no longer stop or delete what
 * still runs there: the confirmation says so when the host has sandboxes.
 */
export function RevokeHost({
  orgId,
  hostId,
  name,
  sandboxes,
}: {
  orgId: string;
  hostId: string;
  name: string;
  sandboxes: number;
}) {
  return (
    <ConfirmedAction
      action={revokeDockerHost}
      trigger="Revoke"
      triggerLabel={`Revoke ${name}`}
      title={`Revoke ${name}?`}
      description={revokeWarning(sandboxes)}
      confirm="Revoke host"
      pendingLabel="Revoking…"
      successFocusId={`host-${hostId}-title`}
    >
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="hostId" value={hostId} />
    </ConfirmedAction>
  );
}

/** Resource edits live in a short centered dialog, separate from host registration. */
export function HostLimitsDialog({ orgId, host }: { orgId: string; host: DockerHost }) {
  const [open, setOpen] = useState(false);
  if (host.state === "revoked")
    return <p className="text-sm text-muted-foreground">Resource limits are unavailable for revoked hosts.</p>;
  if (!host.limitsSupported)
    return (
      <p className="text-sm text-muted-foreground">
        Limits unavailable. Update the host daemon and wait for it to report machine resources.
      </p>
    );
  if (!host.canManageLimits)
    return <p className="text-sm text-muted-foreground">Only the host owner can change resource limits.</p>;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="space-y-1.5">
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" disabled={host.state !== "online"}>
            Edit limits
          </Button>
        </DialogTrigger>
        {host.state !== "online" && (
          <p className="text-sm text-muted-foreground">Bring the host online to change limits.</p>
        )}
      </div>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Host resource limits</DialogTitle>
          <DialogDescription>
            Stop all sandboxes and wait for builds and pending work to finish before changing CPU or memory. Capacity
            can change while running, but cannot be lowered below current reservations.
          </DialogDescription>
        </DialogHeader>
        {open && <HostLimitsForm orgId={orgId} host={host} onSaved={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function HostLimitsForm({ orgId, host, onSaved }: { orgId: string; host: DockerHost; onSaved: () => void }) {
  const router = useRouter();
  const [state, submit, pending] = useActionState(updateDockerHostLimits, null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state?.ok) {
      onSaved();
      router.refresh();
    } else if (state) errorRef.current?.focus();
  }, [state, onSaved, router]);
  return (
    <form action={submit} className="space-y-4" aria-busy={pending}>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="hostId" value={host.id} />
      <p id="host-limits-hint" className="text-xs text-muted-foreground">
        Leave a field blank to keep its current setting. Use automatic resets every override.
      </p>
      {!host.resources && (
        <p role="status" className="text-sm text-muted-foreground">
          Current resources are unavailable. Use automatic to clear overrides, then wait for the host to report its
          resources.
        </p>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="host-limit-cpus">CPUs per sandbox</Label>
        <Input
          id="host-limit-cpus"
          name="cpus"
          type="number"
          min="0"
          step="any"
          placeholder={host.resources ? String(host.resources.perSandbox.cpus) : "Unknown"}
          aria-describedby="host-limits-hint"
          disabled={pending || !host.resources}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="host-limit-memory">Memory per sandbox</Label>
        <Input
          id="host-limit-memory"
          name="memory"
          placeholder="e.g. 4g or 512m"
          autoComplete="off"
          aria-describedby="host-limits-hint"
          disabled={pending || !host.resources}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="host-limit-count">Maximum running sandboxes</Label>
        <Input
          id="host-limit-count"
          name="maxSandboxes"
          type="number"
          min="1"
          step="1"
          placeholder={host.resources ? String(host.resources.capacity) : "Unknown"}
          aria-describedby="host-limits-hint"
          disabled={pending || !host.resources}
        />
      </div>
      {state && !state.ok && (
        <p ref={errorRef} tabIndex={-1} role="alert" className="text-sm text-destructive outline-none">
          {state.error}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="submit" name="mode" value="auto" variant="outline" disabled={pending} formNoValidate>
          Use automatic
        </Button>
        <Button type="submit" name="mode" value="save" disabled={pending || !host.resources}>
          {pending && <Loader2Icon aria-hidden className="animate-spin" />}
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
