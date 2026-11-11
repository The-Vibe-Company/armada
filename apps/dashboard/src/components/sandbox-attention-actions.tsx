"use client";

import type { SandboxStatus } from "@armada/core";
import { CheckIcon, PlayIcon, RotateCcwIcon, Undo2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { acknowledgeAttention, restoreAttention } from "@/app/actions/sandbox-attention";
import { sendToSandbox } from "@/app/actions/sandboxes";
import { Button } from "@/components/ui/button";
import { type Attention, CONTINUE_PROMPT } from "@/lib/sandbox-attention";

/** The existing shortcuts; reply/steer, stop, PR/recovery links already live in this sandbox's conversation/header. */
export function SandboxAttentionActions({
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
  attention: Attention;
  resend: { text: string; conversationId: string | null } | null;
  ackKey: string;
  dismissed: boolean;
}) {
  const [state, action, pending] = useActionState(sendToSandbox, null);
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
                  <RotateCcwIcon /> Resend
                </>
              ) : (
                <>
                  <PlayIcon /> Continue
                </>
              )}
            </Button>
          </form>
        )}
        <form action={dismissed ? restoreAttention : acknowledgeAttention}>
          <input type="hidden" name="key" value={ackKey} />
          <AcknowledgeButton dismissed={dismissed} />
        </form>
      </div>
    </div>
  );
}

function AcknowledgeButton({ dismissed }: { dismissed: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="ghost" size="sm" disabled={pending}>
      {dismissed ? <Undo2Icon /> : <CheckIcon />}
      {dismissed ? "Restore attention" : "Acknowledge"}
    </Button>
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
