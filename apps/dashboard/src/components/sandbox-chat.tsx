"use client";

import type { Harness, SandboxStatus } from "@armada/core";
import {
  AlertTriangleIcon,
  ArrowDownIcon,
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
import { ModKey } from "@/components/mod-key";
import { type ModelCatalog, ModelFields } from "@/components/model-fields";
import { StatusBadge, StatusDot } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Kbd } from "@/components/ui/kbd";
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
import { INCOMPLETE_MODEL, modelChange } from "@/lib/composer";
import { type ChatEvent, isActiveStatus, mergeEvents, parseEventPage } from "@/lib/events";
import { describeFailure } from "@/lib/failure";
import { cn } from "@/lib/utils";

const POLL_MS = 2000;
/** Within this distance of the bottom the view follows new messages; further up it stays where the person is. */
const PINNED_PX = 48;
/** A stopped sandbox takes a message too: the server's `send` restores the same machine, disk and conversation. */
const LIVE: readonly SandboxStatus[] = ["starting", "ready", "running"];
const CAN_SEND: readonly SandboxStatus[] = ["ready", "running", "stopped"];

type Props = {
  sandboxId: string;
  initialStatus: SandboxStatus;
  initialUsageRevision: string;
  live: boolean;
  harness: Harness;
  catalog: ModelCatalog;
  launchedModel: string | null;
  /** Conversation ids Armada recorded for the sandbox, oldest first. */
  conversations: string[];
  /** The Armada server is configured: messages can be sent. */
  configured: boolean;
};

type Poll = { error: string | null; configured: boolean };

/**
 * The sandbox as a conversation: the prompts, the agent's answers and its tool calls, read from the event stream
 * by cursor (every couple of seconds while the sandbox is active), with a composer for the next message.
 */
