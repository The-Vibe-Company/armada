"use client";

import {
  type MachineSize,
  type OrchestratorDetail,
  type SandboxUsageSummary,
  summarizeSandboxUsage,
} from "@armada/core";
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
import { ProviderName } from "@/components/provider-mark";
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
import { PROVIDER_LABELS } from "@/lib/golden-form";
import { MACHINE_SIZE_LABELS } from "@/lib/machine-size";
import type { OrchestratorFailure } from "@/lib/orchestrator-api";
import {
  type Attempt,
  activeWaits,
  agentEventsOf,
  attemptFor,
  CONTINUITY_LABELS,
  type Command,
  childrenOf,
  configuredSize,
  formatDuration,
  mergeFeed,
  type OrchestratorFeedEvent,
  orchestratorControls,
  parseOrchestratorDetail,
  timeUntil,
  troubledOperations,
  unsettledAfterReread,
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

type Facts = { golden: string; harnessLabel: string };

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
  /** The detail as last read, for a command deciding after its own re-read. */
  const latest = useRef(initial);
  const [feed, setFeed] = useState<OrchestratorFeedEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [connection, setConnection] = useState<Connection>({ state: "ok" });
  const cursor = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reading = useRef(false);
  const again = useRef(false);
  const mounted = useRef(true);
  const failures = useRef(0);
  const active = useRef(true);
  /** Reads are numbered: an answer older than one already shown is dropped, never put back over newer state. */
  const issued = useRef(0);
  const shown = useRef(0);

  const read = useCallback(async (): Promise<number | null> => {
    const url = new URL(`/api/orchestrators/${encodeURIComponent(id)}/feed`, window.location.origin);
    if (cursor.current) url.searchParams.set("cursor", cursor.current);
    const number = ++issued.current;
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
    if (number < shown.current) return ACTIVE_MS;
    shown.current = number;
    if (status !== 200) {
      let failure: OrchestratorFailure = "uncertain";
      if (typeof body.failure === "string") failure = body.failure as OrchestratorFailure;
      // The dashboard's own session check answers 401 without a `failure`: that is an expired session too.
      else if (status === 401) failure = "session";
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
      latest.current = next;
      setDetail(next);
      // The detail is current even when the events could not be read: say so, and read them again with backoff.
      if (typeof body.eventsError === "string") {
        failures.current += 1;
        setConnection({ state: "reconnecting", message: body.eventsError });
        setLoaded(true);
        return Math.min(MAX_BACKOFF_MS, ACTIVE_MS * 2 ** failures.current);
      }
      // Only a full read (detail and events) resets the backoff.
      failures.current = 0;
      setConnection({ state: "ok" });
      if (page.cursor) cursor.current = page.cursor;
      if (page.events.length > 0) setFeed((shown) => mergeFeed(shown, page.events));
      setHasMore(page.hasMore);
      setLoaded(true);
      const busy =
        page.hasMore ||
        ["creating", "stopping", "resuming"].includes(next.orchestrator.state) ||
        next.operations.some((operation) => operation.state === "pending") ||
        active.current;
      if (page.hasMore) return 0;
      return busy ? ACTIVE_MS : QUIET_MS;
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
    // A read asked for during another (after a command) runs right after it, never dropped: its answer may predate
    // the command.
    if (reading.current) {
      again.current = true;
      return;
    }
    reading.current = true;
    again.current = false;
    clearTimeout(timer.current);
    let delay: number | null = null;
    try {
      delay = await read();
    } finally {
      reading.current = false;
    }
    if (!mounted.current || delay === null) return;
    if (again.current) delay = 0;
    if (document.visibilityState === "hidden" && delay > 0) return;
    timer.current = setTimeout(() => void tick(), delay);
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
  // Only a ready orchestrator runs a turn, whatever its last prompt event said before it stopped (as #666 for workers).
  const turnRunning = chat.running && detail.orchestrator.state === "ready";
  useEffect(() => {
    active.current = turnRunning;
  }, [turnRunning]);
  const controls = orchestratorControls(detail, turnRunning);
  const { orchestrator } = detail;
  const live = connection.state === "ok" && orchestrator.state === "ready";

  /** After a command: read now, outside the polling loop, so the next command carries what this one changed. */
  const after = useCallback(async () => {
    router.refresh();
    await read();
    // And the loop goes on (or starts again, after a stop such as an expired session the person has since renewed).
    void tick();
    return latest.current;
  }, [router, read, tick]);

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
          <div className="flex flex-wrap items-center justify-end gap-2 text-sm">
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
            running={turnRunning}
            loaded={loaded}
            poll={{ error: null, configured: connection.state !== "stopped" }}
            hasMore={hasMore}
            onMore={() => void tick()}
          />
        </div>

        <Composer
          detail={detail}
          running={turnRunning}
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

function useCommand(detail: OrchestratorDetail, onDone: () => Promise<OrchestratorDetail>) {
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
      setResult(outcome);
      then?.(outcome);
      // Read again whatever the answer, before taking the next command: a stale page shows what changed before the
      // person decides again, and an unknown outcome shows whether it was applied.
      const reread = await onDone().catch(() => null);
      unsettled.current = unsettledAfterReread(attempt, outcome, reread);
      setPending(null);
    });
  }

  /** Editing the draft starts a new request: the unknown one is no longer what the person would send. */
  const forget = () => {
    unsettled.current = null;
  };

  return { result, pending, run, forget };
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
  onDone: () => Promise<OrchestratorDetail>;
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
              <AlertDialogAction variant="destructive" onClick={() => command.run("stop")}>
                Stop orchestrator
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {command.result && !command.result.ok && (
        <p role="alert" className="basis-full text-right text-xs text-destructive">
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
  onDone: () => Promise<OrchestratorDetail>;
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
        maxLength={100_000}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          command.forget();
        }}
        onKeyDown={onKeyDown}
        disabled={!enabled}
        placeholder={placeholder(enabled, running, note)}
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

function UsageFacts({ title, usage }: { title: string; usage: SandboxUsageSummary | undefined }) {
  const rows: [string, number | null | undefined][] = [
    ["Compute seconds", usage?.computeSeconds],
    ["Turns", usage?.turnCount],
    ["Input tokens", usage?.inputTokens],
    ["Output tokens", usage?.outputTokens],
    ["Cached tokens", usage?.cachedTokens],
    ["Cache write tokens", usage?.cacheWriteTokens],
    ["Reasoning tokens", usage?.reasoningTokens],
  ];
  return (
    <div>
      <h3 className="mb-1 font-medium">{title}</h3>
      <dl className="space-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="tabular-nums">{value == null ? "Unknown" : value.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
    </div>
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
  // Only what the server reports: a live deadline, else the stored period. No client default stands in for either.
  const live = idleStop && orchestrator.state === "ready" ? idleStop : null;
  const idleFact = live ?? (config.idleSeconds === undefined ? null : `after ${formatDuration(config.idleSeconds)}`);
  const rows: [string, string][] = [
    ["Agent", facts.harnessLabel],
    ["Model", `${config.model}${config.reasoningEffort ? ` · ${config.reasoningEffort}` : ""}`],
    ["Provider", PROVIDER_LABELS[config.provider]],
    ["Golden", facts.golden],
    // Only a size the owner chose; otherwise the server resolved the repository's or golden's default, not shown here.
    [
      "Machine size",
      configuredSize(config) ? MACHINE_SIZE_LABELS[configuredSize(config) as MachineSize] : "Default (set at launch)",
    ],
    ...(config.repo ? [["Working directory", config.repo] as [string, string]] : []),
    ["Last activity", relativeAge(orchestrator.lastActivityAt, now) ?? "Unknown"],
    // Only a limit the owner chose explicitly: no provisional default is shown or implied.
    ...(config.maxActiveChildren === undefined
      ? []
      : [["Workers at once", `at most ${config.maxActiveChildren}`] as [string, string]]),
    ...(idleFact ? [["Idle stop", idleFact] as [string, string]] : []),
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
              {label === "Provider" ? <ProviderName provider={config.provider} /> : value}
            </dd>
          </div>
        ))}
      </dl>
      <section className="space-y-3 rounded-lg border p-4 text-xs" aria-label="Measured usage">
        <h2 className="text-sm font-medium">Measured usage</h2>
        <UsageFacts title="Own usage" usage={summarizeSandboxUsage(detail.usage?.own)} />
        <UsageFacts title="Child aggregate usage" usage={detail.usage?.children} />
        <p className="text-muted-foreground">
          Compute is Armada-observed elapsed time, not provider-billed seconds. Unknown means measurement is unavailable
          or incomplete. Token fields are reported separately, not a unique-token total: cached and cache-write tokens
          are included in Codex input, while Claude reports cache read/write separately from input. Reasoning is part of
          output.
        </p>
      </section>
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
              <p className="text-muted-foreground">{waitExpiry(wait.expiresAt, wait.deadline, now)}</p>
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
                : `Launches, reads, messages and stops its own workers only. ${grantEnd(timeUntil(delegation.expiresAt, now))} Armada replaces it between turns.`}
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

/** When the current delegated grant ends, or that it has: it is bounded and never renewed in place. */
function grantEnd(until: string | null): string {
  return until ? `This grant ends ${until}.` : "This grant has ended.";
}

/** A wait lasts until its expiry unless new evidence renews it, never past its deadline (#663). */
function waitExpiry(expiresAt: string, deadline: string, now: number): string {
  const expires = timeUntil(expiresAt, now);
  if (!expires) return "Expired.";
  const ends = timeUntil(deadline, now);
  return `Expires ${expires} unless renewed with new evidence${ends ? `; at the latest ${ends}` : ""}.`;
}

function placeholder(enabled: boolean, running: boolean, note: string | null): string {
  if (!enabled) return note ?? "";
  return running ? "Steer the running turn, or send the next one" : "What should it coordinate?";
}
