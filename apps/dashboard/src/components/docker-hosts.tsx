"use client";

import { CircleCheckIcon, Loader2Icon, ServerIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import { dockerHostCheckedIn, registerDockerHost, revokeDockerHost } from "@/app/actions/docker-hosts";
import { ConfirmedAction } from "@/components/confirmed-action";
import { CopyButton } from "@/components/copy-button";
import { CreateDialog } from "@/components/create-dialog";
import { Button } from "@/components/ui/button";
import { revokeWarning } from "@/lib/docker-hosts";

/** How often the open dialog asks whether the new host has checked in; the daemon itself polls every 20 seconds. */
const CHECK_IN_POLL_MS = 5_000;
/** The registration ticket lasts five minutes; the dialog stops asking a little after that. */
const CHECK_IN_GIVE_UP_MS = 6 * 60_000;

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
 * The Hosts page's add flow: one button issues a one-use registration token, shown once in this dialog with the
 * command to run on the machine, then says when the host has checked in. Closing the dialog drops the token.
 */
export function AddHostDialog({ orgId }: { orgId: string }) {
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  // While a token is being issued or shown and the host has not checked in, only the close button closes the dialog.
  const [guarded, setGuarded] = useState(false);
  return (
    <CreateDialog
      dismissible={!guarded}
      label="Add host"
      title="Add a Docker host"
      description="Register a machine you own that runs Docker, so sandboxes can run on it."
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Every opening starts clean: a token from an earlier opening is never shown again.
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
  const issued = state?.ok === true;
  const checkedIn = useCallback(() => onGuard(false), [onGuard]);
  useEffect(() => {
    onGuard(pending || issued);
  }, [pending, issued, onGuard]);

  if (state?.ok)
    return (
      <Registration
        orgId={orgId}
        hostId={state.hostId}
        token={state.registrationToken}
        command={state.command}
        onCheckedIn={checkedIn}
      />
    );

  return (
    <form action={formAction} className="space-y-4" data-add-host-form>
      <input type="hidden" name="org" value={orgId} />
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>
          Install the <code className="font-mono text-foreground">armada-docker-host</code> binary on the machine first,
          on the PATH of an account with Docker access (see{" "}
          <code className="font-mono">docs/docker-host-daemon.md</code>
          in the Armada repository).
        </li>
        <li>Docker access is powerful: add only machines you own and trust.</li>
        <li>The next step shows a registration token once. It works once, for five minutes.</li>
      </ul>
      {state && !state.ok && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending && <Loader2Icon aria-hidden className="animate-spin" />}
          {pending ? "Creating token…" : "Create registration token"}
        </Button>
      </div>
    </form>
  );
}

function Registration({
  orgId,
  hostId,
  token,
  command,
  onCheckedIn,
}: {
  orgId: string;
  hostId: string;
  token: string;
  command: string;
  onCheckedIn: () => void;
}) {
  const router = useRouter();
  const [checkedIn, setCheckedIn] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  // The form and its button are gone: focus lands on the token, which is the one thing to act on now.
  useEffect(() => heading.current?.focus(), []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const ask = async () => {
      if (stopped) return;
      const answer = await dockerHostCheckedIn(orgId, hostId).catch(() => null);
      if (stopped) return;
      if (answer === true) {
        setCheckedIn(true);
        onCheckedIn();
        router.refresh();
        return;
      }
      if (Date.now() - started > CHECK_IN_GIVE_UP_MS) {
        setGaveUp(true);
        return;
      }
      timer = setTimeout(ask, CHECK_IN_POLL_MS);
    };
    timer = setTimeout(ask, CHECK_IN_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [orgId, hostId, router, onCheckedIn]);

  return (
    <div className="space-y-4" data-host-registration={hostId}>
      <section className="space-y-1.5">
        <h3 ref={heading} tabIndex={-1} className="text-sm font-medium outline-none">
          1. Copy the registration token
        </h3>
        <div className="flex items-center gap-1 rounded-md border bg-muted/50 px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-xs" data-registration-token>
            {token}
          </code>
          <CopyButton value={token} label="Copy registration token" />
        </div>
        <p className="text-xs text-muted-foreground">
          Shown only now. It works once, within five minutes; if it expires, close this dialog and add the host again.
        </p>
      </section>
      <section className="space-y-1.5">
        <h3 className="text-sm font-medium">2. Run this on the machine, then paste the token when asked</h3>
        <div className="flex items-start gap-1 rounded-md border bg-muted/50 px-3 py-2">
          <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-xs leading-5" data-registration-command>
            {command}
          </pre>
          <CopyButton value={command} label="Copy command" />
        </div>
        <p className="text-xs text-muted-foreground">
          In bash or zsh. The token is read without echo, never from the command line. The last line keeps the host
          running; use a service manager to keep it up after you log out.
        </p>
      </section>
      <p role="status" className="flex items-center gap-2 text-sm" data-host-checked-in={checkedIn ? "" : undefined}>
        <CheckInStatus checkedIn={checkedIn} gaveUp={gaveUp} />
      </p>
    </div>
  );
}

function CheckInStatus({ checkedIn, gaveUp }: { checkedIn: boolean; gaveUp: boolean }) {
  if (checkedIn)
    return (
      <>
        <CircleCheckIcon aria-hidden className="size-4 text-success" /> The host has checked in. You can close this
        dialog.
      </>
    );
  if (gaveUp)
    return (
      <span className="text-muted-foreground">
        The host has not checked in and this token has expired. If the command did not finish registering, revoke the
        waiting entry in the list and add the host again.
      </span>
    );
  return (
    <>
      <Loader2Icon aria-hidden className="size-4 animate-spin text-muted-foreground" />
      <span className="text-muted-foreground">Waiting for the host to check in…</span>
    </>
  );
}

/**
 * Revoke from a host's panel. The host's credential stops working at once, so it can no longer stop or delete what
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
