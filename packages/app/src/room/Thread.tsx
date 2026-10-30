// The conversation (THE-1996, `.aeom/direction/room.html`), read like T3
// Code's thread (THE-2050): one centred lane shared with the owner's field, the
// coordinator's answers as plain markdown, the owner's messages as a bubble on
// the right that folds when long, a quiet row of time and Copy under each on
// hover; the coordinator's own lines quiet with the state they name on a dot.
// Its work reads like T3 Code's (THE-2053): one row per tool call with its
// icon and sentence, a turn's calls grouped under one sentence, a finished
// turn folded under "Worked for 2m 03s" above its answer, each opening on a
// click and remembered for the project's tab. Newest at the bottom; it
// scrolls like T3 Code's (THE-2054, `follow.ts`): it follows the end, pins a
// message just sent near the top with room under it for the answer, holds
// what the owner reads still when they scrolled up (with "Scroll to end"
// above the field), and comes back where the owner left it. On a live daemon (THE-2052) the answer being written shows as
// the coordinator's message, its reasoning as a Thinking row, the running call
// shines, and the Working row closes the thread while the coordinator works.
import type { ChatItem, ChatTurn } from "@armada/protocol";
import {
  ChevronDown,
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
import {
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { TONE } from "@/components/fleet/FleetList";
import { type Group, rowTime } from "@/fleet/overview";
import { cn } from "@/lib/utils";
import { CopyButton } from "./Copy";
import type { ThreadItem } from "./chat";
import {
  type Anchor,
  anchorRow,
  correction,
  endSpace,
  FOLLOWING,
  type Follow,
  type FollowEvent,
  followBehavior,
  fromEnd,
  PILL_DELAY,
  type PositionStorage,
  pageStep,
  REARM_PX,
  type RowBox,
  readPosition,
  transition,
  wantsPill,
  writePosition,
} from "./follow";
import { Shine, Stopped, Thought, Working } from "./Live";
import { Markdown, TicketGroups } from "./Markdown";
import { folds } from "./markdown-rules";
import { browserSeen, coordinatorTimes, markSeen } from "./unread";
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

/** What the room asks of its thread: pin the message just sent (by its words), or page it from the field. */
export interface ThreadControl {
  anchor(body: string): void;
  page(direction: "up" | "down"): void;
}

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
  control,
  positions = browserPositions(),
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
  /** The room's hold on the thread's scroll (THE-2054). */
  control?: Ref<ThreadControl>;
  /** Where each project's place is kept (the tab's `sessionStorage`; null keeps none). */
  positions?: PositionStorage | null;
}) {
  const box = useRef<HTMLElement>(null);
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
  // An answer written in place is never an addition the thread's live region hears: once read, it is said whole.
  const streamed = useRef(new Set<string>());
  const [finished, setFinished] = useState("");
  useEffect(() => {
    for (const item of items) {
      if (item.kind === "streaming") streamed.current.add(item.id);
      else if (streamed.current.delete(item.id) && (item.kind === "coordinator" || item.kind === "line"))
        setFinished(item.body.trim() ? `Coordinator: ${item.body}` : "");
    }
  }, [items]);
  // Announced once the first reading is on screen: what arrives after, never the history.
  const [announce, setAnnounce] = useState(false);
  const read = items.length > 0;
  useEffect(() => {
    if (read) setAnnounce(true);
  }, [read]);
  const { pill, toEnd } = useFollow({ box, list, project, working, items, control, positions });
  useSeen(project, items);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <section
        ref={box}
        aria-label="Conversation with the coordinator"
        // The thread holds the owner's place itself (`follow.ts`): the browser's own anchoring would correct twice.
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-3.5 pb-3 [overflow-anchor:none] sm:px-12"
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
                  data-row={row.id}
                  // A message on its way is announced once, when the conversation holds it; its controls wait for it too.
                  inert={row.id.startsWith("sent:") || undefined}
                  // Still written: assistive technology waits for it (the status below says it once read).
                  aria-busy={(row.kind === "said" && row.item.kind === "streaming") || undefined}
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
        {/* The room an anchored message's answer grows into (sized by `useFollow`, never rendered). */}
        <div aria-hidden className="flex-none" data-end-space />
        <p role="status" className="sr-only">
          {finished}
        </p>
      </section>
      {pill && <ScrollToEnd queued={turn?.queued ?? 0} onClick={toEnd} />}
    </div>
  );
}

