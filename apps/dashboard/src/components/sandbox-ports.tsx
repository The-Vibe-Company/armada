"use client";

import type { SandboxStatus } from "@armada/core";
import { ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { type FormEvent, useRef, useState, useTransition } from "react";
import { mintRelayTicket } from "@/app/actions/sandboxes";
import { CopyButton } from "@/components/copy-button";
import { useThreadSandboxStatus } from "@/components/sandbox-thread-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  COMMON_PREVIEW_PORTS,
  isRelayActiveStatus,
  parsePreviewBootstrapUrl,
  parseRelayPort,
  portForwardCommand,
  submitPreviewBootstrap,
} from "@/lib/relay-client";
import { cn } from "@/lib/utils";

let previewWindowSeq = 0;

type PendingPreview = { port: number; bootstrapUrl: string; ticket: string };

export function SandboxPorts({ sandboxId, initialStatus }: { sandboxId: string; initialStatus?: SandboxStatus }) {
  const status = useThreadSandboxStatus(initialStatus ?? "ready");
  const [portInput, setPortInput] = useState("3000");
  const [feedback, setFeedback] = useState<{ kind: "error" | "status"; text: string } | null>(null);
  const [pendingPreview, setPendingPreview] = useState<PendingPreview | null>(null);
  const [pending, startTransition] = useTransition();
  const openingRef = useRef(false);
  if (initialStatus && !isRelayActiveStatus(status)) return null;
  const parsed = parseRelayPort(portInput);
  const command = portForwardCommand(sandboxId, parsed.ok ? parsed.port : 3000);

  function openPreview(ev: FormEvent) {
    ev.preventDefault();
    if (openingRef.current) return;
    const checked = parseRelayPort(portInput);
    if (!checked.ok) {
      setPendingPreview(null);
      return setFeedback({ kind: "error", text: checked.error });
    }
    openingRef.current = true;
    setFeedback(null);
    setPendingPreview(null);
    const targetName = `armada-preview-${sandboxId}-${checked.port}-${++previewWindowSeq}`;
    let popup: Window | null = null;
    try {
      popup = window.open("", targetName);
      if (popup) popup.opener = null;
    } catch {
      popup = null;
    }
    const closePopup = () => {
      try {
        if (popup && !popup.closed) popup.close();
      } catch {
        popup = null;
      }
    };
    startTransition(async () => {
      try {
        let minted: Awaited<ReturnType<typeof mintRelayTicket>>;
        try {
          minted = await mintRelayTicket(sandboxId, { mode: "preview", port: checked.port });
        } catch {
          closePopup();
          return setFeedback({ kind: "error", text: "Could not reach the Armada server. Try again." });
        }
        if (!minted.ok) {
          closePopup();
          return setFeedback({ kind: "error", text: minted.error });
        }
        if (!minted.ticket.bootstrapUrl) {
          closePopup();
          return setFeedback({ kind: "error", text: "The Armada server did not return a preview bootstrap URL." });
        }
        if (!parsePreviewBootstrapUrl(minted.ticket.bootstrapUrl, minted.ticket.ticket)) {
          closePopup();
          return setFeedback({ kind: "error", text: "The preview address from the server was refused as unsafe." });
        }
        if (popup && !popup.closed) {
          let submitted = false;
          try {
            submitted = submitPreviewBootstrap(minted.ticket.bootstrapUrl, minted.ticket.ticket, {
              target: targetName,
            });
          } catch {
            submitted = false;
          }
          if (!submitted) {
            closePopup();
            return setFeedback({ kind: "error", text: "The preview address from the server was refused as unsafe." });
          }
          return setFeedback({ kind: "status", text: `Opening port ${checked.port} in a new tab…` });
        }
        setPendingPreview({
          port: checked.port,
          bootstrapUrl: minted.ticket.bootstrapUrl,
          ticket: minted.ticket.ticket,
        });
        setFeedback({
          kind: "error",
          text: `Your browser blocked the preview tab for port ${checked.port}. Click below to open it.`,
        });
      } finally {
        openingRef.current = false;
      }
    });
  }

  function openBlockedPreview() {
    if (!pendingPreview) return;
    const { port, bootstrapUrl, ticket } = pendingPreview;
    setPendingPreview(null);
    if (!submitPreviewBootstrap(bootstrapUrl, ticket)) {
      return setFeedback({ kind: "error", text: "The preview address from the server was refused as unsafe." });
    }
    setFeedback({ kind: "status", text: `Opening port ${port} in a new tab…` });
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
              setPendingPreview(null);
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
            if (pendingPreview) setPendingPreview(null);
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
      {pendingPreview && (
        <Button type="button" variant="outline" size="sm" onClick={openBlockedPreview}>
          <ExternalLinkIcon className="size-3.5" />
          <span>Open port {pendingPreview.port} preview</span>
        </Button>
      )}
      <p className="text-[11px] leading-snug text-muted-foreground">
        Browser preview is path-prefixed; for root-relative apps (Vite, Next.js) on{" "}
        <code className="font-mono">localhost:{parsed.ok ? parsed.port : 3000}</code>, use{" "}
        <code className="font-mono">armada port-forward</code> below.
      </p>
      <div className="flex items-center gap-1.5 rounded-md border bg-[var(--sunken)] px-2 py-1">
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={command}>
          {command}
        </code>
        <CopyButton value={command} label="Copy port-forward command" />
      </div>
    </section>
  );
}
