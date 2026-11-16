"use client";

import type { SandboxStatus } from "@armada/core";
import { PlayIcon, RotateCcwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition } from "react";
import { extendSandbox, sendToSandbox, steerSandbox } from "@/app/actions/sandboxes";
import { Button } from "@/components/ui/button";
import { type Attention, CONTINUE_PROMPT } from "@/lib/sandbox-attention";

/** The existing shortcuts; reply/steer, stop, PR/recovery links already live in this sandbox's conversation/header. */
type AttentionActionProps = {
  sandboxId: string;
  name: string;
  status: SandboxStatus;
  configured: boolean;
  busy: boolean;
  attention: Attention;
  resend: { text: string; conversationId: string | null } | null;
  ackKey: string;
  dismissed: boolean;
};

export function SandboxAttentionActions(props: AttentionActionProps) {
  // Reset both the request identity and its result when the recovery instruction changes.
  // Keep them stable across refreshes and uncertain retries of that same instruction.
  const identity = JSON.stringify([
    props.sandboxId,
    props.ackKey,
    props.attention,
    props.attention === "interrupted" ? props.resend?.text : CONTINUE_PROMPT,
    props.attention === "interrupted" ? props.resend?.conversationId : null,
  ]);
  return <RecoverySend key={identity} {...props} />;
}

function RecoverySend({ sandboxId, name, status, configured, busy, attention, resend }: AttentionActionProps) {
  const [state, action, pending] = useActionState(sendToSandbox, null);
  const [requestId] = useState(() => crypto.randomUUID());
  const canSend = configured && !busy && ["ready", "running", "stopped"].includes(status);
  const prompt = attention === "interrupted" ? resend?.text : attention === "unconcluded" ? CONTINUE_PROMPT : null;
  return (
    <div className="space-y-2">
      {state && (
        <p
          role={state.ok ? "status" : "alert"}
          className={state.ok ? "text-xs text-success" : "text-xs text-destructive"}
        >
          {state.ok ? state.message : state.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {canSend && prompt && (
          <form action={action}>
            <input type="hidden" name="send_key" value={requestId} />
            <input type="hidden" name="sandbox" value={sandboxId} />
            <input type="hidden" name="prompt" value={prompt} />
            {attention === "interrupted" && resend?.conversationId && (
              <input type="hidden" name="conversation" value={resend.conversationId} />
            )}
            <Button
              type="submit"
              size="sm"
              disabled={pending}
              aria-label={attention === "interrupted" ? `Resend the interrupted prompt to ${name}` : `Continue ${name}`}
            >
              {attention === "interrupted" ? (
                <>
                  <RotateCcwIcon /> Send it again
                </>
              ) : (
                <>
                  <PlayIcon /> Ask it to continue
                </>
              )}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

export function CopyRecoveryCommand({ command }: { command: string }) {
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <Button
        size="sm"
        variant="outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setResult("Copied");
          } catch {
            setResult("Copy failed. Allow clipboard access and try again.");
          }
        }}
      >
        Copy the command
      </Button>
      {result && (
        <p role="status" className="text-xs">
          {result}
        </p>
      )}
    </div>
  );
}

export function PushSandboxWork({ sandboxId, restarts }: { sandboxId: string; restarts: boolean }) {
  const [state, action, pending] = useActionState(steerSandbox, null);
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="sandbox" value={sandboxId} />
      <input
        type="hidden"
        name="prompt"
        value="Push your current work now so it is safely preserved before the sandbox deadline."
      />
      <Button size="sm" variant="outline" disabled={pending}>
        Tell it to push now
      </Button>
      {restarts && <p className="text-xs text-muted-foreground">This restarts the current turn.</p>}
      {state && (
        <p role={state.ok ? "status" : "alert"} className="text-xs">
          {state.ok ? state.message : state.error}
        </p>
      )}
    </form>
  );
}

export function AddSandboxTime({ sandboxId }: { sandboxId: string }) {
  const [state, action, pending] = useActionState(extendSandbox, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="sandbox" value={sandboxId} />
      <Button size="sm" variant="outline" disabled={pending}>
        {pending ? "Adding time…" : "Add time"}
      </Button>
      {state && (
        <p role={state.ok ? "status" : "alert"} className="text-xs">
          {state.ok ? state.message : state.error}
        </p>
      )}
    </form>
  );
}

/** Keep the old visible-page minute refresh: deadlines/attention can change without a machine-status transition. */
export function SandboxAttentionRefresh() {
  const router = useRouter();
  const [, startTransition] = useTransition();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") startTransition(() => router.refresh());
    }, 60_000);
    return () => clearInterval(timer);
  }, [router]);
  return null;
}
