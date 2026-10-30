// The conversation (THE-1996, `.aeom/direction/room.html`), read like T3
// Code's thread (THE-2050): one centred lane shared with the owner's field, the
// coordinator's answers as plain markdown, the owner's messages as a bubble on
// the right that folds when long, a quiet row of time and Copy under each on
// hover; the coordinator's own lines quiet with the state they name on a dot.
// Its work reads like T3 Code's (THE-2053): one row per tool call with its
// icon and sentence, a turn's calls grouped under one sentence, a finished
// turn folded under "Worked for 2m 03s" above its answer, each opening on a
// click and remembered for the project's tab. Newest at the bottom; it
// follows new items while the owner reads the end, and stays put when they
// scrolled up. On a live daemon (THE-2052) the answer being written shows as
// the coordinator's message, its reasoning as a Thinking row, the running call
// shines, and the Working row closes the thread while the coordinator works.
import type { ChatItem, ChatTurn } from "@armada/protocol";
import {
  ChevronRight,
  Eye,
  FileText,
  GitMerge,
  HelpCircle,
  type LucideIcon,
  MessageSquare,
  Rocket,
  SlidersHorizontal,
  Square,
  Wrench,
  X,
} from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { TONE } from "@/components/fleet/FleetList";
import { type Group, rowTime } from "@/fleet/overview";
import { cn } from "@/lib/utils";
import { CopyButton } from "./Copy";
import type { ThreadItem } from "./chat";
import { Shine, Stopped, Thought, Working } from "./Live";
import { Markdown, TicketGroups } from "./Markdown";
import { folds } from "./markdown-rules";
import {
  fullTime,
  lineGroups,
  pretty,
  refusal,
  type Said,
  segments,
  summarizeWork,
  type ThreadRow,
  type Work,
  type WorkIcon,
  workIcon,
  workLabel,
  workRows,
} from "./view";

const ARRIVE = { duration: 0.15, ease: [0.23, 1, 0.32, 1] } as const;