export function SandboxChat(props: Props) {
  const { sandboxId, initialStatus, live } = props;
  const router = useRouter();
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [status, setStatus] = useState(initialStatus);
  const [poll, setPoll] = useState<Poll>({ error: null, configured: true });
  const [hasMore, setHasMore] = useState(false);
  const [turnModel, setTurnModel] = useState<{
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
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reading = useRef(false);
  const mounted = useRef(true);

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
    if (typeof body.prompt === "object" && body.prompt !== null) setTurnModel(body.prompt);
    const next = typeof body.status === "string" ? (body.status as SandboxStatus) : known.current;
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
    const configured = body.configured !== false;
    setPoll((current) =>
      current.error === error && current.configured === configured ? current : { error, configured },
    );
    setLoaded(true);
    const page = parseEventPage(body);
    if (page.cursor) cursor.current = page.cursor;
    if (page.events.length > 0) setEvents((shown) => mergeEvents(shown, page.events));
    setHasMore(page.hasMore);
    return { more: page.hasMore, active: isActiveStatus(next) || refreshNeeded };
  }, [sandboxId, router]);

  /** Read until drained, inactive and rendered metadata is acknowledged. One loop at a time. */
  const tick = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    clearTimeout(timer.current);
    try {
      const { more, active } = await read();
      if (!mounted.current) return;
      if (more) timer.current = setTimeout(() => void tick(), 0);
      else if (active) timer.current = setTimeout(() => void tick(), POLL_MS);
    } finally {
      reading.current = false;
    }
  }, [read]);

  // A server action such as Stop re-renders the page with the new status: show it in the same paint as the header,
  // not at the next poll, and read again when it says the sandbox is active (polling stops on an inactive status).
  useLayoutEffect(() => {
    if (initialStatus === known.current) return;
    known.current = initialStatus;
    setStatus(initialStatus);
    if (isActiveStatus(initialStatus)) void tick();
  }, [initialStatus, tick]);

  useEffect(() => {
    mounted.current = true;
    void tick();
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, [tick]);

  const conversations = useMemo(() => conversationsOf(events, props.conversations), [events, props.conversations]);
  const selected = chosen && conversations.includes(chosen) ? chosen : (conversations.at(-1) ?? null);
  const shownConversation = conversations.length > 1 ? selected : null;
  const chat = useMemo(() => projectChat(eventsOf(events, shownConversation)), [events, shownConversation]);
  // A stopped or failed machine runs no turn, whatever its last prompt event said before it stopped.
  const turnRunning = chat.running && LIVE.includes(status);
  const failure = [...chat.items].reverse().find((item) => item.kind === "outcome" && item.status === "failed");
  const reason = failure?.kind === "outcome" ? failure.reason : undefined;

  return (
    <div data-fit="chat" className="space-y-2 sm:space-y-4">
      <Card data-fit="card" className="gap-0 overflow-hidden py-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <h2 className="text-sm leading-none font-semibold">Conversation</h2>
            {conversations.length > 1 && (
              <ConversationPicker conversations={conversations} selected={selected} onChange={(id) => setChosen(id)} />
            )}
          </div>
          <div className="flex items-center gap-3 text-sm">
            {live && isActiveStatus(status) && (
              <span
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
                data-testid="live-indicator"
                title="New messages appear as they arrive"
              >
                <StatusDot tone="success" pulse /> Live
              </span>
            )}
            <StatusBadge status={status} />
          </div>
        </div>

        {turnModel && (
          <div className="px-4 py-2 text-sm" role="status">
            <p>
              Latest turn {turnModel.promptId ?? "unknown"} · Conversation {turnModel.conversationId ?? "unknown"}
            </p>
            <p>
              Requested: {turnModel.requestedModel ?? "unknown"} · Observed: {turnModel.observedModel ?? "unknown"}
            </p>
            {turnModel.modelSelectionReason && (
              <p
                className={
                  turnModel.modelSelectionReason === "model_selection_mismatch"
                    ? "text-destructive"
                    : "text-muted-foreground"
                }
                title={turnModel.modelSelectionReason}
              >
                {turnModel.modelSelectionReason === "model_selection_mismatch"
                  ? "Model selection changed"
                  : "Model not verified"}
                : {turnModel.modelSelectionMessage}
              </p>
            )}
          </div>
        )}
        <Notices status={status} reason={reason} poll={poll} />

        <Transcript
          key={selected ?? "all"}
          items={chat.items}
          running={turnRunning}
          loaded={loaded}
          poll={poll}
          hasMore={hasMore}
          onMore={() => void tick()}
        />

        {props.configured && (
          <Composer
            {...props}
            status={status}
            conversation={selected && props.conversations.includes(selected) ? selected : null}
            running={turnRunning}
            onDone={() => {
              router.refresh();
              void tick();
            }}
          />
        )}
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
      <label htmlFor={id} className="sr-only">
        Conversation
      </label>
      <NativeSelect
        id={id}
        value={selected ?? ""}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-auto text-xs"
      >
        {conversations.map((conversation, index) => (
          <option key={conversation} value={conversation}>
            {`Conversation ${index + 1} (${conversation.slice(0, 8)})`}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

/** The sandbox-wide notices. A failed turn explains itself where it ended, in the conversation. */
function Notices({ status, reason, poll }: { status: SandboxStatus; reason: string | undefined; poll: Poll }) {
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
        <AlertDescription>{poll.error}</AlertDescription>
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
        className="max-h-[min(68vh,46rem)] min-h-40 overflow-y-auto overscroll-contain px-4 py-5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-6"
      >
        {items.length === 0 ? (
          loaded || !poll.configured || poll.error ? (
            <p className="text-sm text-muted-foreground">
              {loaded && poll.configured && !poll.error ? "No messages yet." : ""}
            </p>
          ) : (
            // The shape of a conversation while it loads: nothing jumps when the messages arrive.
            <div className="mx-auto flex max-w-3xl flex-col gap-5" data-testid="history-loading">
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
          <ol className="mx-auto flex max-w-3xl flex-col gap-5">
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
                <StatusDot tone="info" pulse className="mx-1" />
                Working
              </li>
            )}
          </ol>
        )}
        {hasMore && (
          <div className="mt-4 flex justify-center">
            <Button variant="outline" size="sm" onClick={onMore}>
              Load more
            </Button>
          </div>
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
            className="max-w-[min(85%,36rem)] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-primary-foreground shadow-xs"
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
            className="max-w-[min(85%,36rem)] rounded-2xl rounded-br-md border border-dashed border-foreground/25 px-4 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap"
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
    <div
      role="note"
      className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
    >
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium">{help?.title ?? "The turn failed"}</p>
        {(help?.hint ?? reason) && <p className="break-words text-destructive/90">{help?.hint ?? reason}</p>}
        {help?.fix && (
          <Link href={help.fix.href} className="font-medium underline underline-offset-4">
            {help.fix.label}
          </Link>
        )}
      </div>
    </div>
  );
}

function ToolGroup({ tools, running }: { tools: ToolActivity[]; running: boolean }) {
  return (
    <ul className="divide-y overflow-hidden rounded-lg border bg-muted/20" aria-label="Tool calls">
      {tools.map((tool) => (
        <ToolRow key={tool.id} tool={tool} running={running} />
      ))}
    </ul>
  );
}

const OUTPUT_LIMIT = 8000;

function ToolRow({ tool, running }: { tool: ToolActivity; running: boolean }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const summary = toolSummary(tool.input);
  const failed = tool.result?.isError === true;
  const state = tool.result ? (failed ? "error" : "done") : running ? "running" : "unknown";
  return (
    <li data-tool={tool.name} data-tool-state={state}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panel}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
        <ToolState state={state} />
        <span className="shrink-0 font-mono font-medium">{tool.name}</span>
        {summary && <span className="min-w-0 truncate font-mono text-muted-foreground">{summary}</span>}
      </button>
      {open && (
        <div id={panel} className="space-y-2 border-t bg-background/60 px-3 py-2">
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
        </div>
      )}
    </li>
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
  status,
  conversation,
  running,
  onDone,
}: Props & { status: SandboxStatus; conversation: string | null; running: boolean; onDone: () => void }) {
  const form = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, setPending] = useState<Intent | null>(null);
  const [, startTransition] = useTransition();
  const [showModel, setShowModel] = useState(false);
  const [override, setOverride] = useState(false);
  const fieldId = useId();
  const enabled = CAN_SEND.includes(status);
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
    if (form.current) setOverride(change(new FormData(form.current)) !== "none");
  }

  function run(intent: Intent) {
    if (!form.current || pending) return;
    const data = new FormData(form.current);
    if (intent !== "interrupt" && !draft.trim()) {
      setResult({ ok: false, error: "Write the message to send." });
      return;
    }
    if (intent === "send" && change(data) === "incomplete") {
      setShowModel(true);
      setResult({ ok: false, error: INCOMPLETE_MODEL });
      return;
    }
    const action = intent === "send" ? sendToSandbox : intent === "steer" ? steerSandbox : interruptSandbox;
    setPending(intent);
    setResult(null);
    startTransition(async () => {
      let outcome: ActionResult;
      try {
        outcome = await action(null, data);
      } catch {
        outcome = { ok: false, error: "The message could not be sent. Try again." };
      }
      setPending(null);
      setResult(outcome);
      if (!outcome.ok) return;
      if (intent !== "interrupt") {
        setDraft("");
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
        {status === "starting" || status === "stopping"
          ? `The sandbox is ${status}.`
          : `The sandbox is ${status}: it takes no new messages.`}
      </p>
    );
  }

  return (
    <form
      ref={form}
      noValidate
      onSubmit={onSubmit}
      onChange={readOverride}
      className="space-y-3 border-t bg-muted/40 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6"
      aria-label="Message the agent"
    >
      <input type="hidden" name="sandbox" value={sandboxId} />
      <input type="hidden" name="conversation" value={conversation ?? ""} />
      <label htmlFor={`${fieldId}-message`} className="sr-only">
        Message
      </label>
      <Textarea
        id={`${fieldId}-message`}
        name="prompt"
        rows={2}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          running
            ? "Steer the running turn, or send the next one"
            : status === "stopped"
              ? "Send a message to resume the sandbox"
              : "What should the agent do next?"
        }
        className="max-h-60 min-h-14 resize-y bg-card shadow-xs sm:min-h-20 dark:bg-card"
      />
      <div id={`${fieldId}-model`} hidden={!showModel}>
        <ModelFields
          idPrefix={`send-${sandboxId}`}
          harness={harness}
          catalog={catalog}
          keepLabel="As launched"
          launchedModel={launchedModel}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={showModel}
          aria-controls={`${fieldId}-model`}
          onClick={() => setShowModel((value) => !value)}
          className={cn("relative text-muted-foreground max-sm:px-2", override && "text-foreground")}
        >
          <SlidersHorizontalIcon />
          {/* A changed model is marked by more than colour: a dot, and the word where there is room. */}
          {override && (
            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary sm:hidden" aria-hidden="true" />
          )}
          {/* Icon only on a phone, where the controls must fit one row; the name stays for assistive tech. */}
          <span className="max-sm:sr-only">{override ? "Model changed" : "Model"}</span>
        </Button>
        {steerHint ? (
          // Why Steer is unavailable, visible on a touch screen too (a title never shows there); one line, never a row.
          // It takes the place of an earlier success message, never of an error.
          <p
            id={`${fieldId}-steer-hint`}
            className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground sm:text-xs"
          >
            <span className="sr-only">Model change: </span>
            New turn only
          </p>
        ) : (
          result && (
            <p
              role={result.ok ? "status" : "alert"}
              className={cn("min-w-0 flex-1 text-xs", result.ok ? "text-muted-foreground" : "text-destructive")}
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
              {primary === "steer" && <SendShortcut />}
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
            {running ? (
              <>
                <span className="max-sm:hidden">Send as new turn</span>
                <span className="sm:hidden">New turn</span>
              </>
            ) : (
              "Send"
            )}
            {primary === "send" && <SendShortcut />}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** The shortcut the highlighted button answers to, on the button itself; hidden from its accessible name. */
function SendShortcut() {
  return (
    <Kbd
      aria-hidden="true"
      className="-mr-1 ml-0.5 border-transparent bg-primary-foreground/15 text-primary-foreground/80 shadow-none max-sm:hidden"
    >
      <span>
        <ModKey />
      </span>
      <span>↵</span>
    </Kbd>
  );
}

function TechnicalEvents({ events }: { events: ChatEvent[] }) {
  const [open, setOpen] = useState(false);
  if (events.length === 0) return null;
  return (
    <details
      className="rounded-lg border px-4 py-2 text-sm sm:px-6 sm:py-3"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer font-medium">Technical events ({events.length})</summary>
      {open && (
        <ol data-fit="technical-list" className="mt-3 space-y-2" aria-label="Technical events">
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
    </details>
  );
}
