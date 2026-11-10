"use client";

import type { SandboxStatus } from "@armada/core";
import {
  CheckIcon,
  MessageSquareIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SendIcon,
  Undo2Icon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { acknowledgeFleetRow, restoreFleetRow } from "@/app/actions/fleet";
import { sendToSandbox } from "@/app/actions/sandboxes";
import { LinkPendingIcon } from "@/components/link-pending";
import { StopButton } from "@/components/sandbox-actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { type Attention, CONTINUE_PROMPT, preview } from "@/lib/fleet";

/** How often an open board reads the fleet again, while the tab is visible. */
const REFRESH_MS = 60_000;

/** Reads the board again now, and every minute while the page is in view. */
export function BoardRefresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") startTransition(() => router.refresh());
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [router]);
  return (
    <Button variant="outline" onClick={() => startTransition(() => router.refresh())} disabled={pending}>
      <RefreshCwIcon className={pending ? "animate-spin motion-reduce:animate-none" : undefined} />
      Refresh
    </Button>
  );
}

/** The latest agent message, its start first; the rest on demand. */
export function FleetRowMessage({ message, eventsRead }: { message: string | null; eventsRead: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!message)
    return (
      <p className="text-sm text-muted-foreground italic">
        {eventsRead ? "No agent message yet." : "The latest activity could not be read."}
      </p>
    );
  const short = preview(message);
  return (
    <div className="space-y-1">
      <p id={id} className="text-sm break-words whitespace-pre-wrap" data-latest-message>
        {open ? message : short.text}
      </p>
      {short.truncated && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

const CAN_STOP: readonly SandboxStatus[] = ["starting", "ready", "running"];
const CAN_SEND: readonly SandboxStatus[] = ["ready", "running", "stopped"];

/**
 * What the operator does about a row without leaving the board: resend an interrupted prompt, tell an agent that
 * finished without an outcome to continue, answer a blocked one, open the conversation, stop the machine, or
 * acknowledge the row so it leaves "Needs you". A running turn is steered from its conversation; the board only
 * opens new turns.
 */
export function FleetRowActions({
  sandboxId,
  name,
  status,
  configured,
  busy,
  attention,
  resend,
  ackKey,
  dismissed,
}: {
  sandboxId: string;
  name: string;
  status: SandboxStatus;
  configured: boolean;
  busy: boolean;
  attention: Attention | null;
  resend: { text: string; conversationId: string | null } | null;
  ackKey: string;
  dismissed: boolean;
}) {
  const [state, action, pending] = useActionState(sendToSandbox, null);
  const [prompt, setPrompt] = useState("");
  useEffect(() => {
    if (state?.ok) setPrompt("");
  }, [state]);
  const canSend = configured && !busy && CAN_SEND.includes(status);
  const reply = canSend && attention !== null && attention !== "ready" && attention !== "expiring";
  return (
    <div className="space-y-2">
      {reply && (
        <form action={action} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <input type="hidden" name="sandbox" value={sandboxId} />
          <Textarea
            name="prompt"
            rows={1}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={attention === "blocked" ? "Answer the agent" : "Send a follow-up prompt"}
            aria-label={`Follow-up prompt for ${name}`}
            className="min-h-9 flex-1"
            required
          />
          <Button type="submit" variant="secondary" disabled={pending || !prompt.trim()}>
            <SendIcon /> Send
          </Button>
        </form>
      )}
      {state && (
        <p
          role={state.ok ? "status" : "alert"}
          className={state.ok ? "text-xs text-success" : "text-xs text-destructive"}
        >
          {state.ok ? state.message : state.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {canSend && attention === "interrupted" && resend && (
          <form action={action}>
            <input type="hidden" name="sandbox" value={sandboxId} />
            <input type="hidden" name="prompt" value={resend.text} />
            {resend.conversationId && <input type="hidden" name="conversation" value={resend.conversationId} />}
            <Button type="submit" size="sm" disabled={pending} aria-label={`Resend the interrupted prompt to ${name}`}>
              <RotateCcwIcon /> Resend
            </Button>
          </form>
        )}
        {canSend && attention === "unconcluded" && (
          <form action={action}>
            <input type="hidden" name="sandbox" value={sandboxId} />
            <input type="hidden" name="prompt" value={CONTINUE_PROMPT} />
            <Button type="submit" size="sm" disabled={pending} aria-label={`Continue ${name}`}>
              <PlayIcon /> Continue
            </Button>
          </form>
        )}
        <Button variant="outline" size="sm" asChild>
          <Link href={`/sandboxes/${sandboxId}`} aria-label={`Open the conversation of ${name}`}>
            <LinkPendingIcon>
              <MessageSquareIcon />
            </LinkPendingIcon>
            Open conversation
          </Link>
        </Button>
        {configured && CAN_STOP.includes(status) && <StopButton sandboxId={sandboxId} size="sm" />}
        {attention !== null && (
          <form action={dismissed ? restoreFleetRow : acknowledgeFleetRow} className="ml-auto">
            <input type="hidden" name="key" value={ackKey} />
            <AckButton dismissed={dismissed} name={name} />
          </form>
        )}
      </div>
    </div>
  );
}

function AckButton({ dismissed, name }: { dismissed: boolean; name: string }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="ghost"
      size="sm"
      disabled={pending}
      aria-label={dismissed ? `Restore ${name} to Needs you` : `Dismiss ${name} from Needs you`}
    >
      {dismissed ? <Undo2Icon /> : <CheckIcon />}
      {dismissed ? "Restore" : "Dismiss"}
    </Button>
  );
}
