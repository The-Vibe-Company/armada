"use client";

import { type Harness, idlePauseMessage, type SandboxStatus } from "@armada/core";
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
import {
  createContext,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
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
import { SandboxInspectorEvents, SandboxInspectorPhoneSlot } from "@/components/sandbox-details-panel";
import { SandboxState } from "@/components/sandbox-state";
import { StatusDot } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action";
import {
  type ChatItem,
  chatTurnRunning,
  formatElapsedSeconds,
  projectChat,
  STEER_RESTARTS_TURN,
  type ToolActivity,
  toolSummary,
  toolText,
  transcriptSignature,
} from "@/lib/chat";
import { type ChatTurnModel, deleteChatCache, getChatCache, setChatCache } from "@/lib/chat-cache";
import { type ChatStreamFrame, chatEventStream } from "@/lib/chat-event-stream";
import {
  failPendingMessage,
  hasActivePendingMessages,
  type PendingMessage,
  unconfirmedMessages,
} from "@/lib/chat-outbox";
import {
  composerAdmission,
  composerKeyAction,
  INCOMPLETE_MODEL,
  isDefiniteComposerRefusal,
  messageKeyFor,
  modelChange,
  PINNED_MODEL,
  SEND_KEY_FIELD,
  UNCONFIRMED_ACTION,
} from "@/lib/composer";
import {
  applyChatPage,
  applyInlineEvent,
  type ChatEvent,
  type ChatHistory,
  initialChatHistory,
  isActiveStatus,
  isSandboxStatus,
  isSuccessfulPage,
  parseEventPage,
} from "@/lib/events";
import { describeFailure } from "@/lib/failure";
import type { LaunchKey } from "@/lib/launch-key";
import { LIVE_FLEET_REFRESH_EVENT } from "@/lib/live-sandbox-view";
import { turnModelDisplay } from "@/lib/sandbox-model";
import { cn } from "@/lib/utils";

const WORKING_POLL_MS = 1_000;
const IDLE_POLL_MS = 3_000;
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
  orgId: string;
  sandboxId: string;
  initialStatus: SandboxStatus;
  provider?: string;
  preservationNote?: string | null;
  initialIdlePaused?: boolean;
  /** The persisted stop reason of `initialStatus`; ignored once a conversation read reports another status. */
  statusReason?: string | null;
  expiresAt?: string | null;
  live: boolean;
  harness: Harness;
  catalog: ModelCatalog;
  launchedModel: string | null;
  currentConversation?: string | undefined;
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
  synced: boolean;
  pendingCatchUp: boolean;
  bufferedFrames: ChatStreamFrame[];
  stream: ReturnType<typeof chatEventStream>;
  paused: boolean;
  retries: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  controller: AbortController | null;
  activeSandbox: boolean;
  working: boolean;
};

