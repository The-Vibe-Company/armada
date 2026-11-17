"use client";

import { type Harness, idlePauseMessage, type SandboxStatus, sandboxControlRefusal } from "@armada/core";
import {
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  CircleStopIcon,
  Loader2Icon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { interruptSandbox, sendToSandbox, steerSandbox } from "@/app/actions/sandboxes";
import { Markdown } from "@/components/markdown";
import { SubmitShortcut } from "@/components/mod-key";
import { type ModelCatalog, ModelFields } from "@/components/model-fields";
import { StatusDot } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action";
import {
  type ChatItem,
  conversationsOf,
  eventsOf,
  projectChat,
  STEER_RESTARTS_TURN,
  type ToolActivity,
  toolSummary,
  toolText,
} from "@/lib/chat";
import {
  INCOMPLETE_MODEL,
  messageKeyFor,
  modelChange,
  PINNED_MODEL,
  SEND_KEY_FIELD,
  UNCONFIRMED_ACTION,
} from "@/lib/composer";
import { type ChatEvent, isActiveStatus, mergeEvents, parseEventPage } from "@/lib/events";
import { describeFailure } from "@/lib/failure";
import type { LaunchKey } from "@/lib/launch-key";
import { cn } from "@/lib/utils";

const POLL_MS = 2000;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 8000;
const MAX_RETRIES = 5;
/** Within this distance of the bottom the view follows new messages; further up it stays where the person is. */
const PINNED_PX = 48;
/** A stopped sandbox takes a message too: the server's `send` restores the same machine, disk and conversation. */
const LIVE: readonly SandboxStatus[] = ["starting", "ready", "running"];
const CAN_SEND = ["ready", "running", "stopped"] as const satisfies readonly SandboxStatus[];
/** Why the composer is closed, for every status that takes no message. */
const CLOSED_COMPOSER: Record<Exclude<SandboxStatus, (typeof CAN_SEND)[number]>, string> = {
  starting: "The sandbox is starting.",
  stopping: "The sandbox is stopping.",
  failed: "The sandbox failed: it takes no new messages.",
  deleted: "The sandbox was deleted: it takes no new messages.",
};

type Props = {
  sandboxId: string;
  initialStatus: SandboxStatus;
  provider?: string;
  preservationNote?: string | null;
  initialIdlePaused?: boolean;
  expiresAt?: string | null;
  initialUsageRevision: string;
  live: boolean;
  harness: Harness;
  catalog: ModelCatalog;
  launchedModel: string | null;
  /** Conversation ids Armada recorded for the sandbox, oldest first. */
  conversations: string[];
  /** The Armada server is configured: messages can be sent. */
  configured: boolean;
  /** Why this sandbox takes no messages from here whatever its status (a Docker sandbox, for now): shown instead. */
  composerUnavailable?: string | undefined;
  /**
   * A Docker sandbox: the model and effort stay as launched, and each message carries a request key that a retry of
   * the same message reuses, so the server never runs it twice (#1526).
   */
  pinnedModel?: boolean;
};

type Poll = {
  error: string | null;
  configured: boolean;
  retryAvailable: boolean;
  accessEnded: boolean;
};

type PollSession = {
  active: boolean;
  reading: boolean;
  paused: boolean;
  retries: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  controller: AbortController | null;
};

type ReadResult =
  | { kind: "success"; more: boolean; active: boolean }
  | { kind: "retryable"; message: string }
  | { kind: "access-ended"; message: string }
  | { kind: "aborted" };

const SANDBOX_STATUSES: readonly SandboxStatus[] = [
  "starting",
  "ready",
  "running",
  "stopping",
  "stopped",
  "failed",
  "deleted",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSandboxStatus(value: unknown): value is SandboxStatus {
  return typeof value === "string" && SANDBOX_STATUSES.includes(value as SandboxStatus);
}

/** A successful page has a stable outer shape; individual events remain lenient in parseEventPage. */
function isSuccessfulPage(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (!isSandboxStatus(value.status)) return false;
  if (value.usageRevision !== undefined && typeof value.usageRevision !== "string") return false;
  if (value.configured !== undefined && typeof value.configured !== "boolean") return false;
  if (!Array.isArray(value.events)) return false;
  if (value.cursor !== undefined && value.cursor !== null && typeof value.cursor !== "string") return false;
  if (typeof value.hasMore !== "boolean") return false;
  if ("error" in value) return false;
  return value.prompt === undefined || value.prompt === null || isRecord(value.prompt);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function accessEndedMessage(status: number): string {
  if (status === 401) return "Your session expired or is no longer valid. Sign in again, then retry.";
  if (status === 403) return "You no longer have access to this sandbox. Check your organization, then retry.";
  return "This sandbox is no longer available. Reload the page, then retry.";
}

/**
 * The sandbox as a conversation: the prompts, the agent's answers and its tool calls, read from the event stream
 * by cursor (every couple of seconds while the sandbox is active), with a composer for the next message.
 */
export function SandboxChat(props: Props) {
  const { sandboxId, initialStatus } = props;
  const router = useRouter();
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [status, setStatus] = useState(initialStatus);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [idlePaused, setIdlePaused] = useState(props.initialIdlePaused === true);
  const [poll, setPoll] = useState<Poll>({
    error: null,
    configured: true,
    retryAvailable: false,
    accessEnded: false,
  });
  const [hasMore, setHasMore] = useState(false);
  const [turnModel, setTurnModel] = useState<{
    rateLimit?: { waiting: boolean; message: string; retryCount: number; totalWaitMs: number } | null;
    state?: string;
    promptId?: string;
    conversationId?: string | null;
    requestedModel?: string | null;
    observedModel?: string | null;
    modelSelectionReason?: string | null;
    modelSelectionMessage?: string | null;
  } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const cursor = useRef<string | null>(null);
  const olderCursor = useRef<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const known = useRef(initialStatus);
  const rendered = useRef({ status: initialStatus, usage: props.initialUsageRevision });
  const refreshing = useRef(false);
  const [refreshPending, startRefresh] = useTransition();
  useLayoutEffect(() => {
    rendered.current = { status: initialStatus, usage: props.initialUsageRevision };
  }, [initialStatus, props.initialUsageRevision]);
  useLayoutEffect(() => {
    refreshing.current = refreshPending;
  }, [refreshPending]);
  const sessionRef = useRef<PollSession | null>(null);
  const isCurrent = useCallback((session: PollSession) => session.active && sessionRef.current === session, []);

  const applyMetadata = useCallback(
    (session: PollSession, body: Record<string, unknown>) => {
      if (!isCurrent(session)) return null;
      if (body.prompt !== undefined) setTurnModel(isRecord(body.prompt) ? body.prompt : null);
      setStatusMessage(typeof body.statusMessage === "string" ? body.statusMessage : null);
      setIdlePaused(body.statusMessage === "Paused — wakes on your next message");
      const next = isSandboxStatus(body.status) ? body.status : known.current;
      const statusChanged = next !== known.current;
      const usageChanged = typeof body.usageRevision === "string" && body.usageRevision !== rendered.current.usage;
      if (statusChanged) {
        known.current = next;
        setStatus(next);
      }
      // Only committed page props acknowledge the card's revision. A discarded or
      // stale RSC refresh must remain retryable on the next successful poll.
      const refreshNeeded = next !== rendered.current.status || usageChanged;
      if (!refreshing.current && refreshNeeded) {
        startRefresh(() => router.refresh());
      }
      const error = typeof body.error === "string" ? body.error : null;
      const configured = typeof body.configured === "boolean" ? body.configured : true;
      setPoll((current) =>
        current.error === error && current.configured === configured && !current.retryAvailable && !current.accessEnded
          ? current
          : { error, configured, retryAvailable: false, accessEnded: false },
      );
      return { next, refreshNeeded };
    },
    [isCurrent, router],
  );

  const read = useCallback(
    async (session: PollSession): Promise<ReadResult> => {
      const url = new URL(`/api/sandboxes/${sandboxId}/events`, window.location.origin);
      const cursorBefore = cursor.current;
      if (cursorBefore) url.searchParams.set("cursor", cursorBefore);
      const controller = new AbortController();
      session.controller = controller;
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!isCurrent(session)) return { kind: "aborted" };

        let body: unknown;
        try {
          body = await response.json();
        } catch (error) {
          if (isAbortError(error) || !isCurrent(session)) return { kind: "aborted" };
          if (response.status === 401 || response.status === 403 || response.status === 404) {
            return { kind: "access-ended", message: accessEndedMessage(response.status) };
          }
          return { kind: "retryable", message: "The server returned an unreadable conversation response." };
        }
        if (!isCurrent(session)) return { kind: "aborted" };

        if (!response.ok) {
          // The log lane can fail after the independent status read succeeded. Keep
          // any valid metadata from that response, but never consume its page/cursor.
          if (isRecord(body)) applyMetadata(session, body);
          if (response.status === 401 || response.status === 403 || response.status === 404) {
            return { kind: "access-ended", message: accessEndedMessage(response.status) };
          }
          const message =
            isRecord(body) && typeof body.error === "string"
              ? body.error
              : `The server returned HTTP ${response.status}.`;
          return { kind: "retryable", message };
        }
        if (!isSuccessfulPage(body)) {
          return { kind: "retryable", message: "The server returned an invalid conversation response." };
        }
        const metadata = applyMetadata(session, body);
        if (!metadata || !isCurrent(session)) return { kind: "aborted" };

        const page = parseEventPage(body);
        // A successful page must make progress before the continuation can run. The
        // route turns stalled upstream cursors into 502s, but keep the browser safe
        // if a proxy or an older server ever sends one directly.
        if (page.hasMore && (!page.cursor || page.cursor === cursorBefore)) {
          return { kind: "retryable", message: "The server returned a conversation page without a new cursor." };
        }
        const backward = body.backward === true;
        if (backward) {
          olderCursor.current = page.hasMore ? (page.olderCursor ?? null) : null;
          setHasMore(olderCursor.current !== null);
        }
        if (page.cursor) cursor.current = page.cursor;
        if (page.events.length > 0) setEvents((shown) => mergeEvents(shown, page.events));
        if (!backward && olderCursor.current === null) setHasMore(false);
        setLoaded(true);
        return {
          kind: "success",
          more: !backward && page.hasMore,
          active: isActiveStatus(metadata.next) || metadata.refreshNeeded,
        };
      } catch (error) {
        if (isAbortError(error) || !isCurrent(session)) return { kind: "aborted" };
        return { kind: "retryable", message: "The dashboard lost contact with the server." };
      } finally {
        if (session.controller === controller) session.controller = null;
      }
    },
    [applyMetadata, isCurrent, sandboxId],
  );

  const loadOlder = async () => {
    const boundary = olderCursor.current;
    const session = sessionRef.current;
    if (!boundary || loadingOlder || !session || !isCurrent(session)) return;
    setLoadingOlder(true);
    try {
      const url = new URL(`/api/sandboxes/${sandboxId}/events`, window.location.origin);
      url.searchParams.set("cursor", boundary);
      url.searchParams.set("direction", "backward");
      const response = await fetch(url, { cache: "no-store" });
      const body: unknown = await response.json();
      if (!isCurrent(session)) return;
      if (!response.ok || !isSuccessfulPage(body)) throw Error("Older messages could not be read.");
      const page = parseEventPage(body);
      if (page.hasMore && (!page.olderCursor || page.olderCursor === boundary))
        throw Error("Older messages did not advance.");
      setEvents((shown) => mergeEvents(page.events, shown));
      olderCursor.current = page.hasMore ? (page.olderCursor ?? null) : null;
      setHasMore(olderCursor.current !== null);
    } catch {
      if (isCurrent(session))
        setPoll((current) => ({ ...current, error: "Older messages could not be read. Try again." }));
    } finally {
      setLoadingOlder(false);
    }
  };

  /** Read until drained, inactive and rendered metadata is acknowledged. One loop at a time. */
  const tick = useCallback(
    async function pollTick() {
      const session = sessionRef.current;
      if (!session || !isCurrent(session) || session.reading || session.paused) return;
      session.reading = true;
      clearTimeout(session.timer);
      session.timer = undefined;
      try {
        const result = await read(session);
        if (!isCurrent(session)) return;
        if (result.kind === "aborted") return;
        if (result.kind === "success") {
          session.retries = 0;
          if (result.more) session.timer = setTimeout(() => void pollTick(), 0);
          else if (result.active) session.timer = setTimeout(() => void pollTick(), POLL_MS);
          return;
        }
        if (result.kind === "access-ended") {
          session.paused = true;
          setPoll((current) => ({
            ...current,
            error: result.message,
            retryAvailable: true,
            accessEnded: true,
          }));
          return;
        }
        if (session.retries >= MAX_RETRIES) {
          session.paused = true;
          setPoll((current) => ({
            ...current,
            error: `${result.message} Retry when the server is available.`,
            retryAvailable: true,
            accessEnded: false,
          }));
          return;
        }
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** session.retries);
        session.retries += 1;
        setPoll((current) => ({
          ...current,
          error: `${result.message} Retrying…`,
          retryAvailable: false,
          accessEnded: false,
        }));
        session.timer = setTimeout(() => void pollTick(), delay);
      } finally {
        session.reading = false;
      }
    },
    [isCurrent, read],
  );

  const retryPolling = useCallback(() => {
    const session = sessionRef.current;
    if (!session || !isCurrent(session)) return;
    session.paused = false;
    session.retries = 0;
    setPoll((current) => ({ ...current, error: null, retryAvailable: false, accessEnded: false }));
    void tick();
  }, [isCurrent, tick]);

  const resumePolling = useCallback(() => {
    const session = sessionRef.current;
    if (!session || !isCurrent(session)) return;
    session.paused = false;
    session.retries = 0;
    void tick();
  }, [isCurrent, tick]);

  // A server action such as Stop re-renders the page with the new status: show it in the same paint as the header,
  // not at the next poll, and read again when it says the sandbox is active (polling stops on an inactive status).
  useLayoutEffect(() => {
    setIdlePaused(props.initialIdlePaused === true);
    if (initialStatus === known.current) return;
    known.current = initialStatus;
    setStatus(initialStatus);
    if (isActiveStatus(initialStatus)) void tick();
  }, [initialStatus, tick, props.initialIdlePaused]);

  useEffect(() => {
    const session: PollSession = {
      active: true,
      reading: false,
      paused: false,
      retries: 0,
      timer: undefined,
      controller: null,
    };
    sessionRef.current = session;
    void tick();
    return () => {
      session.active = false;
      session.paused = true;
      clearTimeout(session.timer);
      session.controller?.abort();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [tick]);

  const conversations = useMemo(() => conversationsOf(events, props.conversations), [events, props.conversations]);
  const selected = chosen && conversations.includes(chosen) ? chosen : (conversations.at(-1) ?? null);
  const shownConversation = conversations.length > 1 ? selected : null;
  const chat = useMemo(() => projectChat(eventsOf(events, shownConversation)), [events, shownConversation]);
  // A stopped or failed machine runs no turn, whatever its last prompt event said before it stopped.
  const observedTurn = turnModel && (!selected || turnModel.conversationId === selected) ? turnModel : null;
  const turnRunning =
    (observedTurn?.state ? ["queued", "running"].includes(observedTurn.state) : chat.running) && LIVE.includes(status);
  const pauseMessage = idlePauseMessage({ status, idlePaused, expiresAt: props.expiresAt ?? null }, new Date());
  const failure = [...chat.items].reverse().find((item) => item.kind === "outcome" && item.status === "failed");
  const reason = failure?.kind === "outcome" ? failure.reason : undefined;

  return (
    <div data-fit="chat" className="space-y-2 sm:space-y-4">
      <Card data-fit="card" className="gap-0 overflow-hidden rounded-none border-0 bg-transparent py-0 shadow-none">
        {conversations.length > 1 && (
          <div className="px-4 py-3 sm:px-6">
            <ConversationPicker conversations={conversations} selected={selected} onChange={(id) => setChosen(id)} />
          </div>
        )}

        {status === "running" && statusMessage && (
          <p className="px-4 py-2 text-xs text-muted-foreground sm:px-6">{statusMessage}</p>
        )}
        {pauseMessage && (
          <p className="border-b px-4 py-2 text-xs text-muted-foreground sm:px-6" role="status">
            {pauseMessage}
          </p>
        )}

        {turnModel?.rateLimit && (
          <Alert role="status">
            <AlertTitle>{turnModel.rateLimit.message}</AlertTitle>
            <AlertDescription>
              Retry {turnModel.rateLimit.retryCount} · Total wait {Math.ceil(turnModel.rateLimit.totalWaitMs / 1000)} s
            </AlertDescription>
          </Alert>
        )}
        {turnModel?.observedModel && !turnModel.modelSelectionReason && (
          <p className="text-xs text-muted-foreground">Reported model: {turnModel.observedModel}</p>
        )}
        {turnModel?.modelSelectionReason && (
          <details className="border-b px-4 py-2 text-sm sm:px-6">
            <summary className="cursor-pointer text-muted-foreground">
              {turnModel.modelSelectionReason === "model_selection_mismatch"
                ? "The agent used a different model"
                : "The model could not be verified"}
            </summary>
            <div className="space-y-1 pt-2 text-muted-foreground">
              {turnModel.requestedModel && <p>Requested model: {turnModel.requestedModel}</p>}
              {turnModel.observedModel && <p>Reported model: {turnModel.observedModel}</p>}
              {turnModel.modelSelectionMessage && <p>{turnModel.modelSelectionMessage}</p>}
            </div>
          </details>
        )}
        <Notices status={status} reason={reason} poll={poll} onRetry={retryPolling} />

        <Transcript
          key={selected ?? "all"}
          items={chat.items}
          running={turnRunning}
          loaded={loaded}
          poll={poll}
          hasMore={hasMore}
          onMore={() => void loadOlder()}
        />

        <div id="sandbox-mobile-about" className="px-4 lg:hidden" />
        {props.configured &&
          (props.composerUnavailable ? (
            <p className="border-t px-4 py-3 text-sm text-muted-foreground sm:px-6" data-composer-unavailable>
              {props.composerUnavailable}
            </p>
          ) : (
            <Composer
              {...props}
              status={status}
              idlePaused={idlePaused}
              conversation={selected && props.conversations.includes(selected) ? selected : null}
              running={turnRunning}
              onDone={() => {
                router.refresh();
                resumePolling();
              }}
            />
          ))}
      </Card>

      <TechnicalEvents events={chat.technical} />
    </div>
  );
}

function ConversationPicker({
  conversations,
  selected,
  onChange,
}: {
  conversations: string[];
  selected: string | null;
  onChange: (id: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={id} className="sr-only">
        Conversation
      </Label>
      <NativeSelect
        id={id}
        value={selected ?? ""}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-auto text-xs"
      >
        {conversations.map((conversation, index) => (
          <option key={conversation} value={conversation}>
            {`Conversation ${index + 1}`}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

/** The sandbox-wide notices. A failed turn explains itself where it ended, in the conversation. */
function Notices({
  status,
  reason,
  poll,
  onRetry,
}: {
  status: SandboxStatus;
  reason: string | undefined;
  poll: Poll;
  onRetry: () => void;
}) {
  const notices = [
    status === "failed" && !reason && (
      <Alert key="failed" variant="destructive">
        <AlertTriangleIcon />
        <AlertTitle>The sandbox failed</AlertTitle>
        <AlertDescription>The last messages below may say why.</AlertDescription>
      </Alert>
    ),
    poll.error && (
      <Alert key="poll" variant="destructive" role="alert">
        <AlertDescription>
          <span>{poll.error}</span>
          {poll.retryAvailable && (
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          )}
        </AlertDescription>
      </Alert>
    ),
    !poll.configured && (
      <Alert key="configured">
        <AlertDescription>Live messages need the Armada server, which is not configured here.</AlertDescription>
      </Alert>
    ),
  ].filter(Boolean);
  if (notices.length === 0) return null;
  return <div className="space-y-3 border-b px-4 py-3 sm:px-6">{notices}</div>;
}

/**
 * The messages, oldest first. The view follows new messages only while it is at the bottom; scrolled up into the
 * history it stays put and offers a way back to the latest.
 */
export function Transcript({
  items,
  running,
  loaded,
  poll,
  hasMore,
  onMore,
}: {
  items: ChatItem[];
  running: boolean;
  loaded: boolean;
  poll: Poll;
  hasMore: boolean;
  onMore: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const last = items.at(-1);
  const signature = `${items.length}:${last?.key ?? ""}:${last?.kind === "assistant" ? last.text.length : ""}:${running}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the content changes, as told by its signature.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (pinned.current) element.scrollTop = element.scrollHeight;
    else setUnseen(true);
  }, [signature]);

  // The history's own height changes too (details, the model panel, the keyboard, the window): a pinned view stays on
  // the latest message, and an unpinned one updates whether it is at the bottom.
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) {
        element.scrollTop = element.scrollHeight;
        return;
      }
      // Grown back within reach of the bottom without a scroll: it follows new messages again, as a scroll would.
      const bottom = isAtBottom(element);
      pinned.current = bottom;
      setAtBottom(bottom);
      if (bottom) setUnseen(false);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function onScroll() {
    const element = scroller.current;
    if (!element) return;
    const bottom = isAtBottom(element);
    pinned.current = bottom;
    setAtBottom(bottom);
    if (bottom) setUnseen(false);
  }

  function jump() {
    const element = scroller.current;
    if (!element) return;
    pinned.current = true;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    setAtBottom(true);
    setUnseen(false);
  }

  const groups = groupTools(items);
  const streaming = last?.kind === "assistant" && last.streaming;
  // The log itself stays quiet (expanding a tool must not read its output aloud); finished messages are announced here.
  const announcement =
    last?.kind === "assistant" && !last.streaming
      ? `Agent: ${last.text.slice(0, 200)}`
      : last?.kind === "outcome"
        ? last.status === "failed"
          ? "The turn failed."
          : "The turn was interrupted."
        : "";

  return (
    <div data-fit="history" className="relative">
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <div
        ref={scroller}
        onScroll={onScroll}
        role="log"
        aria-label="Messages"
        aria-live="off"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the history scrolls on its own; the keyboard must reach it.
        tabIndex={0}
        data-fit="history-scroll"
        className="max-h-[min(68vh,46rem)] min-h-40 overflow-y-auto overscroll-contain px-4 py-5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-7"
      >
        {hasMore && (
          <div className="mb-4 flex justify-center">
            <Button variant="outline" size="sm" onClick={onMore}>
              Load older messages
            </Button>
          </div>
        )}
        {items.length === 0 ? (
          loaded || !poll.configured || poll.error ? (
            <p className="text-sm text-muted-foreground">
              {loaded && poll.configured && !poll.error ? "No messages yet." : ""}
            </p>
          ) : (
            // The shape of a conversation while it loads: nothing jumps when the messages arrive.
            <div className="mx-auto flex max-w-[780px] flex-col gap-[22px]" data-testid="history-loading">
              <span className="sr-only">Loading…</span>
              <Skeleton className="h-10 w-2/5 self-end rounded-2xl" />
              <div className="space-y-2">
                <Skeleton className="h-3.5 w-11/12" />
                <Skeleton className="h-3.5 w-4/5" />
                <Skeleton className="h-3.5 w-3/5" />
              </div>
              <Skeleton className="h-9 w-full rounded-lg" />
            </div>
          )
        ) : (
          <ol className="mx-auto flex max-w-[780px] flex-col gap-[22px]">
            {groups.map((group) =>
              group.kind === "tools" ? (
                <li key={group.key}>
                  <ToolGroup tools={group.tools} running={running} />
                </li>
              ) : (
                <li key={group.item.key} data-chat-item={group.item.kind}>
                  <ChatEntry item={group.item} />
                </li>
              ),
            )}
            {running && !streaming && (
              <li className="flex items-center gap-2.5 text-sm text-muted-foreground" data-testid="agent-working">
                <StatusDot tone="success" pulse className="mx-1" />
                Working
              </li>
            )}
          </ol>
        )}
      </div>
      {!atBottom && (
        <Button
          size="sm"
          variant="secondary"
          onClick={jump}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border shadow-lg animate-in fade-in-0 slide-in-from-bottom-1"
        >
          <ArrowDownIcon />
          {unseen ? "New messages" : "Jump to latest"}
        </Button>
      )}
    </div>
  );
}

function isAtBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= PINNED_PX;
}

type Group = { kind: "item"; item: ChatItem } | { kind: "tools"; key: string; tools: ToolActivity[] };

/** Tool calls that follow each other read as one block of activity. */
function groupTools(items: ChatItem[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    const previous = groups.at(-1);
    if (item.kind === "tool") {
      if (previous?.kind === "tools") previous.tools.push(item.tool);
      else groups.push({ kind: "tools", key: item.key, tools: [item.tool] });
    } else groups.push({ kind: "item", item });
  }
  return groups;
}

function ChatEntry({ item }: { item: ChatItem }) {
  const time = new Date(item.at);
  const title = Number.isFinite(item.at) ? `${time.toISOString().slice(0, 19).replace("T", " ")} UTC` : undefined;
  switch (item.kind) {
    case "user":
      return (
        <div className="flex flex-col items-end gap-1">
          <div
            className="max-w-[min(85%,36rem)] rounded-2xl border bg-muted px-3.5 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap"
            title={title}
          >
            {item.text || <span className="opacity-75">(empty prompt)</span>}
          </div>
          {item.status === "queued" && <span className="text-xs text-muted-foreground">Queued</span>}
        </div>
      );
    case "steer":
      return (
        <div className="flex flex-col items-end gap-1">
          <div
            className="max-w-[min(85%,36rem)] rounded-2xl border bg-muted px-3.5 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap"
            title={title}
          >
            {item.text}
          </div>
          <span className="text-xs text-muted-foreground">Steer{item.mode ? ` (${item.mode})` : ""}</span>
        </div>
      );
    case "assistant":
      return (
        <div title={title} data-streaming={item.streaming || undefined}>
          <Markdown text={item.text} />
          {item.streaming && (
            <span
              className="mt-1 inline-block h-4 w-1.5 rounded-sm bg-foreground/60 motion-safe:animate-pulse"
              aria-hidden="true"
            />
          )}
          {item.model && <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">{item.model}</p>}
        </div>
      );
    case "outcome":
      return <Outcome status={item.status} reason={item.reason} />;
    case "tool":
      return <ToolGroup tools={[item.tool]} running={false} />;
  }
}

function Outcome({ status, reason }: { status: "failed" | "interrupted"; reason: string | undefined }) {
  const help = describeFailure(reason);
  if (status === "interrupted") {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <CircleSlashIcon className="size-3.5" aria-hidden="true" /> {help?.hint ?? "Interrupted"}
      </p>
    );
  }
  return (
    <Alert role="note" variant="destructive" className="border-destructive/30 bg-destructive/5 px-3 py-2">
      <AlertTriangleIcon aria-hidden="true" />
      <AlertTitle className="line-clamp-none">{help?.title ?? "The turn failed"}</AlertTitle>
      <AlertDescription className="break-words">
        {(help?.hint ?? reason) && <p>{help?.hint ?? reason}</p>}
        {help?.fix && (
          <Link href={help.fix.href} className="font-medium underline underline-offset-4">
            {help.fix.label}
          </Link>
        )}
      </AlertDescription>
    </Alert>
  );
}

function ToolGroup({ tools, running }: { tools: ToolActivity[]; running: boolean }) {
  const complete = tools.every((tool) => tool.result);
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      open={!complete || open}
      onOpenChange={setOpen}
      className="overflow-hidden rounded-[10px] border bg-card"
    >
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-auto w-full justify-start gap-2 rounded-none px-3 py-2 text-[13px] text-muted-foreground"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 transition-transform", (!complete || open) && "rotate-90")}
          />
          <span className="font-medium text-foreground">{complete ? "Worked" : running ? "Working" : "Activity"}</span>
          <span>
            · {tools.length} {tools.length === 1 ? "step" : "steps"}
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="border-t" aria-label="Tool calls">
          {tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} running={running} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

const OUTPUT_LIMIT = 8000;

function ToolRow({ tool, running }: { tool: ToolActivity; running: boolean }) {
  const [open, setOpen] = useState(false);
  const summary = toolSummary(tool.input);
  const failed = tool.result?.isError === true;
  const edit =
    isRecord(tool.input) &&
    typeof tool.input.file_path === "string" &&
    typeof tool.input.old_string === "string" &&
    typeof tool.input.new_string === "string" &&
    tool.result &&
    !failed
      ? tool.input
      : null;
  const state = tool.result ? (failed ? "error" : "done") : running ? "running" : "unknown";
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <li data-tool={tool.name} data-tool-state={state}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full min-w-0 justify-start gap-2 rounded-none px-3 py-2 text-left text-xs motion-safe:active:not-disabled:scale-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-inset"
          >
            <ChevronRightIcon
              className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
              aria-hidden="true"
            />
            <ToolState state={state} />
            <span className="shrink-0 font-mono font-medium">{edit ? "Edited" : tool.name}</span>
            {summary && <span className="min-w-0 truncate font-mono text-muted-foreground">{summary}</span>}
            {edit && <span className="ml-auto shrink-0 text-muted-foreground">{open ? "Hide diff" : "View diff"}</span>}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 border-t bg-background/60 px-3 py-2">
          {open && (
            <>
              {edit && (
                <section
                  className="overflow-x-auto rounded-md border bg-muted/30 font-mono text-xs leading-relaxed"
                  aria-label={`Changes to ${edit.file_path}`}
                >
                  <p className="border-b px-3 py-2 font-medium">{String(edit.file_path)}</p>
                  <pre className="bg-destructive/10 px-3 text-destructive">
                    {String(edit.old_string)
                      .split("\n")
                      .map((line) => `− ${line}`)
                      .join("\n")}
                  </pre>
                  <pre className="bg-success/10 px-3 text-success">
                    {String(edit.new_string)
                      .split("\n")
                      .map((line) => `+ ${line}`)
                      .join("\n")}
                  </pre>
                </section>
              )}
              <ToolBlock label="Input" text={toolText(tool.input)} empty="No input recorded." />
              {tool.result ? (
                <ToolBlock
                  label={failed ? "Error" : "Result"}
                  text={toolText(tool.result.output)}
                  empty="No output."
                  danger={failed}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  {running ? "Waiting for the result." : "No result recorded."}
                </p>
              )}
            </>
          )}
        </CollapsibleContent>
      </li>
    </Collapsible>
  );
}

function ToolState({ state }: { state: "done" | "error" | "running" | "unknown" }) {
  switch (state) {
    case "done":
      return <CheckIcon className="size-3.5 shrink-0 text-success" aria-label="Done" />;
    case "error":
      return <XIcon className="size-3.5 shrink-0 text-destructive" aria-label="Failed" />;
    case "running":
      return (
        <Loader2Icon
          className="size-3.5 shrink-0 text-muted-foreground motion-safe:animate-spin"
          aria-label="Running"
        />
      );
    case "unknown":
      return <span className="size-3.5 shrink-0" aria-hidden="true" />;
  }
}

function ToolBlock({ label, text, empty, danger }: { label: string; text: string; empty: string; danger?: boolean }) {
  const [full, setFull] = useState(false);
  const long = text.length > OUTPUT_LIMIT;
  const shown = long && !full ? `${text.slice(0, OUTPUT_LIMIT)}\n…` : text;
  return (
    <div className="space-y-1">
      <p className={cn("text-[11px] font-medium text-muted-foreground", danger && "text-destructive")}>{label}</p>
      {text ? (
        <pre
          className={cn(
            "max-h-80 overflow-auto rounded-md border bg-muted/40 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words",
            danger && "border-destructive/30 bg-destructive/5",
          )}
        >
          {shown}
        </pre>
      ) : (
        <p className="text-xs text-muted-foreground">{empty}</p>
      )}
      {long && (
        <Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={() => setFull((value) => !value)}>
          {full ? "Show less" : `Show all ${text.length.toLocaleString("en")} characters`}
        </Button>
      )}
    </div>
  );
}

type Intent = "send" | "steer" | "interrupt";

/**
 * The next message. Send opens a new turn (with an optional model or effort for that turn); while a turn runs,
 * Steer redirects it and Interrupt stops it. The draft stays until the server accepts it.
 */
function Composer({
  sandboxId,
  harness,
  catalog,
  launchedModel,
  pinnedModel,
  status,
  conversation,
  running,
  onDone,
  idlePaused,
  provider,
  preservationNote,
  expiresAt,
}: Props & {
  status: SandboxStatus;
  conversation: string | null;
  running: boolean;
  idlePaused: boolean;
  onDone: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, setPending] = useState<Intent | null>(null);
  const [waking, setWaking] = useState(false);
  const [, startTransition] = useTransition();
  const [override, setOverride] = useState(false);
  /**
   * The Docker request key of the message not yet accepted: kept only while the same text is sent again unchanged, so
   * an edited, retyped or later identical message is never mistaken for a retry of an old one.
   */
  const sendKey = useRef<LaunchKey | null>(null);
  const fieldId = useId();
  const refusal = sandboxControlRefusal(
    {
      provider: provider ?? "boat",
      status,
      statusReason: idlePaused ? "idle_paused" : null,
      preservationNote: preservationNote ?? null,
      expiresAt: expiresAt ?? null,
    },
    new Date(),
  );
  const enabled = !refusal && (CAN_SEND as readonly SandboxStatus[]).includes(status);
  const restarts = STEER_RESTARTS_TURN[harness];
  /** The highlighted button, which Ctrl/Cmd+Enter presses: steering while a turn runs, unless the model changes. */
  const primary: Intent = running && !override ? "steer" : "send";
  /** Steer is unavailable because of a model change: say so, unless an error needs the space. */
  const steerHint = running && override && result?.ok !== false;

  function change(data: FormData) {
    const field = (name: string) => String(data.get(name) ?? "");
    return modelChange({
      model: field("model"),
      otherModel: field("other_model"),
      reasoningEffort: field("reasoning_effort"),
    });
  }

  function readOverride() {
    if (form.current && pending === null) setOverride(change(new FormData(form.current)) !== "none");
  }

  function run(intent: Intent) {
    if (!form.current || pending) return;
    const data = new FormData(form.current);
    if (intent !== "interrupt" && !draft.trim()) {
      setResult({ ok: false, error: "Write the message to send." });
      return;
    }
    if (intent === "send" && change(data) === "incomplete") {
      setResult({ ok: false, error: INCOMPLETE_MODEL });
      return;
    }
    if (intent === "send") {
      sendKey.current = messageKeyFor(sendKey.current, data);
      data.set(SEND_KEY_FIELD, sendKey.current.key);
    }
    const action = intent === "send" ? sendToSandbox : intent === "steer" ? steerSandbox : interruptSandbox;
    setWaking(intent === "send" && idlePaused);
    setPending(intent);
    setResult(null);
    startTransition(async () => {
      let outcome: ActionResult;
      try {
        outcome = await action(null, data);
      } catch {
        outcome = { ok: false, error: UNCONFIRMED_ACTION };
      }
      setPending(null);
      setWaking(false);
      setResult(outcome);
      if (!outcome.ok) return;
      sendKey.current = null;
      if (intent !== "interrupt") {
        // An accepted action owns only the draft it submitted, not text typed during its round trip.
        const submitted = String(data.get("prompt") ?? "");
        setDraft((current) => (current === submitted ? "" : current));
        form.current?.reset();
        setOverride(false);
      }
      onDone();
    });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    run(primary);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      form.current?.requestSubmit();
    }
  }

  if (!enabled) {
    return (
      <p className="border-t bg-muted/30 px-4 py-3 text-sm text-muted-foreground sm:px-6">
        {refusal ?? CLOSED_COMPOSER[status as Exclude<SandboxStatus, (typeof CAN_SEND)[number]>]}
      </p>
    );
  }

  return (
    <form
      ref={form}
      noValidate
      onSubmit={onSubmit}
      onChange={readOverride}
      className="mx-4 mb-[max(0.75rem,env(safe-area-inset-bottom))] space-y-2 rounded-2xl border border-border bg-card px-2.5 pt-2 pb-2 shadow-md sm:mx-7"
      aria-label="Message the agent"
    >
      <input type="hidden" name="sandbox" value={sandboxId} />
      <input type="hidden" name="conversation" value={conversation ?? ""} />
      <Label htmlFor={`${fieldId}-message`} className="sr-only">
        Message
      </Label>
      <Textarea
        id={`${fieldId}-message`}
        name="prompt"
        rows={2}
        value={draft}
        onChange={(event) => {
          sendKey.current = null;
          setDraft(event.target.value);
        }}
        onKeyDown={onKeyDown}
        placeholder={
          running
            ? "Steer the running turn…"
            : status === "stopped"
              ? "Send a prompt to resume this sandbox…"
              : "Send the next prompt…"
        }
        className="max-h-60 min-h-14 resize-y rounded-none border-0 bg-transparent px-1.5 py-1.5 shadow-none focus-visible:ring-0 sm:min-h-20 dark:bg-transparent"
      />
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          <span className="px-1 text-xs font-medium">
            {harness === "claude" ? "Claude Code" : harness === "codex" ? "Codex" : "OpenCode"}
          </span>
          {pinnedModel ? (
            <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground" title={PINNED_MODEL}>
              <SlidersHorizontalIcon className="size-3.5" aria-hidden />
              <span>Model as launched</span>
              <span className="sr-only">: {PINNED_MODEL}</span>
            </p>
          ) : (
            <fieldset disabled={pending !== null} className="min-w-0">
              <ModelFields
                compact
                idPrefix={`send-${sandboxId}`}
                harness={harness}
                catalog={catalog}
                keepLabel="As launched"
                launchedModel={launchedModel}
              />
            </fieldset>
          )}
          {steerHint ? (
            // Why Steer is unavailable, visible on a touch screen too (a title never shows there); one line, never a row.
            // It takes the place of an earlier success message, never of an error.
            <p
              id={`${fieldId}-steer-hint`}
              className="basis-full text-[11px] text-muted-foreground sm:min-w-0 sm:basis-auto sm:flex-1 sm:truncate sm:text-xs"
            >
              <span className="sr-only">Model change: </span>
              New turn only
            </p>
          ) : (
            result && (
              <p
                role={result.ok ? "status" : "alert"}
                className={cn(
                  "min-w-0 flex-1 text-xs",
                  result.ok ? "text-muted-foreground" : "order-first basis-full text-destructive",
                )}
              >
                {result.ok ? result.message : result.error}
              </p>
            )
          )}
          <div className="ml-auto flex flex-wrap items-center gap-1.5 sm:gap-2">
            {running && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="max-sm:px-2"
                disabled={pending !== null}
                onClick={() => run("interrupt")}
              >
                {pending === "interrupt" ? <Loader2Icon className="animate-spin" /> : <CircleStopIcon />}
                <span className="max-sm:sr-only">Interrupt</span>
              </Button>
            )}
            {running && (
              <Button
                aria-label={restarts ? "Steer (restarts turn)" : "Steer"}
                aria-describedby={steerHint ? `${fieldId}-steer-hint` : undefined}
                type="button"
                variant={primary === "steer" ? "default" : "outline"}
                size="sm"
                className="max-sm:px-2.5"
                disabled={pending !== null || override}
                title={
                  override
                    ? "A model or effort change needs a new turn."
                    : restarts
                      ? "Codex restarts the turn with your message."
                      : "Joins the turn in progress."
                }
                onClick={() => run("steer")}
              >
                {pending === "steer" && <Loader2Icon className="animate-spin" />}
                {restarts ? (
                  <>
                    <span className="max-sm:hidden">Steer (restarts turn)</span>
                    <span className="sm:hidden">Steer</span>
                  </>
                ) : (
                  "Steer"
                )}
                {primary === "steer" && <SubmitShortcut />}
              </Button>
            )}
            <Button
              aria-label={running ? "Send as new turn" : undefined}
              type="button"
              size="sm"
              className="max-sm:px-2.5"
              variant={primary === "send" ? "default" : "outline"}
              disabled={pending !== null}
              onClick={() => run("send")}
            >
              {pending === "send" && <Loader2Icon className="animate-spin" />}
              {waking ? "Waking the sandbox…" : null}
              {waking ? null : running ? (
                <>
                  <span className="max-sm:hidden">Send as new turn</span>
                  <span className="sm:hidden">New turn</span>
                </>
              ) : (
                "Send"
              )}
              {primary === "send" && <ArrowUpIcon className="size-3.5" aria-hidden />}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

function TechnicalEvents({ events }: { events: ChatEvent[] }) {
  const [open, setOpen] = useState(false);
  if (events.length === 0) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border text-sm">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-auto w-full justify-start rounded-lg px-4 py-2 sm:px-6 sm:py-3"
        >
          <ChevronRightIcon aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          Technical details · events ({events.length})
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {open && (
          <ol data-fit="technical-list" className="space-y-2 px-4 pt-1 pb-3 sm:px-6" aria-label="Technical events">
            {events.map((event) => (
              <li key={event.id} className="rounded-md border bg-muted/30 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-mono font-medium">{event.kind === "other" ? event.type : event.kind}</span>
                  <time className="text-muted-foreground" dateTime={new Date(event.at).toISOString()}>
                    {new Date(event.at).toISOString().slice(11, 19)} UTC
                  </time>
                </div>
                <pre className="mt-1 max-h-60 overflow-auto font-mono text-[11px] whitespace-pre-wrap break-words text-muted-foreground">
                  {toolText(event.kind === "other" ? event.data : event)}
                </pre>
              </li>
            ))}
          </ol>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
