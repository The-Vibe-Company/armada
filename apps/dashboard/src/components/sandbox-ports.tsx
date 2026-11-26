"use client";

import { ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { type FormEvent, useState, useTransition } from "react";
import { mintRelayTicket } from "@/app/actions/sandboxes";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { COMMON_PREVIEW_PORTS, parseRelayPort, portForwardCommand, submitPreviewBootstrap } from "@/lib/relay-client";
import { cn } from "@/lib/utils";

export function SandboxPorts({ sandboxId }: { sandboxId: string }) {
  const [portInput, setPortInput] = useState("3000");
  const [feedback, setFeedback] = useState<{ kind: "error" | "status"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const parsed = parseRelayPort(portInput);
  const command = portForwardCommand(sandboxId, parsed.ok ? parsed.port : 3000);

  function openPreview(ev: FormEvent) {
    ev.preventDefault();
    const checked = parseRelayPort(portInput);
    if (!checked.ok) return setFeedback({ kind: "error", text: checked.error });
    setFeedback(null);
    startTransition(async () => {
      let minted: Awaited<ReturnType<typeof mintRelayTicket>>;
      try {
        minted = await mintRelayTicket(sandboxId, { mode: "preview", port: checked.port });
      } catch {
        return setFeedback({ kind: "error", text: "Could not reach the Armada server. Try again." });
      }
      if (!minted.ok) return setFeedback({ kind: "error", text: minted.error });
      if (!minted.ticket.bootstrapUrl)
        return setFeedback({ kind: "error", text: "The Armada server did not return a preview bootstrap URL." });
      if (!submitPreviewBootstrap(minted.ticket.bootstrapUrl, minted.ticket.ticket))
        return setFeedback({ kind: "error", text: "The preview address from the server was refused as unsafe." });
      setFeedback({ kind: "status", text: `Opening port ${checked.port} in a new tab…` });
    });
  }

  return (
    <section aria-label="Ports" className="space-y-2 text-xs">
      <h2 className="font-medium text-muted-foreground">Ports</h2>
      <fieldset className="flex flex-wrap gap-1.5 border-0 p-0" aria-label="Common ports">
        {COMMON_PREVIEW_PORTS.map((port) => (
          <button
            key={port}
            type="button"
            disabled={pending}
            onClick={() => {
              setPortInput(String(port));
              setFeedback(null);
            }}
            className={cn(
              "rounded-md border px-2 py-1 font-mono text-[11px] tabular-nums transition-[color,background-color,border-color,scale] duration-120 ease-(--ease-out) motion-safe:active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50",
              parsed.ok && parsed.port === port
                ? "border-foreground/25 bg-accent font-medium text-foreground"
                : "border-border bg-card text-muted-foreground fine-hover:bg-accent fine-hover:text-foreground",
            )}
          >
            :{port}
          </button>
        ))}
      </fieldset>
      <form onSubmit={openPreview} className="flex items-center gap-2">
        <Input
          name="port"
          inputMode="numeric"
          aria-label="Sandbox port number"
          placeholder="3000"
          value={portInput}
          onChange={(ev) => {
            setPortInput(ev.target.value);
            if (feedback) setFeedback(null);
          }}
          disabled={pending}
          className="h-8 min-w-0 font-mono text-xs tabular-nums"
        />
        <Button type="submit" variant="outline" size="sm" disabled={pending} className="shrink-0">
          {pending ? <Loader2Icon className="animate-spin" /> : <ExternalLinkIcon className="size-3.5" />}
          <span>{pending ? "Opening…" : "Open preview"}</span>
        </Button>
      </form>
      {feedback && (
        <p
          role={feedback.kind === "error" ? "alert" : "status"}
          className={feedback.kind === "error" ? "text-destructive" : "text-muted-foreground"}
        >
          {feedback.text}
        </p>
      )}
      <div className="flex items-center gap-1.5 rounded-md border bg-[var(--sunken)] px-2 py-1">
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={command}>
          {command}
        </code>
        <CopyButton value={command} label="Copy port-forward command" />
      </div>
    </section>
  );
}
