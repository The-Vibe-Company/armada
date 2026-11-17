"use client";

import { CircleCheckIcon, Loader2Icon, ServerIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  dockerHostConnected,
  registerDockerHost,
  revokeDockerHost,
  updateDockerHostLimits,
  updateDockerHostRetention,
} from "@/app/actions/docker-hosts";
import { ConfirmedAction } from "@/components/confirmed-action";
import { CreateDialog } from "@/components/create-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMutationState } from "@/components/use-mutation-state";
import { usePreservedActionForm } from "@/components/use-preserved-action-form";
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
      label="Register a Docker host"
      title="Register a Docker host"
      description="A Linux machine you own, with Docker installed. Armada runs sandboxes on it as containers."
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
  const [state, formAction, pending] = useMutationState(registerDockerHost);
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
      <p className="rounded-lg border-l-4 border-warning bg-muted p-3 text-sm">
        Whoever runs this command gives Armada control of Docker on that machine, which is as powerful as root there.
      </p>
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
  const [copyState, setCopyState] = useState("Copy command");
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
      <div className="space-y-4" data-host-connected={hostId}>
        <p role="status" className="flex items-center gap-2 text-sm">
          <CircleCheckIcon aria-hidden className="size-4 text-success" />
          {connected} is online
        </p>
        <div className="flex flex-wrap justify-between gap-2">
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              Close
            </Button>
          </DialogClose>
          <Button asChild>
            <a href={`/providers/cloud?item=${hostId}`}>Launch a sandbox on it</a>
          </Button>
        </div>
      </div>
    );

  return (
    <div className="space-y-4" data-host-registration={hostId}>
      <p className="rounded-lg border-l-4 border-warning bg-muted p-3 text-sm">
        Whoever runs this command gives Armada control of Docker on that machine, which is as powerful as root there.
      </p>
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
              "min-w-0 flex-1 break-all font-mono text-xs leading-6 whitespace-pre-wrap",
              left === null && "text-muted-foreground line-through",
            )}
            data-registration-command
          >
            {command}
          </pre>
        </div>
        <p className="text-xs text-muted-foreground">
          If the machine is already linked to this Armada, the command keeps the existing registration and updates the
          daemon.
        </p>
      </section>
      {left === null ? (
        <div className="flex flex-wrap items-center justify-between gap-3" data-registration-expired>
          <p role="status" className="text-sm text-muted-foreground">
            This command has expired.
          </p>
          <Button type="submit" variant="outline" size="sm" disabled={renewing}>
            {renewing && <Loader2Icon aria-hidden className="animate-spin" />}
            {renewing ? "Creating command…" : "Make a new command"}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p role="status" className="text-sm text-muted-foreground">
            Waiting for the machine · works for{" "}
            <span className="tabular-nums" data-registration-expires>
              {left}
            </span>{" "}
            more
          </p>
          <Button
            type="button"
            className="w-full sm:w-auto"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(command);
                setCopyState("Copied");
              } catch {
                setCopyState("Copy failed");
              }
            }}
          >
            {copyState}
          </Button>
        </div>
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
      trigger="Unlink"
      triggerLabel={`Unlink ${name}`}
      title={`Unlink ${name}?`}
      description={revokeWarning(sandboxes)}
      confirm="Unlink server"
      pendingLabel="Unlinking…"
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
    return <p className="text-sm text-muted-foreground">Resource limits are unavailable for unlinked servers.</p>;
  if (!host.limitsSupported)
    return (
      <p className="text-sm text-muted-foreground">
        Limits unavailable. Update the server and wait for it to report machine resources.
      </p>
    );
  if (!host.canManageLimits)
    return (
      <p className="text-sm text-muted-foreground">Only the member who added the server can change resource limits.</p>
    );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="space-y-1.5">
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" disabled={host.state !== "online"}>
            Change limits
          </Button>
        </DialogTrigger>
        {host.state !== "online" && (
          <p className="text-sm text-muted-foreground">Bring the server online to change limits.</p>
        )}
      </div>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Server limits</DialogTitle>
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
  const preserve = usePreservedActionForm();
  const router = useRouter();
  const [state, submit, pending] = useMutationState(updateDockerHostLimits);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state?.ok) {
      onSaved();
      router.refresh();
    } else if (state) errorRef.current?.focus();
  }, [state, onSaved, router]);
  return (
    <form ref={preserve} action={submit} className="space-y-4" aria-busy={pending}>
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
          disabled={pending || !host.resources || (host.running ?? host.sandboxes) > 0}
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
          disabled={pending || !host.resources || (host.running ?? host.sandboxes) > 0}
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
        <Button
          type="submit"
          name="mode"
          value="auto"
          variant="outline"
          disabled={pending || (host.running ?? host.sandboxes) > 0}
          formNoValidate
        >
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

export function HostRetention({ orgId, host }: { orgId: string; host: DockerHost }) {
  const preserve = usePreservedActionForm();
  const [state, action, pending] = useMutationState(updateDockerHostRetention);
  return (
    <div className="space-y-3 text-sm">
      <p>
        Retention:{" "}
        {host.retentionSeconds == null ? "Unknown — update the server daemon" : `${host.retentionSeconds} seconds`}
      </p>
      <p>
        Docker disk free:{" "}
        {host.diskFreeBytes == null
          ? "Unknown — update/check the daemon"
          : `${(host.diskFreeBytes / 1e9).toFixed(2)} GB (${host.diskFreeBytes} bytes)`}
        . Launch floor: 10 GB.
      </p>
      <p>
        Stopped sandbox space:{" "}
        {host.stoppedSandboxBytes == null
          ? "Unknown — not reported"
          : `${(host.stoppedSandboxBytes / 1e9).toFixed(2)} GB (${host.stoppedSandboxBytes} bytes)`}
      </p>
      <p>Next cleanup: {host.nextCleanupAt ? new Date(host.nextCleanupAt).toISOString() : "None reported"}</p>
      <p className="text-xs text-muted-foreground">
        As of last check-in: {host.lastSeenAt ?? "Never"}. Offline servers enforce their last saved policy.
      </p>
      {host.retentionOverrideSeconds != null && host.retentionOverrideSeconds !== host.retentionSeconds && (
        <p>Requested: {host.retentionOverrideSeconds} seconds; waiting for check-in.</p>
      )}
      {host.canManageLimits && host.state !== "revoked" ? (
        <form ref={preserve} action={action} className="space-y-2">
          <input type="hidden" name="org" value={orgId} />
          <input type="hidden" name="hostId" value={host.id} />
          <label htmlFor={`retention-${host.id}`}>
            Retention in seconds (0 removes stopped sandboxes on the next sweep)
          </label>
          <Input
            id={`retention-${host.id}`}
            name="retentionSeconds"
            type="number"
            min="0"
            max="31536000"
            step="1"
            required
            defaultValue={host.retentionOverrideSeconds ?? host.retentionSeconds ?? 86400}
          />
          <p className="text-xs text-muted-foreground">
            24 hours is 86400 seconds. Changes also adjust existing cleanup deadlines.
          </p>
          <Button type="submit" disabled={pending}>
            Save retention
          </Button>
          {state && <p role="status">{state.ok ? state.message : state.error}</p>}
        </form>
      ) : (
        <p className="text-muted-foreground">Only the member who added this server can change retention.</p>
      )}
    </div>
  );
}
