"use client";

import { ORCHESTRATOR_DEFAULTS, type OrchestratorDetail } from "@armada/core";
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  CircleStopIcon,
  InfoIcon,
  Loader2Icon,
  PlayIcon,
  RadioIcon,
  WifiOffIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { type OrchestratorResult, orchestratorCommand } from "@/app/actions/orchestrators";
import { OrchestratorStateBadge } from "@/components/orchestrator-badge";
import { Transcript } from "@/components/sandbox-chat";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { projectChat, STEER_RESTARTS_TURN } from "@/lib/chat";
import type { OrchestratorFailure } from "@/lib/orchestrator-api";
import {
  type Attempt,
  activeWaits,
  agentEventsOf,
  attemptFor,
  CONTINUITY_LABELS,
  type Command,
  childrenOf,
  formatDuration,
  mergeFeed,
  type OrchestratorFeedEvent,
  orchestratorControls,
  parseOrchestratorDetail,
  timeUntil,
  troubledOperations,
  unsettledAfter,
} from "@/lib/orchestrators";
import { relativeAge } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

/** While something can change soon (a turn, a transition), the page reads every couple of seconds. */
const ACTIVE_MS = 2000;
/** At rest it still notices changes made elsewhere (the CLI, another tab, the idle stop). */
const QUIET_MS = 10_000;
/** After a lost connection, waits grow to this before trying again. */
const MAX_BACKOFF_MS = 30_000;

type Connection =
  | { state: "ok" }
  | { state: "reconnecting"; message: string }
  | { state: "stopped"; failure: OrchestratorFailure | "contract"; message: string };

type Facts = { golden: string; providerLabel: string; harnessLabel: string };

/**
 * An orchestrator as one persistent conversation: its messages and tool calls (the sandbox chat's own transcript),
 * a composer that messages or steers it, stop and resume, and quiet disclosures for its workers, waits and problems.
 * State comes only from the Armada server, polled by its opaque event cursor; every change carries the revision the
 * page last saw, so a stale page is refused and refreshed, never applied.
 */
