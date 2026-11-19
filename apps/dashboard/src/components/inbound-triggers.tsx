"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { manageInboundTrigger, triggerDeliveries } from "@/app/actions/inbound-triggers";
import { CopyButton } from "@/components/copy-button";
import { useResourceSelected, visibleResourcePanelTitle } from "@/components/resource-browser";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type TriggerRef = { org: string; id: string };

export function TriggerPanel({ org, id, enabled }: TriggerRef & { enabled: boolean }) {
  const selected = useResourceSelected(id);
  if (!selected) return null;
  return (
    <>
      {enabled && (
        <div className="flex flex-wrap gap-2">
          <TriggerAction org={org} id={id} action="rotate" />
          <TriggerAction org={org} id={id} action="disable" />
        </div>
      )}
      <Deliveries org={org} id={id} />
    </>
  );
}

function TriggerAction({ org, id, action }: TriggerRef & { action: "rotate" | "disable" }) {
  const opener = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ signingSecret?: string; error?: string }>({});
  const [pending, startTransition] = useTransition();
  const rotate = action === "rotate";
  const label = rotate ? "Rotate signing key" : "Disable trigger";
  const secret = result.signingSecret;

  function close() {
    setResult({});
    setOpen(false);
  }

  function submit() {
    startTransition(async () => {
      try {
        const next = await manageInboundTrigger(org, id, action);
        if (next.error || next.signingSecret) setResult(next);
        else close();
      } catch {
        setResult({ error: "Could not confirm the change. Reload to check the trigger." });
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (next) setOpen(true);
        else close();
      }}
    >
      <DialogTrigger asChild>
        <Button ref={opener} size="sm" variant={rotate ? "outline" : "destructive-outline"}>
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          if (rotate || opener.current?.isConnected) return;
          event.preventDefault();
          visibleResourcePanelTitle()?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle tabIndex={-1} ref={secret ? (title) => title?.focus() : undefined}>
            {secret ? "New signing key" : label}
          </DialogTitle>
          <DialogDescription>
            {secret
              ? "Copy this key now. It is shown only once."
              : rotate
                ? "The current signing key will stop working immediately."
                : "Disabling blocks new deliveries."}
          </DialogDescription>
        </DialogHeader>
        {secret && (
          <div className="flex items-center gap-2">
            <code className="min-w-0 break-all rounded-md bg-muted p-2 text-sm">{secret}</code>
            <CopyButton value={secret} label="Copy signing key" />
          </div>
        )}
        {!pending && result.error && <p role="alert">{result.error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant={secret ? "default" : "outline"} disabled={pending} onClick={close}>
            {secret ? "Done" : "Cancel"}
          </Button>
          {!secret && (
            <Button variant={rotate ? "default" : "destructive"} disabled={pending} onClick={submit}>
              {pending ? "Working…" : label}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Deliveries({ org, id }: TriggerRef) {
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<Awaited<ReturnType<typeof triggerDeliveries>> | null>(null);
  const request = useMemo(() => ({ org, id, refresh }), [org, id, refresh]);
  useEffect(() => {
    let current = true;
    void triggerDeliveries(request.org, request.id).then(
      (response) => {
        if (current) setResult(response);
      },
      () => {
        if (current) setResult({ ok: false });
      },
    );
    return () => {
      current = false;
    };
  }, [request]);

  return (
    <section aria-label="Recent deliveries" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Recent deliveries</h3>
        <Button
          size="sm"
          variant="ghost"
          disabled={!result}
          onClick={() => {
            setResult(null);
            setRefresh((value) => value + 1);
          }}
        >
          Refresh
        </Button>
      </div>
      {!result ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading deliveries…
        </p>
      ) : !result.ok ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load deliveries. Try refreshing.
        </p>
      ) : result.deliveries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No deliveries received.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {result.deliveries.map(({ deliveryId, receivedAt, processingState }) => (
            <li key={deliveryId} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                <p className="break-all font-mono text-xs">{deliveryId}</p>
                <time dateTime={receivedAt} className="text-xs text-muted-foreground">
                  {new Date(receivedAt).toLocaleString()}
                </time>
              </div>
              <span className="text-xs">{processingState}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