export function Thread({
  items,
  project,
  repository,
  prefixes,
  groupOf,
  now,
  zone,
  empty,
  turn = null,
  started = null,
}: {
  items: readonly ThreadItem[];
  /** The project's id: the rows the owner opened are kept for it in the tab's `sessionStorage`. */
  project?: string;
  /** The project's repository (`owner/name`): `#34` links to its pull request. */
  repository: string;
  /** The project's ticket prefixes, space-separated (`THE HAR`): the ids that link in a message. */
  prefixes: string;
  /** A ticket's group now, for the ids and the lines' dots. */
  groupOf: (ticket: string) => Group | null;
  now: number;
  zone: string;
  /** Said when there is nothing yet. */
  empty: ReactNode;
  /** The coordinator's turn (THE-2052): the Working row while it is not idle. */
  turn?: ChatTurn | null;
  /** When that turn began, if seen; null for "Working…". */
  started?: string | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const dots = lineGroups(
    items.filter((i): i is ChatItem => i.kind !== "streaming"),
    groupOf,
  );
  const rows = workRows(items);
  const open = useOpen(project);
  const working = turn !== null && turn.state !== "idle";
  const tail = items.at(-1);
  // The call the turn runs now shines (THE-2052).
  const running = working ? (turn?.tool?.id ?? null) : null;
  const list = useRef<HTMLOListElement>(null);
  // Announced once the first reading is on screen: what arrives after, never the history.
  const [announce, setAnnounce] = useState(false);
  const read = items.length > 0;
  useEffect(() => {
    if (read) setAnnounce(true);
  }, [read]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new item scrolls to it, if the owner was at the end.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [items.length]);
  // The thread also grows without a new item (an answer being written, its reading in its place), or its box
  // shrinks (a queued message under it): it keeps the end in view then too.
  useEffect(() => {
    const el = box.current;
    const content = list.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (atEnd.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <section
      ref={box}
      aria-label="Conversation with the coordinator"
      onScroll={(e) => {
        const el = e.currentTarget;
        atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-3.5 pb-3 sm:px-12"
    >
      <TicketGroups value={groupOf}>
        <ol
          ref={list}
          className="m-0 mx-auto mt-auto flex w-full min-w-0 max-w-(--chat-content-max-width) list-none flex-col gap-3 p-0"
          aria-live={announce ? "polite" : "off"}
          aria-relevant="additions"
          data-thread
        >
          {items.length === 0 && <li className="py-6 text-center text-body text-text-3">{empty}</li>}
          <AnimatePresence initial={false}>
            {rows.map((row, k) => (
              <m.li
                key={row.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={ARRIVE}
                data-item={rowKind(row)}
                // A message on its way is announced once, when the conversation holds it; its controls wait for it too.
                inert={row.id.startsWith("sent:") || undefined}
                className="group/row min-w-0"
              >
                {row.kind === "said" ? (
                  <Item
                    item={row.item}
                    dot={dots.get(row.item.id) ?? null}
                    repository={repository}
                    prefixes={prefixes}
                    groupOf={groupOf}
                    time={rowTime(row.item.at, now, zone)}
                    full={fullTime(row.item.at, zone)}
                    thinking={working && turn?.state === "thinking" && row.item === tail}
                    folded={rows[k - 1]?.kind === "fold"}
                  />
                ) : row.kind === "fold" ? (
                  <Fold
                    row={row}
                    open={open}
                    groupOf={groupOf}
                    time={rowTime(row.work.at, now, zone)}
                    full={fullTime(row.work.at, zone)}
                  />
                ) : (
                  <WorkBlock work={row.work} open={open} groupOf={groupOf} running={running} />
                )}
              </m.li>
            ))}
          </AnimatePresence>
          {working && (
            <li className="min-w-0" data-item="working">
              <Working started={started} queued={turn?.queued ?? 0} />
            </li>
          )}
        </ol>
      </TicketGroups>
    </section>
  );
}

const rowKind = (row: ThreadRow) =>
  row.kind === "said" ? row.item.kind : row.kind === "fold" ? "fold" : row.work.tools.length > 1 ? "work" : "tool";

function Item({
  item,
  dot,
  repository,
  prefixes,
  groupOf,
  time,
  full,
  thinking,
  folded,
}: {
  item: Said;
  dot: Group | null;
  repository: string;
  prefixes: string;
  groupOf: (ticket: string) => Group | null;
  time: string;
  full: string;
  /** The answer being written is still thinking: its Thinking row shimmers. */
  thinking: boolean;
  /** Its work folds above it, under a label that already says when it was stopped. */
  folded: boolean;
}) {
  const when = (
    <Time at={item.at} full={full}>
      {time}
    </Time>
  );
  switch (item.kind) {
    case "owner":
      return (
        <div className="flex flex-col items-end gap-1">
          <div className="min-w-0 max-w-[80%] rounded-deck bg-panel-3 p-3 shadow-ring">
            <span className="sr-only">You: </span>
            <Folded text={item.body}>
              <Markdown text={item.body} repository={repository} prefixes={prefixes} breaks />
            </Folded>
          </div>
          <Meta>
            {when}
            <CopyButton text={item.body} label="Copy message" />
          </Meta>
        </div>
      );
    case "streaming":
      // The answer as it is written: no time and no Copy until it is read.
      return (
        <div className="flex min-w-0 flex-col gap-1" data-streaming-item>
          {item.reasoning && (
            <Thought reasoning={item.reasoning} active={thinking} repository={repository} prefixes={prefixes} />
          )}
          {item.text.trim() && (
            <div className="min-w-0 px-1 py-0.5">
              <span className="sr-only">Coordinator: </span>
              <Markdown text={item.text} repository={repository} prefixes={prefixes} streaming />
            </div>
          )}
        </div>
      );
    case "coordinator": {
      const said = item.body.trim();
      return (
        <div className="flex min-w-0 flex-col gap-1">
          {item.reasoning && (
            <Thought reasoning={item.reasoning} active={false} repository={repository} prefixes={prefixes} />
          )}
          {(said || !item.aborted) && (
            <div className="min-w-0 px-1 py-0.5">
              <span className="sr-only">Coordinator: </span>
              {said ? (
                <Markdown text={item.body} repository={repository} prefixes={prefixes} />
              ) : (
                <p className="m-0 text-sub text-text-3">(empty response)</p>
              )}
            </div>
          )}
          {item.aborted && <Stopped said={!folded} />}
          <Meta>
            {said && <CopyButton text={item.body} label="Copy message" />}
            {when}
          </Meta>
        </div>
      );
    }
    case "line":
      return (
        <div className="min-h-6 min-w-0 px-0.5 py-0.5 text-body text-text-2" data-line>
          <span
            aria-hidden
            className={cn("mr-2 inline-block size-2 rounded-full align-[1px]", dot ? TONE[dot].bg : "bg-step-done")}
            data-dot={dot ?? "quiet"}
          />
          <Text text={item.body} groupOf={groupOf} />
          {when}
          {item.aborted && <Stopped said={!folded} />}
        </div>
      );
  }
}

type Tool = Extract<ChatItem, { kind: "tool" }>;

const ICONS: Record<WorkIcon, LucideIcon> = {
  eye: Eye,
  file: FileText,
  rocket: Rocket,
  message: MessageSquare,
  square: Square,
  merge: GitMerge,
  help: HelpCircle,
  sliders: SlidersHorizontal,
  wrench: Wrench,
};

/** The rows the owner opened (folds, groups, calls), kept for the project in the tab's `sessionStorage`. */
interface Open {
  has(id: string): boolean;
  toggle(id: string): void;
}

const OPEN_KEY = (project: string) => `armada.room.open.${project}`;
const OPEN_MAX = 200;

function readOpen(key: string | null): ReadonlySet<string> {
  if (!key || typeof sessionStorage === "undefined") return new Set();
  try {
    const ids: unknown = JSON.parse(sessionStorage.getItem(key) ?? "[]");
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function useOpen(project: string | undefined): Open {
  const key = project ? OPEN_KEY(project) : null;
  const [state, setState] = useState(() => ({ key, ids: readOpen(key) }));
  // Another project's room reads its own.
  if (state.key !== key) setState({ key, ids: readOpen(key) });
  const toggle = useCallback((id: string) => {
    setState((current) => {
      const ids = new Set(current.ids);
      if (!ids.delete(id)) ids.add(id);
      if (current.key && typeof sessionStorage !== "undefined") {
        try {
          sessionStorage.setItem(current.key, JSON.stringify([...ids].slice(-OPEN_MAX)));
        } catch {
          /* Storage full or refused: open for this page only. */
        }
      }
      return { key: current.key, ids };
    });
  }, []);
  return { has: (id) => state.ids.has(id), toggle };
}

/** A row of work as T3 Code draws it: 13 px, a 24 px icon slot, one truncated label, then what trails it. */
function WorkLine({ icon, label, trailing }: { icon?: ReactNode; label: ReactNode; trailing?: ReactNode }) {
  return (
    <span className="flex min-h-6 min-w-0 items-center gap-1.5 text-body">
      {icon && (
        <span aria-hidden className="flex size-6 flex-none items-center justify-center text-text-3">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-text-2">{label}</span>
      {trailing}
    </span>
  );
}

const ROW =
  "flex w-full min-w-0 cursor-pointer rounded-md px-0.5 text-left transition-colors hover:bg-fill hover:[&_.truncate]:text-text";

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      aria-hidden
      strokeWidth={1.75}
      className={cn("size-3.5 flex-none text-text-3 transition-transform duration-200", open && "rotate-90")}
    />
  );
}

const Failed = () => <X aria-hidden strokeWidth={2} className="size-3 flex-none text-red" data-failed />;

/** A finished turn's work, folded above its answer: "Worked for 2m 03s ›", its time on hover. */
function Fold({
  row,
  open,
  groupOf,
  time,
  full,
}: {
  row: Extract<ThreadRow, { kind: "fold" }>;
  open: Open;
  groupOf: (ticket: string) => Group | null;
  time: string;
  full: string;
}) {
  const id = `fold:${row.work.id}`;
  const shown = open.has(id);
  const body = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1 border-line border-b pt-1 pb-2" data-fold>
        <button
          type="button"
          aria-expanded={shown}
          aria-controls={body}
          onClick={() => open.toggle(id)}
          className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-body text-text-3 tnum transition-colors hover:text-text-2"
        >
          <span>{row.label}</span>
          <Chevron open={shown} />
        </button>
        <span className="ml-auto opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100">
          <Time at={row.work.at} full={full}>
            {time}
          </Time>
        </span>
      </div>
      {shown && (
        <div id={body} className="min-w-0">
          <WorkBlock work={row.work} open={open} groupOf={groupOf} />
        </div>
      )}
    </div>
  );
}

/** A turn's work: one call on its own row, two or more under their sentence. */
function WorkBlock({
  work,
  open,
  groupOf,
  running = null,
}: {
  work: Work;
  open: Open;
  groupOf: (ticket: string) => Group | null;
  /** The call the coordinator's turn runs now (THE-2052): it shines. */
  running?: string | null;
}) {
  const [only] = work.tools;
  if (only && work.tools.length === 1) return <ToolRow item={only} open={open} groupOf={groupOf} running={running} />;
  return <WorkGroup work={work} open={open} groupOf={groupOf} running={running} />;
}

function WorkGroup({
  work,
  open,
  groupOf,
  running,
}: {
  work: Work;
  open: Open;
  groupOf: (ticket: string) => Group | null;
  running: string | null;
}) {
  const id = `group:${work.id}`;
  const shown = open.has(id);
  const body = useId();
  const { summary, failed } = summarizeWork(work.tools);
  const icons = new Set(work.tools.map((t) => workIcon(t.name)));
  const Icon = ICONS[icons.size === 1 ? ([...icons][0] ?? "wrench") : "wrench"];
  return (
    <div className="min-w-0" data-work={work.tools.length}>
      <button
        type="button"
        aria-expanded={shown}
        aria-controls={body}
        aria-label={failed ? `${summary}, tool call failed` : summary}
        onClick={() => open.toggle(id)}
        className={cn(ROW, "py-0.5")}
      >
        <WorkLine
          icon={<Icon strokeWidth={1.75} className="size-4" />}
          label={
            // Closed, the group's sentence shines for the call running inside it.
            <Shine active={!shown && work.tools.some((t) => t.id === running && t.output === null)}>{summary}</Shine>
          }
          trailing={
            <>
              {failed && <Failed />}
              <Chevron open={shown} />
            </>
          }
        />
      </button>
      {shown && (
        <div id={body} className="flex max-h-[min(18rem,50dvh)] min-w-0 flex-col overflow-y-auto">
          {work.tools.map((tool) => (
            <ToolRow key={tool.id} item={tool} open={open} groupOf={groupOf} running={running} grouped />
          ))}
        </div>
      )}
    </div>
  );
}

/** One tool call: its icon and sentence (its name on hover), a red X when it failed, its input and result once opened. */
function ToolRow({
  item,
  open,
  groupOf,
  grouped = false,
  running = null,
}: {
  item: Tool;
  open: Open;
  groupOf: (ticket: string) => Group | null;
  grouped?: boolean;
  running?: string | null;
}) {
  const id = `tool:${item.id}`;
  const shown = open.has(id);
  const body = useId();
  const label = workLabel(item);
  const Icon = ICONS[workIcon(item.name)];
  const refused = refusal(item);
  return (
    <div className="min-w-0" data-tool={item.name}>
      <button
        type="button"
        aria-expanded={shown}
        aria-controls={body}
        aria-label={item.failed ? `${label}, tool call failed` : label}
        onClick={() => open.toggle(id)}
        className={cn(ROW, grouped ? "py-0" : "py-0.5")}
      >
        <WorkLine
          icon={<Icon strokeWidth={1.75} className="size-4" />}
          label={
            <span title={item.name}>
              <Shine active={item.id === running && item.output === null}>
                <Text text={label} groupOf={groupOf} />
              </Shine>
            </span>
          }
          trailing={
            <>
              {item.failed && <Failed />}
              <Chevron open={shown} />
            </>
          }
        />
      </button>
      {shown && (
        <div id={body} className="mb-1 ml-7 flex min-w-0 flex-col gap-2 py-1">
          <Field label="Input" value={pretty(item.input)} />
          <div className="flex min-w-0 flex-col gap-1">
            {refused && <p className="m-0 text-body text-amber">Refused: {refused}</p>}
            <Field
              label="Result"
              value={item.output === null ? "Still running" : pretty(item.output)}
              className={cn("max-h-80", refused && "text-amber")}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Under a message: its time and Copy, shown on hover or focus, always on touch. */
function Meta({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex items-center gap-1 px-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100"
      data-meta
    >
      {children}
    </div>
  );
}

const FOLD_MASK = "linear-gradient(to bottom, black calc(100% - 1.75rem), transparent)";

/** An owner's long message (600 characters or 8 lines) folds under a fade, opened by "Show full message". */
function Folded({ text, children }: { text: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const body = useId();
  if (!folds(text)) return children;
  return (
    <>
      <div
        id={body}
        className={cn("relative", !open && "max-h-44 overflow-hidden")}
        data-folded={!open}
        style={open ? undefined : { maskImage: FOLD_MASK, WebkitMaskImage: FOLD_MASK }}
      >
        {children}
      </div>
      <div className="mt-1.5 flex justify-end">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={body}
          onClick={() => setOpen(!open)}
          className="cursor-pointer rounded-sm px-1.5 py-0.5 text-body text-text-2 hover:bg-fill-2 hover:text-text"
        >
          {open ? "Show less" : "Show full message"}
        </button>
      </div>
    </>
  );
}

function Field({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-body text-text-3">{label}</span>
      <pre
        className={cn(
          "m-0 overflow-auto whitespace-pre-wrap break-words rounded-md bg-sunken p-2 font-mono text-meta text-text-2 shadow-ring",
          className ?? "max-h-72",
        )}
      >
        {value}
      </pre>
    </div>
  );
}

function Time({ at, full, children }: { at: string; full: string; children: string }) {
  return (
    <time dateTime={at} title={full} className="ml-2.5 whitespace-nowrap font-mono text-meta text-text-3 tnum">
      {children}
    </time>
  );
}

/** A message with its ticket ids and pull requests in mono, an id in its ticket's state colour. */
function Text({ text, groupOf }: { text: string; groupOf: (ticket: string) => Group | null }) {
  return (
    <>
      {segments(text).map((s) => {
        if (s.kind === "text") return s.text;
        const group = s.kind === "ticket" ? groupOf(s.text) : null;
        return (
          <span
            key={s.at}
            className={cn("font-mono text-meta", group && group !== "merged" ? TONE[group].text : "text-text")}
          >
            {s.text}
          </span>
        );
      })}
    </>
  );
}