export function OrchestratorChat({ initial, facts }: { initial: OrchestratorDetail; facts: Facts }) {
  const id = initial.orchestrator.id;
  const router = useRouter();
  const [detail, setDetail] = useState(initial);
  const [feed, setFeed] = useState<OrchestratorFeedEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [connection, setConnection] = useState<Connection>({ state: "ok" });
  const cursor = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reading = useRef(false);
  const mounted = useRef(true);
  const failures = useRef(0);
  const active = useRef(true);

  const read = useCallback(async (): Promise<number | null> => {
    const url = new URL(`/api/orchestrators/${encodeURIComponent(id)}/feed`, window.location.origin);
    if (cursor.current) url.searchParams.set("cursor", cursor.current);
    let body: Record<string, unknown>;
    let status: number;
    try {
      const response = await fetch(url, { cache: "no-store" });
      status = response.status;
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = { failure: "uncertain", error: "The dashboard lost contact with the server." };
      status = 0;
    }
    if (status !== 200) {
      const failure = typeof body.failure === "string" ? (body.failure as OrchestratorFailure) : "uncertain";
      const message = typeof body.error === "string" ? body.error : "The orchestrator could not be read.";
      if (failure === "uncertain") {
        failures.current += 1;
        setConnection({ state: "reconnecting", message });
        return Math.min(MAX_BACKOFF_MS, ACTIVE_MS * 2 ** failures.current);
      }
      // A definite answer (session expired, no longer visible, unsupported): stop polling and say why.
      setConnection({ state: "stopped", failure, message });
      return null;
    }
    try {
      // The detail is re-read against the contract; the events were already parsed by this dashboard's own route.
      const next = parseOrchestratorDetail(body.detail, id);
      const page = {
        events: Array.isArray(body.events) ? (body.events as OrchestratorFeedEvent[]) : [],
        cursor: typeof body.cursor === "string" ? body.cursor : null,
        hasMore: body.hasMore === true,
      };
      failures.current = 0;
      setConnection({ state: "ok" });
      setDetail(next);
      if (page.cursor) cursor.current = page.cursor;
      if (page.events.length > 0) setFeed((shown) => mergeFeed(shown, page.events));
      setHasMore(page.hasMore);
      setLoaded(true);
      const busy =
        page.hasMore ||
        ["creating", "stopping", "resuming"].includes(next.orchestrator.state) ||
        next.operations.some((operation) => operation.state === "pending") ||
        active.current;
      return page.hasMore ? 0 : busy ? ACTIVE_MS : QUIET_MS;
    } catch (error) {
      setConnection({
        state: "stopped",
        failure: "contract",
        message: error instanceof Error ? error.message : "Unexpected answer.",
      });
      return null;
    }
  }, [id]);

  /** Reads now, then again after the delay the answer asks for. One loop at a time; paused while the tab is hidden. */
  const tick = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    clearTimeout(timer.current);
    try {
      const delay = await read();
      if (!mounted.current || delay === null) return;
      if (document.visibilityState === "hidden" && delay > 0) return;
      timer.current = setTimeout(() => void tick(), delay);
    } finally {
      reading.current = false;
    }
  }, [read]);

  useEffect(() => {
    mounted.current = true;
    void tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [tick]);

  const chat = useMemo(() => projectChat(agentEventsOf(feed)), [feed]);
  active.current = chat.running;
  const controls = orchestratorControls(detail, chat.running);
  const { orchestrator } = detail;
  const live = connection.state === "ok" && orchestrator.state === "ready";

  const after = useCallback(() => {
    router.refresh();
    void tick();
  }, [router, tick]);

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-6">
      <Card
        data-testid="orchestrator-chat"
        className="flex h-[calc(100dvh-1.5rem)] min-h-[26rem] min-w-0 flex-col gap-0 overflow-hidden py-0 md:h-[calc(100dvh-8.25rem)]"
      >
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="text-base leading-none font-semibold">Conversation</h2>
            <span
              className="truncate text-xs text-muted-foreground"
              data-continuity={orchestrator.continuity}
              title="Whether the agent's own conversation is kept across stop and resume"
            >
              {CONTINUITY_LABELS[orchestrator.continuity]}
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            {live && (
              <span className="flex items-center gap-1 text-success" data-testid="live-indicator">
                <RadioIcon className="size-4 motion-safe:animate-pulse" /> Live
              </span>
            )}
            <OrchestratorStateBadge state={orchestrator.state} />
            <Lifecycle detail={detail} can={controls.can} pending={controls.pending} onDone={after} />
          </div>
        </div>

        <Notices connection={connection} notice={controls.notice} />

        <div className="flex min-h-0 flex-1 flex-col [&_[role=log]]:max-h-none [&_[role=log]]:min-h-0 [&_[role=log]]:flex-1 [&>div]:flex [&>div]:min-h-0 [&>div]:flex-1 [&>div]:flex-col">
          <Transcript
            items={chat.items}
            running={chat.running}
            loaded={loaded}
            poll={{ error: null, configured: true }}
            hasMore={hasMore}
            onMore={() => void tick()}
          />
        </div>

        <Composer
          detail={detail}
          running={chat.running}
          can={controls.can}
          note={controls.composerNote}
          onDone={after}
        />
      </Card>

      <Side detail={detail} feed={feed} facts={facts} />
    </div>
  );
}