type ReadResult =
  | { kind: "success"; more: boolean; active: boolean; working: boolean }
  | { kind: "retryable"; message: string }
  | { kind: "access-ended"; message: string }
  | { kind: "aborted" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function accessEndedMessage(status: number): string {
  if (status === 401) return "Your session expired or is no longer valid. Sign in again, then retry.";
  if (status === 403) return "You no longer have access to this sandbox. Check your organization, then retry.";
  return "This sandbox is no longer available. Reload the page, then retry.";
}

type LiveThreadState = {
  status: SandboxStatus;
  idlePaused: boolean;
  statusMessage: string | null;
  hasLiveStatus: boolean;
  turnRunning: boolean;
};

const ThreadStateContext = createContext<{
  live: LiveThreadState | null;
  setLive: Dispatch<SetStateAction<LiveThreadState | null>>;
} | null>(null);

export function SandboxThreadStateProvider({ children }: { children: ReactNode }) {
  const [live, setLive] = useState<LiveThreadState | null>(null);
  const value = useMemo(() => ({ live, setLive }), [live]);
  return <ThreadStateContext.Provider value={value}>{children}</ThreadStateContext.Provider>;
}

export function ThreadSandboxState(props: Parameters<typeof SandboxState>[0]) {
  const live = useContext(ThreadStateContext)?.live ?? null;
  const status = live ? live.status : props.status;
  const statusMessage = live?.hasLiveStatus ? live.statusMessage : props.statusMessage;
  return (
    <span
      title={statusMessage ?? undefined}
      className="shrink-0 whitespace-nowrap rounded-full border px-1.5 py-0.5 [&>span]:gap-1 [&>span]:text-[11px]"
    >
      <SandboxState
        {...props}
        status={status}
        statusMessage={statusMessage}
        activityLabel={live?.turnRunning ? "Working" : undefined}
        idlePaused={live ? live.idlePaused : props.idlePaused}
      />
    </span>
  );
}

/**
 * The sandbox as a conversation: the prompts, the agent's answers and its tool calls, hydrated from the client LRU
 * cache and updated inline from SSE frames (with HTTP fallback polling only while SSE is disconnected).
 */
export function SandboxChat(props: Props) {
  const { orgId, sandboxId, initialStatus } = props;
  const setThreadState = useContext(ThreadStateContext)?.setLive;
  const pendingRuntimePrompt = useRef<string | undefined>(undefined);
  const [initialCache] = useState(() => getChatCache(orgId, sandboxId));
  const [outbox, setOutbox] = useState<PendingMessage[]>([]);
  const [history, setHistory] = useState<ChatHistory>(() => initialCache?.history ?? initialChatHistory);
  const currentHistory = useRef<ChatHistory>(initialCache?.history ?? initialChatHistory);
  const { events, loaded, olderCursor } = history;
  const [status, setStatus] = useState<SandboxStatus>(() => initialCache?.status ?? initialStatus);
  const [statusMessage, setStatusMessage] = useState<string | null>(() => initialCache?.statusMessage ?? null);
  const [hasLiveStatus, setHasLiveStatus] = useState(() => initialCache?.hasLiveStatus ?? false);
  const [idlePaused, setIdlePaused] = useState(() => initialCache?.idlePaused ?? props.initialIdlePaused === true);
  const [poll, setPoll] = useState<Poll>({
    error: null,
    configured: true,
    retryAvailable: false,
    accessEnded: false,
  });
  const [turnModel, setTurnModel] = useState<ChatTurnModel | null>(() => initialCache?.turnModel ?? null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const known = useRef<SandboxStatus>(initialCache?.status ?? initialStatus);
  const hasActiveOutboxRef = useRef(false);
  const sessionRef = useRef<PollSession | null>(null);
  const isCurrent = useCallback((session: PollSession) => session.active && sessionRef.current === session, []);

  const applyMetadata = useCallback(
    (session: PollSession, body: Record<string, unknown>) => {
      if (!isCurrent(session)) return null;
      const prompt = isRecord(body.prompt)
        ? (body.prompt as ChatTurnModel & { promptId?: unknown; reason?: unknown })
        : null;
      if (body.prompt !== undefined) setTurnModel(prompt);
      if (prompt?.state === "failed" && typeof prompt.promptId === "string") {
        const id = prompt.promptId;
        const reason = typeof prompt.reason === "string" ? prompt.reason : "The turn failed.";
        setOutbox((current) => failPendingMessage(current, id, reason));
      }
      setStatusMessage(typeof body.statusMessage === "string" ? body.statusMessage : null);
      setHasLiveStatus(true);
      setIdlePaused(body.statusMessage === "Paused — wakes on your next message");
      const next = isSandboxStatus(body.status) ? body.status : known.current;
      if (next !== known.current) {
        known.current = next;
        setStatus(next);
      }
      const error = typeof body.error === "string" ? body.error : null;
      const configured = typeof body.configured === "boolean" ? body.configured : true;
      setPoll((current) =>
        current.error === error && current.configured === configured && !current.retryAvailable && !current.accessEnded
          ? current
          : { error, configured, retryAvailable: false, accessEnded: false },
      );
      return { next };
    },
    [isCurrent],
  );

  const applyStreamFrame = useCallback(
    (session: PollSession, frame: ChatStreamFrame) => {
      if (!isCurrent(session)) return;
      if (frame.kind === "runtime_event") {
        const next = applyInlineEvent(currentHistory.current, sandboxId, frame.event, frame.sequence);
        if (next === currentHistory.current) return;
        currentHistory.current = next;
        setHistory(next);
        if (!frame.event) return;
        if (frame.event.kind === "prompt") {
          const promptEvent = frame.event;
          const ended =
            promptEvent.status === "finished" ||
            promptEvent.status === "failed" ||
            promptEvent.status === "interrupted";
          setTurnModel((current) => ({
            ...current,
            state: promptEvent.status,
            ...(promptEvent.conversationId ? { conversationId: promptEvent.conversationId } : {}),
            ...(ended ? { rateLimit: null } : {}),
          }));
          session.working =
            session.activeSandbox && (promptEvent.status === "queued" || promptEvent.status === "running");
          if (promptEvent.status === "failed" && promptEvent.promptId) {
            const id = promptEvent.promptId;
            const reason = promptEvent.reason ?? "The turn failed.";
            setOutbox((current) => failPendingMessage(current, id, reason));
          }
        }
        return;
      }
      if (frame.kind === "transition" && frame.status) {
        const nextStatus = frame.status;
        const nextIdlePaused = nextStatus === "stopped" && frame.statusReason === "idle_paused";
        const nextStatusMessage = idlePauseMessage(
          { status: nextStatus, statusReason: frame.statusReason ?? null, expiresAt: props.expiresAt ?? null },
          new Date(),
        );
        known.current = nextStatus;
        setStatus(nextStatus);
        setIdlePaused(nextIdlePaused);
        setStatusMessage(nextStatusMessage);
        setHasLiveStatus(true);
        session.activeSandbox = isActiveStatus(nextStatus);
        if (!session.activeSandbox) {
          session.working = false;
          if (nextStatus === "failed" || nextStatus === "deleted") {
            setTurnModel((current) => (current ? { ...current, state: nextStatus, rateLimit: null } : current));
          }
          if (!hasActiveOutboxRef.current) {
            session.stream.close();
            clearTimeout(session.timer);
            session.timer = undefined;
          }
        } else if (nextStatus === "running") {
          session.working = true;
        }
      }
    },
    [isCurrent, props.expiresAt, sandboxId],
  );

  const read = useCallback(
    async (session: PollSession): Promise<ReadResult> => {
      const { cursor: cursorBefore, loaded } = currentHistory.current;
      const path = loaded && cursorBefore ? "events" : "history";
      const url = new URL(`/api/sandboxes/${sandboxId}/${path}`, window.location.origin);
      if (cursorBefore) url.searchParams.set("cursor", cursorBefore);
      const oldestPending = pendingRuntimePrompt.current;
      if (oldestPending) url.searchParams.set("pending", oldestPending);
      const controller = new AbortController();
      session.controller = controller;
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!isCurrent(session) || controller.signal.aborted || document.hidden) return { kind: "aborted" };

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
        if (!isCurrent(session) || controller.signal.aborted || document.hidden) return { kind: "aborted" };

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
        const backward = body.backward === true;
        const next = applyChatPage(currentHistory.current, page, backward ? "latest" : "forward");
        if (!next) {
          return { kind: "retryable", message: "The server returned a conversation page without a new cursor." };
        }
        currentHistory.current = next;
        setHistory(next);
        return {
          kind: "success",
          more: !backward && page.hasMore,
          active: isActiveStatus(metadata.next),
          working:
            metadata.next === "running" ||
            (isRecord(body.prompt) && (body.prompt.state === "queued" || body.prompt.state === "running")),
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
    const boundary = currentHistory.current.olderCursor;
    const session = sessionRef.current;
    if (!boundary || loadingOlder || !session || !isCurrent(session)) return;
    setLoadingOlder(true);
    try {
      const url = new URL(`/api/sandboxes/${sandboxId}/history`, window.location.origin);
      url.searchParams.set("cursor", boundary);
      const response = await fetch(url, { cache: "no-store" });
      const body: unknown = await response.json();
      if (!isCurrent(session)) return;
      if (!response.ok || !isSuccessfulPage(body)) throw Error("Older messages could not be read.");
      const page = parseEventPage(body);
      const next = applyChatPage(currentHistory.current, page, "older");
      if (!next) throw Error("Older messages did not advance.");
      currentHistory.current = next;
      setHistory(next);
    } catch {
      if (isCurrent(session))
        setPoll((current) => ({ ...current, error: "Older messages could not be read. Try again." }));
    } finally {
      setLoadingOlder(false);
    }
  };

  /** Serialize HTTP reads (initial sync + fallback polling only while SSE is disconnected). */
  const tick = useCallback(
    async function readUpdate() {
      const session = sessionRef.current;
      if (!session || !isCurrent(session) || session.paused || document.hidden) return;
      if (session.reading) return;
      session.reading = true;
      session.pendingCatchUp = false;
      clearTimeout(session.timer);
      session.timer = undefined;
      try {
        const result = await read(session);
        if (!isCurrent(session) || document.hidden) return;
        if (result.kind === "aborted") {
          if (session.synced && session.bufferedFrames.length > 0) {
            for (const frame of session.bufferedFrames.splice(0)) applyStreamFrame(session, frame);
          }
          if (session.pendingCatchUp) session.timer = setTimeout(() => void readUpdate(), 0);
          return;
        }
        if (result.kind === "success") {
          session.retries = 0;
          session.activeSandbox = result.active;
          session.working = result.working;
          if (!result.more) {
            session.synced = true;
            if (session.bufferedFrames.length > 0) {
              const frames = session.bufferedFrames.splice(0);
              for (const frame of frames) applyStreamFrame(session, frame);
            }
          }
          const keepAlive = session.activeSandbox || session.working || hasActiveOutboxRef.current;
          if (!keepAlive) session.stream.close();
          else if (props.configured) session.stream.connect();
          if (result.more || session.pendingCatchUp) {
            session.timer = setTimeout(() => void readUpdate(), 0);
          } else if (pendingRuntimePrompt.current || (!session.stream.connected && keepAlive)) {
            session.timer = setTimeout(
              () => void readUpdate(),
              session.working || hasActiveOutboxRef.current ? WORKING_POLL_MS : IDLE_POLL_MS,
            );
          }
          return;
        }
        if (session.synced && session.bufferedFrames.length > 0) {
          for (const frame of session.bufferedFrames.splice(0)) applyStreamFrame(session, frame);
        }
        if (result.kind === "access-ended") {
          session.paused = true;
          session.stream.close();
          deleteChatCache(orgId, sandboxId);
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
          session.stream.close();
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
        session.timer = setTimeout(() => void readUpdate(), delay);
      } finally {
        session.reading = false;
      }
    },
    [applyStreamFrame, isCurrent, orgId, props.configured, read, sandboxId],
  );

  const retryPolling = useCallback(() => {
    const session = sessionRef.current;
    if (!session || !isCurrent(session)) return;
    session.paused = false;
    session.retries = 0;
    setPoll((current) => ({ ...current, error: null, retryAvailable: false, accessEnded: false }));
    if (props.configured && (isActiveStatus(known.current) || hasActiveOutboxRef.current)) {
      session.stream.connect();
    }
    void tick();
  }, [isCurrent, props.configured, tick]);

  const resumePolling = useCallback(() => {
    const session = sessionRef.current;
    if (!session || !isCurrent(session)) return;
    session.paused = false;
    session.retries = 0;
    if (props.configured) session.stream.connect();
    if (!session.stream.connected) void tick();
  }, [isCurrent, props.configured, tick]);

  // A server action such as Stop re-renders the page with the new status: show it in the same paint as the header,
  // close the stream when the sandbox becomes inactive, and read the latest conversation.
  const previousProps = useRef({ status: initialStatus, idlePaused: props.initialIdlePaused === true });
  useLayoutEffect(() => {
    const nextPropIdlePaused = props.initialIdlePaused === true;
    if (previousProps.current.status === initialStatus && previousProps.current.idlePaused === nextPropIdlePaused) {
      return;
    }
    previousProps.current = { status: initialStatus, idlePaused: nextPropIdlePaused };
    setIdlePaused(nextPropIdlePaused);
    if (initialStatus === known.current) return;
    known.current = initialStatus;
    setStatus(initialStatus);
    if (!isActiveStatus(initialStatus)) sessionRef.current?.stream.close();
    void tick();
  }, [initialStatus, tick, props.initialIdlePaused]);

  useEffect(() => {
    const session: PollSession = {
      active: true,
      reading: false,
      synced: false,
      pendingCatchUp: false,
      bufferedFrames: [],
      stream: chatEventStream(sandboxId, {
        onOpen: ({ fromTail }) => {
          if (!isCurrent(session) || session.paused || document.hidden) return;
          if (!pendingRuntimePrompt.current) {
            clearTimeout(session.timer);
            session.timer = undefined;
          }
          if (fromTail && session.synced) {
            if (session.reading) session.pendingCatchUp = true;
            else void tick();
          }
        },
        onFrame: (frame) => {
          if (!isCurrent(session) || session.paused || document.hidden) return;
          if (!session.synced || session.reading) {
            session.bufferedFrames.push(frame);
            return;
          }
          applyStreamFrame(session, frame);
        },
        onDisconnect: () => {
          if (!isCurrent(session) || session.paused || document.hidden || session.reading || session.timer) return;
          if (session.activeSandbox || session.working || pendingRuntimePrompt.current || hasActiveOutboxRef.current) {
            session.timer = setTimeout(
              () => void tick(),
              session.working || hasActiveOutboxRef.current ? WORKING_POLL_MS : IDLE_POLL_MS,
            );
          }
        },
      }),
      paused: false,
      retries: 0,
      timer: undefined,
      controller: null,
      activeSandbox: isActiveStatus(known.current),
      working: known.current === "running",
    };
    sessionRef.current = session;
    function visibilityChanged() {
      if (document.hidden) {
        clearTimeout(session.timer);
        session.timer = undefined;
        session.controller?.abort();
        session.stream.close();
      } else {
        session.synced = false;
        session.bufferedFrames = [];
        if (props.configured && (isActiveStatus(known.current) || hasActiveOutboxRef.current)) {
          session.stream.connect();
        }
        void tick();
      }
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    if (props.configured && (isActiveStatus(known.current) || hasActiveOutboxRef.current)) {
      session.stream.connect();
    }
    void tick();
    return () => {
      document.removeEventListener("visibilitychange", visibilityChanged);
      session.active = false;
      session.paused = true;
      clearTimeout(session.timer);
      session.stream.close();
      session.controller?.abort();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [applyStreamFrame, isCurrent, props.configured, sandboxId, tick]);

  useEffect(() => {
    if (!history.loaded || poll.accessEnded) return;
    setChatCache(orgId, sandboxId, {
      history,
      status,
      statusMessage,
      hasLiveStatus,
      idlePaused,
      turnModel,
      updatedAt: Date.now(),
    });
  }, [hasLiveStatus, history, idlePaused, orgId, poll.accessEnded, sandboxId, status, statusMessage, turnModel]);

  const { currentConversation } = props;
  const chat = useMemo(() => projectChat(events, currentConversation), [events, currentConversation]);
  const chatItemsRef = useRef(chat.items);
  chatItemsRef.current = chat.items;
  const unconfirmed = useMemo(() => unconfirmedMessages(outbox, chat.items), [outbox, chat.items]);
  const hasActiveOutbox = useMemo(() => hasActivePendingMessages(unconfirmed), [unconfirmed]);
  hasActiveOutboxRef.current = hasActiveOutbox;
  useLayoutEffect(() => {
    const oldest = props.pinnedModel
      ? unconfirmed.find((message) => message.kind !== "steer" && message.accepted && !message.failure)?.requestId
      : undefined;
    const previous = pendingRuntimePrompt.current;
    pendingRuntimePrompt.current = oldest;
    if (oldest && oldest !== previous) void tick();
  }, [props.pinnedModel, tick, unconfirmed]);
  useEffect(() => {
    if (unconfirmed.length === outbox.length) return;
    const retained = outbox.filter((message) => !message.accepted || unconfirmed.includes(message));
    if (retained.length !== outbox.length) setOutbox((current) => (current === outbox ? retained : current));
  }, [outbox, unconfirmed]);

  // A stopped or failed machine runs no live steer/interrupt turn; queued wake or active outbox marks Working immediately.
  const turnRunning = LIVE.includes(status) && chatTurnRunning(turnModel, currentConversation, chat.running);
  const working = turnRunning || hasActiveOutbox || (status === "stopped" && turnModel?.state === "queued");
  const previousWorking = useRef<boolean | null>(null);
  useEffect(() => {
    if (setThreadState) {
      setThreadState((current) =>
        current &&
        current.status === status &&
        current.idlePaused === idlePaused &&
        current.statusMessage === statusMessage &&
        current.hasLiveStatus === hasLiveStatus &&
        current.turnRunning === working
          ? current
          : { status, idlePaused, statusMessage, hasLiveStatus, turnRunning: working },
      );
    }
    if (previousWorking.current !== null && previousWorking.current !== working && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(LIVE_FLEET_REFRESH_EVENT));
    }
    if (loaded || working) previousWorking.current = working;
  }, [hasLiveStatus, loaded, setThreadState, status, idlePaused, statusMessage, working]);
  useEffect(() => () => setThreadState?.(null), [setThreadState]);
  const pauseMessage = idlePauseMessage({ status, idlePaused, expiresAt: props.expiresAt ?? null }, new Date());
  const failure = [...chat.items].reverse().find((item) => item.kind === "outcome" && item.status === "failed");
  const reason = failure?.kind === "outcome" ? failure.reason : undefined;
  const modelNotice = turnModelDisplay(turnModel);

  return (
    <div data-fit="chat" className="space-y-2 sm:space-y-4">
      <Card data-fit="card" className="gap-0 overflow-hidden rounded-none border-0 bg-transparent py-0 shadow-none">
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
        {modelNotice?.kind === "model" && (
          <p className="border-b px-4 py-2 text-xs text-muted-foreground sm:px-6">Model: {modelNotice.model}</p>
        )}
        {modelNotice?.kind === "reported" && (
          <p className="text-xs text-muted-foreground">Reported model: {modelNotice.model}</p>
        )}
        {modelNotice?.kind === "notice" && (
          <details className="border-b px-4 py-2 text-sm sm:px-6">
            <summary className="cursor-pointer text-muted-foreground">{modelNotice.summary}</summary>
            <div className="space-y-1 pt-2 text-muted-foreground">
              {modelNotice.requestedModel && <p>Requested model: {modelNotice.requestedModel}</p>}
              {modelNotice.observedModel && <p>Reported model: {modelNotice.observedModel}</p>}
              {modelNotice.message && <p>{modelNotice.message}</p>}
            </div>
          </details>
        )}
        <Notices status={status} reason={reason} poll={poll} onRetry={retryPolling} />

        <Transcript
          items={[
            ...chat.items,
            ...unconfirmed.flatMap((message) => {
              const items: ChatItem[] =
                message.kind === "steer"
                  ? [
                      {
                        kind: "steer",
                        key: `steer:${message.requestId}`,
                        at: message.at,
                        text: message.text,
                        ...(message.mode ? { mode: message.mode } : {}),
                      },
                    ]
                  : [
                      {
                        kind: "user",
                        key: `prompt:${message.promptId}`,
                        at: message.at,
                        text: message.text,
                        status: message.failure ? "failed" : "queued",
                      },
                      ...(message.failure
                        ? [
                            {
                              kind: "outcome" as const,
                              key: `outcome:prompt:${message.promptId}`,
                              at: message.at,
                              status: "failed" as const,
                              reason: message.failure,
                            },
                          ]
                        : []),
                    ];
              return items;
            }),
          ]}
          running={working}
          loaded={loaded}
          poll={poll}
          hasMore={olderCursor !== null}
          onMore={() => void loadOlder()}
        />

        <SandboxInspectorPhoneSlot />
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
              running={turnRunning}
              onSending={(message) =>
                setOutbox((current) => {
                  if (message.kind !== "steer") return [...current, message];
                  const confirmedBefore =
                    chatItemsRef.current.filter((item) => item.kind === "steer" && item.text === message.text).length +
                    current.filter((item) => item.kind === "steer" && !item.failure && item.text === message.text)
                      .length;
                  return [...current, { ...message, confirmedBefore }];
                })
              }
              onSendSettled={(requestId, promptId) => {
                setOutbox((current) =>
                  current.flatMap((message) => {
                    if (message.requestId !== requestId) return [message];
                    return promptId ? [{ ...message, promptId, accepted: true }] : [];
                  }),
                );
              }}
              onDone={resumePolling}
            />
          ))}
      </Card>

      <SandboxInspectorEvents>
        <TechnicalEvents events={chat.technical} />
      </SandboxInspectorEvents>
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
function Transcript({
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
  const content = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const last = items.at(-1);
  const hasItems = items.length > 0;
  const signature = transcriptSignature(items, running);

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
    if (hasItems && content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [hasItems]);

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
            <div className="mx-auto flex max-w-[740px] flex-col gap-6" data-testid="history-loading">
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
          <ol ref={content} className="mx-auto flex max-w-[740px] flex-col gap-6">
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
            className="max-w-[min(85%,36rem)] rounded-2xl border bg-[var(--raised)] px-3.5 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap"
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
            className="max-w-[min(85%,36rem)] rounded-2xl border bg-[var(--raised)] px-3.5 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap"
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
          <Markdown text={item.text} className="text-[15px] leading-7" />
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
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const expanded = userOpen ?? !complete;
  const hasRunningTool = running && !complete;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRunningTool) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasRunningTool]);
  return (
    <Collapsible
      open={expanded}
      onOpenChange={(next) => setUserOpen(next)}
      className="overflow-hidden rounded-xl border border-border/80 bg-[var(--surface)]"
    >
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-auto w-full justify-start gap-2 rounded-none px-3 py-1.5 text-xs text-muted-foreground"
        >
          <ChevronRightIcon aria-hidden className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
          <span className="font-medium text-foreground">{complete ? "Worked" : running ? "Working" : "Activity"}</span>
          <span>
            · {tools.length} {tools.length === 1 ? "step" : "steps"}
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent forceMount>
        <div
          data-tool-group-body={expanded ? "open" : "closed"}
          aria-hidden={!expanded || undefined}
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-200 ease-(--ease-out) motion-reduce:transition-none",
            expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          )}
        >
          <div className="min-h-0 overflow-hidden" inert={!expanded}>
            <ul className="border-t" aria-label="Tool calls">
              {tools.map((tool) => (
                <ToolRow key={tool.id} tool={tool} running={running} now={now} />
              ))}
            </ul>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const OUTPUT_LIMIT = 8000;

function ToolRow({ tool, running, now }: { tool: ToolActivity; running: boolean; now: number }) {
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
  const elapsed = state === "running" ? formatElapsedSeconds(tool.at, now) : null;
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
            {elapsed && (
              <span
                data-tool-elapsed
                className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground"
              >
                {elapsed}
              </span>
            )}
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

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]';
const OVERLAY_SELECTOR = `${DIALOG_SELECTOR}, [role="menu"], [role="listbox"]`;

function hasOpenOverlay(selector: string) {
  return (
    typeof document !== "undefined" &&
    typeof document.querySelector === "function" &&
    Boolean(document.querySelector(selector))
  );
}

const MAX_COMPOSER_HEIGHT_PX = 240;

type Intent = "send" | "steer" | "interrupt";

/**
 * The next message. Send opens a new turn (with an optional model or effort for that turn); while a turn runs,
 * Steer redirects it and Interrupt stops it. The draft clears immediately and restores only on definite refusal.
 */
function Composer({
  sandboxId,
  harness,
  catalog,
  launchedModel,
  pinnedModel,
  status,
  running,
  onDone,
  onSending,
  onSendSettled,
  idlePaused,
  provider,
  preservationNote,
  expiresAt,
  initialStatus,
  statusReason,
}: Props & {
  status: SandboxStatus;
  running: boolean;
  idlePaused: boolean;
  onDone: () => void;
  onSending: (message: PendingMessage) => void;
  onSendSettled: (requestId: string, promptId: string | undefined) => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;
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
  const { refusal, wakes } = composerAdmission(
    {
      provider: provider ?? "boat",
      status,
      renderedStatus: initialStatus,
      renderedStatusReason: statusReason ?? null,
      idlePaused,
      preservationNote: preservationNote ?? null,
      expiresAt: expiresAt ?? null,
    },
    new Date(),
  );
  const enabled = !refusal && (CAN_SEND as readonly SandboxStatus[]).includes(status);
  const restarts = STEER_RESTARTS_TURN[harness];
  /** The highlighted button, which Enter (or Ctrl/Cmd+Enter) triggers: steering while a turn runs, unless the model changes. */
  const primary: Intent = running && !override ? "steer" : "send";
  /** Steer is unavailable because of a model change: say so, unless an error needs the space. */
  const steerHint = running && override && result?.ok !== false;

  useLayoutEffect(() => {
    if (!enabled) return;
    const el = textareaRef.current;
    if (!el || !el.style) return;
    el.style.height = "auto";
    const scrollHeight = el.scrollHeight;
    if (typeof scrollHeight === "number" && scrollHeight > 0) {
      el.style.height = `${Math.min(scrollHeight, MAX_COMPOSER_HEIGHT_PX)}px`;
      el.style.overflowY = draft.length > 0 && scrollHeight > MAX_COMPOSER_HEIGHT_PX ? "auto" : "hidden";
    }
  }, [draft, enabled]);

  useEffect(() => {
    if (!enabled || !sandboxId) return;
    const el = textareaRef.current;
    if (!el || typeof el.focus !== "function") return;
    if (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches) return;
    if (hasOpenOverlay(DIALOG_SELECTOR)) return;
    el.focus({ preventScroll: true });
  }, [sandboxId, enabled]);

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
    const submittedDraft = draft;
    const trimmed = submittedDraft.trim();
    if (intent !== "interrupt" && !trimmed) {
      setResult({ ok: false, error: "Write the message to send." });
      return;
    }
    if (intent === "send" && change(data) === "incomplete") {
      setResult({ ok: false, error: INCOMPLETE_MODEL });
      return;
    }
    data.set("prompt", submittedDraft);
    let submittedKey: LaunchKey | null = null;
    if (intent === "send") {
      submittedKey = messageKeyFor(sendKey.current, data);
      sendKey.current = submittedKey;
      data.set(SEND_KEY_FIELD, submittedKey.key);
    }
    const requestId =
      intent === "send"
        ? submittedKey?.key
        : intent === "steer"
          ? typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `steer-${Date.now()}-${Math.random().toString(36).slice(2)}`
          : undefined;
    if (requestId) {
      onSending({
        requestId,
        promptId: requestId,
        text: trimmed,
        at: Date.now(),
        kind: intent === "steer" ? "steer" : "user",
      });
    }
    const hadOverride = override;
    if (intent !== "interrupt") {
      setDraft("");
    }
    const action = intent === "send" ? sendToSandbox : intent === "steer" ? steerSandbox : interruptSandbox;
    setWaking(intent === "send" && wakes);
    setPending(intent);
    setResult(null);
    startTransition(async () => {
      let outcome: ActionResult & { promptId?: string | undefined };
      try {
        outcome = await action(null, data);
      } catch {
        outcome = { ok: false, error: UNCONFIRMED_ACTION };
      }
      if (requestId) onSendSettled(requestId, outcome.ok ? (outcome.promptId ?? requestId) : undefined);
      setPending(null);
      setWaking(false);
      setResult(outcome);
      if (!outcome.ok) {
        if (intent !== "interrupt" && isDefiniteComposerRefusal(outcome) && draftRef.current === "") {
          if (intent === "send" && submittedKey) sendKey.current = submittedKey;
          setDraft(submittedDraft);
        }
        return;
      }
      sendKey.current = null;
      if (intent !== "interrupt" && hadOverride) {
        const promptField = form.current?.elements.namedItem("prompt");
        const typedFollowUp = promptField instanceof HTMLTextAreaElement ? promptField.value : null;
        form.current?.reset();
        if (promptField instanceof HTMLTextAreaElement && typedFollowUp !== null) {
          promptField.value = typedFollowUp;
        }
        setOverride(false);
      }
      onDone();
    });
  }

  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!enabled || !running || pending !== null || typeof window === "undefined") return;
    function onWindowKeyDown(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented || composerKeyAction(event, { running: true, pending: false }) !== "interrupt") return;
      const target = event.target;
      if (target === textareaRef.current || hasOpenOverlay(OVERLAY_SELECTOR)) return;
      if (
        typeof HTMLElement !== "undefined" &&
        target instanceof HTMLElement &&
        (target.tagName === "SELECT" || target.tagName === "INPUT" || target.closest(OVERLAY_SELECTOR))
      ) {
        return;
      }
      event.preventDefault();
      runRef.current("interrupt");
    }
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [enabled, pending, running]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    run(primary);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const action = composerKeyAction(event, { running, pending: pending !== null });
    if (action === "submit") {
      event.preventDefault();
      if (draftRef.current.trim()) run(primary);
      return;
    }
    if (action === "interrupt") {
      event.preventDefault();
      run("interrupt");
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
      className="mx-1 mb-[max(0.75rem,env(safe-area-inset-bottom))] w-[calc(100%-0.5rem)] max-w-[740px] self-center space-y-2 rounded-2xl border border-border bg-[var(--surface)] p-2.5 shadow-md"
      aria-label="Message the agent"
    >
      <input type="hidden" name="sandbox" value={sandboxId} />
      <Label htmlFor={`${fieldId}-message`} className="sr-only">
        Message
      </Label>
      <Textarea
        ref={textareaRef}
        id={`${fieldId}-message`}
        name="prompt"
        rows={1}
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
        className="max-h-60 min-h-11 resize-none rounded-none border-0 bg-transparent px-1.5 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
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
          ) : pending === "interrupt" ? (
            <p role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">
              Interrupting…
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
                title="Interrupt · Esc"
                className="max-sm:px-2"
                disabled={pending !== null}
                onClick={() => run("interrupt")}
              >
                {pending === "interrupt" ? <Loader2Icon className="animate-spin" /> : <CircleStopIcon />}
                <span className="max-sm:sr-only">{pending === "interrupt" ? "Interrupting…" : "Interrupt"}</span>
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
              title={primary === "send" ? "Send · Enter (Shift+Enter for newline)" : undefined}
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
  if (events.length === 0) return <p className="text-xs text-muted-foreground">No technical events yet.</p>;
  return (
    <ol data-fit="technical-list" className="space-y-2" aria-label="Technical events">
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
  );
}