/** T3 Code's `ScrollToEndButton`: a small glass pill centred just above the field, with what waits at the end. */
function ScrollToEnd({ queued, onClick }: { queued: number; onClick: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
      <button
        type="button"
        // The field keeps the focus.
        onPointerDown={(event) => event.preventDefault()}
        onClick={onClick}
        className="pointer-events-auto inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full bg-card/85 px-3 text-body text-text-2 shadow-control backdrop-blur-md transition-colors hover:text-text"
        data-scroll-to-end
      >
        <ChevronDown aria-hidden strokeWidth={2} className="size-3.5" />
        Scroll to end
        {queued > 0 && (
          <span className="text-text-3">
            <span aria-hidden>· </span>
            {queued} queued
          </span>
        )}
      </button>
    </div>
  );
}

const browserPositions = (): PositionStorage | null => (typeof sessionStorage === "undefined" ? null : sessionStorage);

const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How wide a scrollbar drawn over the content (macOS, touch) may be. */
const SCROLLBAR_PX = 16;

const UP_KEYS = new Set(["PageUp", "Home", "ArrowUp"]);
const DOWN_KEYS = new Set(["PageDown", "End", "ArrowDown", " "]);

/** Whether a scroller inside the thread (an open group, a code block) takes this move itself. */
function innerScrolls(target: EventTarget | null, box: HTMLElement, up: boolean): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== box; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight) continue;
    const overflow = getComputedStyle(el).overflowY;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    if (up ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
  }
  return false;
}

/**
 * The thread's scroll as `follow.ts` rules it: the mode lives in a ref (a
 * scroll never re-renders the thread), the pill in state. Each new reading and
 * each resize settles the scroll for the mode: the end followed, the anchored
 * message's end space and place, or the row the owner reads held still.
 */