function Notices({
  connection,
  notice,
}: {
  connection: Connection;
  notice: ReturnType<typeof orchestratorControls>["notice"];
}) {
  const pathname = usePathname();
  const items: ReactNode[] = [];
  if (connection.state === "reconnecting")
    items.push(
      <Alert key="connection" role="status" className="py-2">
        <WifiOffIcon />
        <AlertDescription>{connection.message} Reconnecting…</AlertDescription>
      </Alert>,
    );
  if (connection.state === "stopped")
    items.push(
      <Alert key="stopped" variant="destructive" role="alert" className="py-2">
        <AlertTriangleIcon />
        <AlertDescription>
          {connection.message}{" "}
          {connection.failure === "session" && (
            <Link
              href={`/login?next=${encodeURIComponent(pathname)}`}
              className="font-medium underline underline-offset-4"
            >
              Sign in
            </Link>
          )}
        </AlertDescription>
      </Alert>,
    );
  if (notice)
    items.push(
      <Alert
        key="notice"
        variant={notice.tone === "danger" ? "destructive" : "default"}
        className={cn("py-2", notice.tone === "warning" && "border-warning/40")}
        data-orchestrator-notice={notice.tone}
      >
        {notice.tone === "danger" ? <AlertTriangleIcon /> : <InfoIcon className="text-warning" />}
        <AlertTitle>{notice.title}</AlertTitle>
        <AlertDescription>{notice.text}</AlertDescription>
      </Alert>,
    );
  if (items.length === 0) return null;
  return <div className="shrink-0 space-y-2 border-b px-4 py-3 sm:px-6">{items}</div>;
}

function useCommand(detail: OrchestratorDetail, onDone: () => void) {
  const [result, setResult] = useState<OrchestratorResult | null>(null);
  const [pending, setPending] = useState<Command | null>(null);
  const [, startTransition] = useTransition();
  const unsettled = useRef<Attempt | null>(null);

  function run(command: Command, text = "", then?: (result: OrchestratorResult) => void) {
    if (pending) return;
    const attempt = attemptFor(unsettled.current, command, text, detail.orchestrator.revision, () =>
      crypto.randomUUID(),
    );
    const data = new FormData();
    data.set("orchestrator", detail.orchestrator.id);
    data.set("command", attempt.command);
    data.set("expected_revision", String(attempt.expectedRevision));
    data.set("idempotency_key", attempt.key);
    data.set("text", attempt.text);
    setPending(command);
    setResult(null);
    startTransition(async () => {
      let outcome: OrchestratorResult;
      try {
        outcome = await orchestratorCommand(null, data);
      } catch {
        outcome = {
          ok: false,
          error: "The dashboard could not confirm the request. Sending it again is safe.",
          failure: "uncertain",
        };
      }
      unsettled.current = unsettledAfter(attempt, outcome);
      setPending(null);
      setResult(outcome);
      then?.(outcome);
      // Read again whatever the answer: a stale page shows what changed before the person decides again, and an
      // unknown outcome shows whether it was applied.
      onDone();
    });
  }

  return { result, pending, run };
}

