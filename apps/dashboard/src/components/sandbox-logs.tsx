"use client";

import type { AgentEvent, SandboxStatus } from "@armada/core";
import { AlertTriangleIcon, RadioIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { describeEvent, isActiveStatus, mergeEvents, parseEventPage } from "@/lib/events";
import { describeFailure } from "@/lib/failure";
import { cn } from "@/lib/utils";

const POLL_MS = 2000;

type Props = { sandboxId: string; initialStatus: SandboxStatus; live: boolean };

type Poll = { error: string | null; configured: boolean };

const TONES = {
  neutral: "text-muted-foreground",
  info: "text-foreground",
  success: "text-success",
  danger: "text-destructive",
} as const;

/** The events of a sandbox. While it is active the page asks again every couple of seconds, from the last cursor. */
export function SandboxLogs({ sandboxId, initialStatus, live }: Props) {
  const router = useRouter();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState(initialStatus);
  const [poll, setPoll] = useState<Poll>({ error: null, configured: true });
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const cursor = useRef<string | null>(null);
  const known = useRef(initialStatus);

  const read = useCallback(async (): Promise<{ more: boolean; active: boolean }> => {
    const url = new URL(`/api/sandboxes/${sandboxId}/events`, window.location.origin);
    if (cursor.current) url.searchParams.set("cursor", cursor.current);
    let body: Record<string, unknown>;
    try {
      const response = await fetch(url, { cache: "no-store" });
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      setPoll((current) => ({ ...current, error: "The dashboard lost contact with the server. Retrying…" }));
      return { more: false, active: true };
    }
    const next = typeof body.status === "string" ? (body.status as SandboxStatus) : known.current;
    if (next !== known.current) {
      known.current = next;
      setStatus(next);
      router.refresh();
    }
    const configured = body.configured !== false;
    setPoll({ error: typeof body.error === "string" ? body.error : null, configured });
    setLoaded(true);
    const page = parseEventPage(body);
    if (page.cursor) cursor.current = page.cursor;
    if (page.events.length > 0) setEvents((shown) => mergeEvents(shown, page.events));
    setHasMore(page.hasMore);
    return { more: page.hasMore, active: isActiveStatus(next) };
  }, [sandboxId, router]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const { more, active } = await read();
      if (cancelled) return;
      if (more) timer = setTimeout(tick, 0);
      else if (active) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [read]);

  const lines = events.map(describeEvent);
  const failures = lines.filter((line) => line.failure);
  const failure = failures.length > 0 ? failures[failures.length - 1] : undefined;
  const help = describeFailure(failure?.failure);

  return (
    <Card>
      <div className="flex items-center justify-between gap-3 px-6">
        <h2 className="text-base leading-none font-semibold">Logs</h2>
        <div className="flex items-center gap-3 text-sm">
          {live && isActiveStatus(status) && (
            <span className="flex items-center gap-1 text-success" data-testid="live-indicator">
              <RadioIcon className="size-4 animate-pulse" /> Live
            </span>
          )}
          <StatusBadge status={status} />
        </div>
      </div>
      <CardContent className="space-y-4">
        {status === "failed" && !help && (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>The sandbox failed</AlertTitle>
            <AlertDescription>{failure?.failure ?? "Look at the last events below for the reason."}</AlertDescription>
          </Alert>
        )}
        {help && (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>{help.title}</AlertTitle>
            <AlertDescription>
              {help.hint}{" "}
              {help.fix && (
                <Link href={help.fix.href} className="underline underline-offset-4">
                  {help.fix.label}
                </Link>
              )}
            </AlertDescription>
          </Alert>
        )}
        {poll.error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{poll.error}</AlertDescription>
          </Alert>
        )}
        {!poll.configured && (
          <Alert>
            <AlertDescription>Live logs need the Armada server, which is not configured here.</AlertDescription>
          </Alert>
        )}

        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {loaded && poll.configured && !poll.error ? "No events yet." : poll.configured ? "Loading…" : ""}
          </p>
        ) : (
          <ol className="space-y-3" aria-label="Events" aria-live="polite">
            {lines.map((line) => (
              <li key={line.id} className="rounded-md border p-3" data-event={line.id}>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className={cn("font-medium", TONES[line.tone])}>{line.label}</span>
                  <time className="text-muted-foreground" dateTime={new Date(line.at).toISOString()}>
                    {new Date(line.at).toISOString().slice(11, 19)} UTC
                  </time>
                </div>
                {line.text && <p className="mt-1 text-sm break-words whitespace-pre-wrap">{line.text}</p>}
                {line.failure && <p className="mt-1 text-xs text-destructive">Reason: {line.failure}</p>}
                {line.tools.length > 0 && (
                  <p className="mt-1 font-mono text-xs text-muted-foreground">Tools: {line.tools.join(", ")}</p>
                )}
              </li>
            ))}
          </ol>
        )}

        {hasMore && (
          <Button variant="outline" size="sm" onClick={() => void read()}>
            Load more
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
