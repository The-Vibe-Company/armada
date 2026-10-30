// The conversation (THE-1996, `.aeom/direction/room.html`), read like T3
// Code's thread (THE-2050): one centred lane shared with the owner's field, the
// coordinator's answers as plain markdown, the owner's messages as a bubble on
// the right that folds when long, a quiet row of time and Copy under each on
// hover; the coordinator's own lines quiet with the state they name on a dot,
// each tool call one quiet line that opens on a click. Newest at the bottom; it
// follows new items while the owner reads the end, and stays put when they
// scrolled up.
import type { ChatItem } from "@armada/protocol";
import { AnimatePresence, m } from "motion/react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { TONE } from "@/components/fleet/FleetList";
import { type Group, rowTime } from "@/fleet/overview";
import { cn } from "@/lib/utils";
import { CopyButton } from "./Copy";
import { Markdown, TicketGroups } from "./Markdown";
import { folds } from "./markdown-rules";
import { fullTime, lineGroups, pretty, segments, toolLine } from "./view";

const ARRIVE = { duration: 0.15, ease: [0.23, 1, 0.32, 1] } as const;

export function Thread({
  items,
  repository,
  prefixes,
  groupOf,
  now,
  zone,
  empty,
}: {
  items: readonly ChatItem[];
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
}) {
  const box = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const dots = lineGroups(items, groupOf);
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
          className="m-0 mx-auto mt-auto flex w-full min-w-0 max-w-(--chat-content-max-width) list-none flex-col gap-3 p-0"
          aria-live={announce ? "polite" : "off"}
          aria-relevant="additions"
          data-thread
        >
          {items.length === 0 && <li className="py-6 text-center text-body text-text-3">{empty}</li>}
          <AnimatePresence initial={false}>
            {items.map((item) => (
              <m.li
                key={item.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={ARRIVE}
                data-item={item.kind}
                // A message on its way is announced once, when the conversation holds it; its controls wait for it too.
                inert={item.id.startsWith("sent:") || undefined}
                className="group/row min-w-0"
              >
                <Item
                  item={item}
                  dot={dots.get(item.id) ?? null}
                  repository={repository}
                  prefixes={prefixes}
                  groupOf={groupOf}
                  time={rowTime(item.at, now, zone)}
                  full={fullTime(item.at, zone)}
                />
              </m.li>
            ))}
          </AnimatePresence>
        </ol>
      </TicketGroups>
    </section>
  );
}

function Item({
  item,
  dot,
  repository,
  prefixes,
  groupOf,
  time,
  full,
}: {
  item: ChatItem;
  dot: Group | null;
  repository: string;
  prefixes: string;
  groupOf: (ticket: string) => Group | null;
  time: string;
  full: string;
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
    case "coordinator": {
      const said = item.body.trim();
      return (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="min-w-0 px-1 py-0.5">
            <span className="sr-only">Coordinator: </span>
            {said ? (
              <Markdown text={item.body} repository={repository} prefixes={prefixes} />
            ) : (
              <p className="m-0 text-sub text-text-3">(empty response)</p>
            )}
          </div>
          <Meta>
            {said && <CopyButton text={item.body} label="Copy message" />}
            {when}
          </Meta>
        </div>
      );
    }
    case "line":
      return (
        <div className="min-w-0 px-1 py-px text-sub text-text-2" data-line>
          <span
            aria-hidden
            className={cn("mr-2 inline-block size-2 rounded-full align-[1px]", dot ? TONE[dot].bg : "bg-step-done")}
            data-dot={dot ?? "quiet"}
          />
          <Text text={item.body} groupOf={groupOf} />
          {when}
        </div>
      );
    case "tool": {
      const { args, outcome } = toolLine(item);
      return (
        <details className="group min-w-0 px-1 text-body text-text-3" data-tool={item.name}>
          <summary className="flex min-w-0 cursor-pointer list-none items-baseline gap-2 py-px hover:text-text-2 [&::-webkit-details-marker]:hidden">
            <span aria-hidden className="inline-block w-2 flex-none transition-transform group-open:rotate-90">
              ›
            </span>
            <span className="flex-none font-mono">{item.name}</span>
            {args && <span className="min-w-0 truncate">{args}</span>}
            <span className="flex-none">· {outcome}</span>
            {when}
          </summary>
          <div className="mt-1.5 mb-1 ml-4 flex flex-col gap-2 rounded-md bg-sunken p-3 shadow-ring">
            <Field label="Input" value={pretty(item.input)} />
            <Field label="Result" value={item.output === null ? "Still running" : pretty(item.output)} />
          </div>
        </details>
      );
    }
  }
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

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-body text-text-3">{label}</span>
      <pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-body text-text-2">
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