function useFollow({
  box,
  list,
  project,
  working,
  items,
  control,
  positions,
}: {
  box: RefObject<HTMLElement | null>;
  list: RefObject<HTMLOListElement | null>;
  project: string | undefined;
  working: boolean;
  items: readonly ThreadItem[];
  control: Ref<ThreadControl> | undefined;
  positions: PositionStorage | null;
}) {
  // Read once: where the owner left this project's thread.
  const [saved] = useState(() => (project ? readPosition(positions, project) : null));
  const restoring = useRef(saved && !saved.atEnd ? saved : null);
  const follow = useRef<Follow>(restoring.current ? { mode: "free", away: true } : FOLLOWING);
  // The row the owner reads, while free.
  const reading = useRef<Anchor | null>(restoring.current);
  const workingNow = useRef(working);
  workingNow.current = working;
  const itemsNow = useRef(items);
  itemsNow.current = items;
  // The words of the message to pin, the owner items already read when it was sent (an earlier message with the
  // same words is never it), and the reading then: the message is waited for until a later one lands without it.
  const anchored = useRef<{ body: string; before: ReadonlySet<string>; items: readonly ThreadItem[] } | null>(null);
  // The first reading is placed at once, never scrolled through.
  const placed = useRef(false);
  const [pill, setPill] = useState(false);
  const pillTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const syncPill = useCallback((state: Follow) => {
    if (wantsPill(state)) {
      pillTimer.current ??= setTimeout(() => {
        pillTimer.current = undefined;
        setPill(true);
      }, PILL_DELAY);
      return;
    }
    clearTimeout(pillTimer.current);
    pillTimer.current = undefined;
    setPill(false);
  }, []);
  const dispatch = useCallback(
    (event: FollowEvent) => {
      const before = follow.current;
      const after = transition(before, event);
      if (after !== before) {
        follow.current = after;
        syncPill(after);
      }
      return { before, after };
    },
    [syncPill],
  );

  const rows = useCallback((): RowBox[] => {
    const el = box.current;
    const ol = list.current;
    if (!el || !ol) return [];
    // Offsets, not boxes: a row arriving still slides in (a transform), which is not where it stands.
    const top = el.offsetTop + el.scrollTop;
    return [...ol.querySelectorAll<HTMLElement>(":scope > [data-row]")].map((row) => ({
      key: row.dataset.row ?? "",
      top: row.offsetTop - top,
      bottom: row.offsetTop + row.offsetHeight - top,
    }));
  }, [box, list]);
  const space = useCallback(
    (height: number) => {
      const end = box.current?.querySelector<HTMLElement>(":scope > [data-end-space]");
      if (end && end.style.height !== `${height}px`) end.style.height = `${height}px`;
    },
    [box],
  );
  const toBottom = useCallback(
    (behavior: ScrollBehavior) => {
      const el = box.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior });
    },
    [box],
  );

  const settle = useCallback(() => {
    const el = box.current;
    const ol = list.current;
    if (!el || !ol) return;
    const restore = restoring.current;
    if (restore) {
      const boxes = rows();
      if (!boxes.length) return;
      restoring.current = null;
      const row = boxes.find((b) => b.key === restore.row);
      if (row) {
        el.scrollTop += correction(restore, row.top);
        reading.current = restore;
        dispatch({
          type: "scrolled",
          fromEnd: fromEnd({ top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight }),
        });
        syncPill(follow.current);
        if (follow.current.mode === "free") return;
      } else follow.current = FOLLOWING;
    }
    const mode = follow.current.mode;
    if (mode === "free") {
      const held = reading.current;
      const row = held && rows().find((b) => b.key === held.row);
      if (held && row) {
        const shift = correction(held, row.top);
        if (Math.abs(shift) >= 0.5) el.scrollTop += shift;
      }
      // Content growing below fires no scroll: the end it moved away says so here (only a scroll re-arms).
      const away = fromEnd({ top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight });
      if (away > REARM_PX) dispatch({ type: "scrolled", fromEnd: away });
      return;
    }
    if (mode === "anchoring") {
      const sent = anchored.current;
      const said = itemsNow.current.findLast(
        (i) => i.kind === "owner" && (!sent || (i.body === sent.body && !sent.before.has(i.id))),
      );
      const owner = said ? ol.querySelector<HTMLElement>(`:scope > [data-row="${CSS.escape(said.id)}"]`) : null;
      // The message sent is not drawn yet: the reading that brings it settles again. A reading that lands
      // without it once no turn runs (a Stop withdrew it) ends the wait: the thread follows its end.
      if (!owner && sent && (itemsNow.current === sent.items || workingNow.current)) return;
      // Only a box that scrolls holds its height: one that grows with its content would grow with the space too.
      const scrolls = ["auto", "scroll"].includes(getComputedStyle(el).overflowY);
      if (owner && scrolls) {
        // Offsets, not boxes: a row arriving still slides in (a transform) and must not count.
        const below = ol.offsetTop + ol.offsetHeight - owner.offsetTop;
        const { space: room, overflows } = endSpace(
          el.clientHeight,
          below,
          Number.parseFloat(getComputedStyle(el).paddingBottom) || 0,
        );
        if (!overflows) {
          space(room);
          toBottom(reduced() ? "instant" : "smooth");
          return;
        }
      }
      // The answer outgrew the room under it (or nothing to pin): the thread follows its end.
      dispatch({ type: "overflowed" });
    }
    space(0);
    toBottom(placed.current ? followBehavior(workingNow.current, reduced()) : "instant");
    if (ol.querySelector(":scope > [data-row]")) placed.current = true;
  }, [box, list, rows, dispatch, syncPill, space, toBottom]);

  // Each new reading (an item, an answer written further, a call ended) settles the scroll.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the items are what moved.
  useLayoutEffect(settle, [items]);
  // The thread also grows without a new reading (a fold opened, an image), or its box shrinks (a queued message).
  useEffect(() => {
    const el = box.current;
    const ol = list.current;
    if (!el || !ol || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => settle());
    observer.observe(ol);
    observer.observe(el);
    return () => observer.disconnect();
  }, [box, list, settle]);

  // The owner moved the thread: letting go, a smooth follow still running stops where it is, and the row read is held.
  const navigated = useCallback(
    (up: boolean) => {
      const el = box.current;
      const { before, after } = dispatch({ type: "navigated", up });
      if (!el || before.mode === "free" || after.mode !== "free") return;
      el.scrollTo({ top: el.scrollTop, behavior: "instant" });
      reading.current = anchorRow(rows());
    },
    [box, dispatch, rows],
  );
  // The owner's moves let go of the end; any scroll may bring the thread back to it.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.deltaY === 0 || innerScrolls(e.target, el, e.deltaY < 0)) return;
      navigated(e.deltaY < 0);
    };
    const onTouch = () => navigated(true);
    // A press on the scrollbar (past the content box, or the right edge an overlay scrollbar takes); a press on a
    // row or the rest of the gutters is a click.
    const onPointer = (e: PointerEvent) => {
      if (e.target === el && el.scrollHeight > el.clientHeight && e.offsetX >= el.clientWidth - SCROLLBAR_PX)
        navigated(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const up = UP_KEYS.has(e.key) ? true : DOWN_KEYS.has(e.key) ? false : null;
      if (up !== null && !innerScrolls(e.target, el, up)) navigated(up);
    };
    const onScroll = () => {
      const geometry = { top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight };
      if (follow.current.mode === "free") reading.current = anchorRow(rows());
      dispatch({ type: "scrolled", fromEnd: fromEnd(geometry) });
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", onTouch, { passive: true });
    el.addEventListener("pointerdown", onPointer, { passive: true });
    el.addEventListener("keydown", onKey);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouch);
      el.removeEventListener("pointerdown", onPointer);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("scroll", onScroll);
    };
  }, [box, dispatch, rows, navigated]);

  // The owner's place is kept when the room closes (or the page), for the next visit.
  useEffect(() => {
    if (!project) return;
    const keep = () => {
      const held = reading.current;
      const free = follow.current.mode === "free";
      writePosition(positions, project, free && held ? { ...held, atEnd: false } : { row: "", offset: 0, atEnd: true });
    };
    window.addEventListener("pagehide", keep);
    return () => {
      window.removeEventListener("pagehide", keep);
      keep();
      clearTimeout(pillTimer.current);
    };
  }, [project, positions]);

  const toEnd = useCallback(() => {
    // The pill leaves with the click: a keyboard's focus goes back to the room's field rather than the page.
    if (document.activeElement?.closest("[data-scroll-to-end]"))
      box.current?.closest("[data-room]")?.querySelector("textarea")?.focus({ preventScroll: true });
    dispatch({ type: "toEnd" });
    space(0);
    toBottom(reduced() ? "instant" : "smooth");
  }, [box, dispatch, space, toBottom]);
  useImperativeHandle(
    control,
    () => ({
      anchor(body) {
        const before = new Set<string>();
        for (const i of itemsNow.current) if (i.kind === "owner" && !i.id.startsWith("sent:")) before.add(i.id);
        anchored.current = { body, before, items: itemsNow.current };
        dispatch({ type: "sent" });
        settle();
      },
      page(direction) {
        const el = box.current;
        if (!el) return;
        navigated(direction === "up");
        el.scrollBy({ top: (direction === "up" ? -1 : 1) * pageStep(el.clientHeight), behavior: "instant" });
      },
    }),
    [box, dispatch, settle, navigated],
  );
  return { pill, toEnd };
}

/** Records the latest coordinator item as seen while the room is open and the window focused (THE-2054). */
function useSeen(project: string | undefined, items: readonly ThreadItem[]) {
  useEffect(() => {
    if (!project) return;
    const storage = browserSeen();
    const mark = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      const at = coordinatorTimes(items.filter((i): i is ChatItem => i.kind !== "streaming")).at(-1);
      if (at) markSeen(storage, project, at);
    };
    mark();
    window.addEventListener("focus", mark);
    document.addEventListener("visibilitychange", mark);
    return () => {
      window.removeEventListener("focus", mark);
      document.removeEventListener("visibilitychange", mark);
    };
  }, [project, items]);
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
    case "wake":
      return (
        <div className="flex min-h-6 min-w-0 items-baseline px-0.5 py-0.5 text-body text-text-3" data-wake>
          <Markdown
            text={item.body}
            repository={repository}
            prefixes={prefixes}
            className="text-body text-text-3 [&_p]:m-0"
          />
          {when}
        </div>
      );
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