function Lifecycle({
  detail,
  can,
  pending,
  onDone,
}: {
  detail: OrchestratorDetail;
  can: ReturnType<typeof orchestratorControls>["can"];
  pending: ReturnType<typeof orchestratorControls>["pending"];
  onDone: () => void;
}) {
  const command = useCommand(detail, onDone);
  const busy = command.pending !== null;
  const children = detail.childSandboxIds.length;
  return (
    <>
      {can.resume && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => command.run("resume")}>
          {command.pending === "resume" ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
          Resume
        </Button>
      )}
      {(can.stop || pending === "stop") && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="ghost" disabled={busy || pending === "stop"}>
              {command.pending === "stop" || pending === "stop" ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <CircleStopIcon />
              )}
              Stop
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Stop this orchestrator?</AlertDialogTitle>
              <AlertDialogDescription>
                It stops taking messages and its machine stops. The conversation is kept, and Resume continues it.
                {children > 0 &&
                  ` Its ${children === 1 ? "worker keeps" : `${children} workers keep`} running: stop ${children === 1 ? "it" : "them"} from the workers list if needed.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => command.run("stop")}>Stop orchestrator</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {command.result && !command.result.ok && (
        <p role="alert" className="w-full text-right text-xs text-destructive">
          {command.result.error}
        </p>
      )}
    </>
  );
}

/** The next message. While a turn runs, Steer redirects it; Send queues a new turn. The draft stays until accepted. */
function Composer({
  detail,
  running,
  can,
  note,
  onDone,
}: {
  detail: OrchestratorDetail;
  running: boolean;
  can: ReturnType<typeof orchestratorControls>["can"];
  note: string | null;
  onDone: () => void;
}) {
  const fieldId = useId();
  const [draft, setDraft] = useState("");
  const command = useCommand(detail, onDone);
  const harness = detail.orchestrator.configuration.harness;
  const restarts = STEER_RESTARTS_TURN[harness];
  const primary: Command = can.steer ? "steer" : "message";

  function send(intent: Command) {
    const text = draft.trim();
    if (!text) return;
    command.run(intent, text, (result) => {
      if (result.ok) setDraft("");
    });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send(primary);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  const result = command.result;
  const enabled = can.message || can.steer;
  return (
    <form
      noValidate
      onSubmit={onSubmit}
      className="shrink-0 space-y-2 border-t bg-muted/30 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6"
      aria-label="Message the orchestrator"
    >
      <label htmlFor={`${fieldId}-message`} className="sr-only">
        Message
      </label>
      <Textarea
        id={`${fieldId}-message`}
        rows={2}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={!enabled}
        placeholder={
          !enabled
            ? (note ?? "")
            : running
              ? "Steer the running turn, or send the next one"
              : "What should it coordinate?"
        }
        className="max-h-48 min-h-16 resize-y bg-background"
      />
      <div className="flex flex-wrap items-center gap-2">
        {result ? (
          <p
            role={result.ok ? "status" : "alert"}
            className={cn("min-w-0 flex-1 text-xs", result.ok ? "text-muted-foreground" : "text-destructive")}
          >
            {result.ok ? result.message : result.error}
          </p>
        ) : (
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {enabled ? (
              <span className="hidden sm:inline">
                <kbd className="font-sans">Ctrl</kbd>+<kbd className="font-sans">Enter</kbd> to{" "}
                {primary === "steer" ? "steer" : "send"}
              </span>
            ) : (
              note
            )}
          </p>
        )}
        <div className="ml-auto flex items-center gap-2">
          {can.steer && (
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={command.pending !== null || !draft.trim()}
              title={restarts ? "Codex restarts the turn with your message." : "Joins the turn in progress."}
              onClick={() => send("steer")}
            >
              {command.pending === "steer" && <Loader2Icon className="animate-spin" />}
              {restarts ? "Steer (restarts turn)" : "Steer"}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant={primary === "message" ? "default" : "outline"}
            disabled={!can.message || command.pending !== null || !draft.trim()}
            onClick={() => send("message")}
          >
            {command.pending === "message" && <Loader2Icon className="animate-spin" />}
            {running ? "Send as next turn" : "Send"}
            {result && !result.ok && result.failure === "uncertain" ? " again" : ""}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** The quiet column: facts, workers, waits, problems and authority, each folded until opened. */
function Side({ detail, feed, facts }: { detail: OrchestratorDetail; feed: OrchestratorFeedEvent[]; facts: Facts }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const { orchestrator, delegation } = detail;
  const config = orchestrator.configuration;
  const children = childrenOf(detail, feed);
  const waits = activeWaits(detail);
  const problems = troubledOperations(detail);
  const technical = feed.filter((event) => event.kind !== "agent");
  const idleStop = orchestrator.idleDeadline ? timeUntil(orchestrator.idleDeadline, now) : null;
  const idle = formatDuration(config.idleSeconds ?? ORCHESTRATOR_DEFAULTS.idleSeconds);
  const rows: [string, string][] = [
    ["Agent", facts.harnessLabel],
    ["Model", `${config.model}${config.reasoningEffort ? ` · ${config.reasoningEffort}` : ""}`],
    ["Provider", facts.providerLabel],
    ["Golden", facts.golden],
    ...(config.repo ? [["Working directory", config.repo] as [string, string]] : []),
    ["Last activity", relativeAge(orchestrator.lastActivityAt, now) ?? "Unknown"],
    ["Idle stop", idleStop && orchestrator.state === "ready" ? idleStop : `after ${idle}`],
  ];
  return (
    <aside
      className="min-w-0 space-y-2 lg:max-h-[calc(100dvh-8.25rem)] lg:overflow-y-auto"
      aria-label="Orchestrator details"
    >
      <dl className="divide-y rounded-lg border px-4 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex min-w-0 items-baseline justify-between gap-3 py-2">
            <dt className="shrink-0 text-muted-foreground">{label}</dt>
            <dd className="min-w-0 truncate text-right font-medium" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <Fold title="Workers" count={children.length} empty="No workers launched yet.">
        <ul className="space-y-1">
          {children.map((child) => (
            <li key={child}>
              <Link
                href={`/sandboxes/${encodeURIComponent(child)}`}
                className="font-mono text-xs underline-offset-4 hover:underline"
              >
                {child.slice(0, 8)}
              </Link>
            </li>
          ))}
        </ul>
      </Fold>
      <Fold title="Waiting on" count={waits.length} empty="Nothing it is waiting on.">
        <ul className="space-y-2">
          {waits.map((wait) => (
            <li key={wait.id} className="text-xs" data-wait={wait.kind}>
              <p className="font-medium">
                {WAIT_LABELS[wait.kind]}: {wait.reason || wait.reference}
              </p>
              <p className="text-muted-foreground">
                Renews {timeUntil(wait.expiresAt, now) ?? "now"}, ends {timeUntil(wait.deadline, now) ?? "now"}
              </p>
            </li>
          ))}
        </ul>
      </Fold>
      <Fold
        title="Problems"
        count={problems.length}
        empty="No failed operations."
        tone={problems.length > 0 ? "danger" : undefined}
      >
        <ul className="space-y-1.5">
          {problems.map((operation) => (
            <li key={operation.id} className="text-xs" data-operation-state={operation.state}>
              <span className="font-medium capitalize">{operation.kind}</span>{" "}
              {operation.state === "uncertain"
                ? "outcome unknown: Armada is reconciling it and will not repeat it."
                : `failed${operation.errorCode ? ` (${operation.errorCode})` : ""}.`}
            </li>
          ))}
        </ul>
      </Fold>
      <Fold title="Authority" empty="No delegated authority.">
        {delegation && (
          <div className="space-y-1 text-xs">
            <p>
              {delegation.revokedAt
                ? "Revoked."
                : `Launches, reads, messages and stops its own workers only. Renews ${timeUntil(delegation.expiresAt, now) ?? "at the next turn"}.`}
            </p>
            <p className="text-muted-foreground">Configured by Armada; nothing to copy or paste.</p>
          </div>
        )}
      </Fold>
      {technical.length > 0 && (
        <Fold title="Technical events" count={technical.length} empty="">
          <ol className="max-h-60 space-y-1 overflow-y-auto font-mono text-[11px] text-muted-foreground">
            {technical.map((event) => (
              <li key={event.id}>
                r{event.revision} {event.kind === "unknown" ? event.type : event.kind}
                {event.kind === "state" ? ` ${event.state}/${event.continuity}` : ""}
                {event.kind === "operation" ? ` ${event.operation.kind} ${event.operation.state}` : ""}
              </li>
            ))}
          </ol>
        </Fold>
      )}
    </aside>
  );
}

const WAIT_LABELS = { ci: "CI", child: "Worker", external: "External", task: "Task" } as const;

function Fold({
  title,
  count,
  empty,
  tone,
  children,
}: {
  title: string;
  count?: number;
  empty: string;
  tone?: "danger" | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const none = count === 0 || (count === undefined && !children);
  return (
    <details
      className="group rounded-lg border px-4 py-2.5 text-sm"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        {title}
        {count !== undefined && (
          <span
            className={cn(
              "ml-auto text-xs text-muted-foreground tabular-nums",
              tone === "danger" && "text-destructive",
            )}
          >
            {count}
          </span>
        )}
      </summary>
      <div className="pt-2">{none ? <p className="text-xs text-muted-foreground">{empty}</p> : children}</div>
    </details>
  );
}
