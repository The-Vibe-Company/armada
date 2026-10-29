// The conversation (THE-1996, `.aeom/direction/room.html`): the owner's
// messages and the coordinator's answers as bubbles under who said them, the
// coordinator's own lines quiet with the state they name on a dot, each tool
// call one quiet line that opens on a click. Newest at the bottom; it follows
// new items while the owner reads the end, and stays put when they scrolled up.
import type { ChatItem } from "@armada/protocol";
import { AnimatePresence, m } from "motion/react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TONE } from "@/components/fleet/FleetList";
import { type Group, rowTime } from "@/fleet/overview";
import { cn } from "@/lib/utils";
import { lineGroups, pretty, segments, toolLine } from "./view";

const ARRIVE = { duration: 0.15, ease: [0.23, 1, 0.32, 1] } as const;

export function Thread({
  items,
  groupOf,
  now,
  zone,
  empty,
}: {
  items: readonly ChatItem[];
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
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pt-3.5 pb-3"
    >
      <ol
        className="m-0 mt-auto flex list-none flex-col gap-3 p-0"
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
              // A message on its way is announced once, when the conversation holds it.
              aria-hidden={item.id.startsWith("sent:") || undefined}
              className="grid max-w-[760px] grid-cols-[92px_minmax(0,1fr)] items-start gap-3"
            >
              <Item item={item} dot={dots.get(item.id) ?? null} groupOf={groupOf} time={rowTime(item.at, now, zone)} />
            </m.li>
          ))}
        </AnimatePresence>
      </ol>
    </section>
  );
}

function Item({
  item,
  dot,
  groupOf,
  time,
}: {
  item: ChatItem;
  dot: Group | null;
  groupOf: (ticket: string) => Group | null;
  time: string;
}) {
  const when = <Time>{time}</Time>;
  switch (item.kind) {
    case "owner":
    case "coordinator":
      return (
        <>
          <span className="pt-1.5 text-right text-body text-text-3">
            {item.kind === "owner" ? "You" : "Coordinator"}
          </span>
          <div
            className={cn(
              "min-w-0 whitespace-pre-wrap break-words rounded-md px-3 py-1.25 text-sub shadow-ring",
              item.kind === "owner" ? "bg-panel-3" : "bg-card",
            )}
          >
            <Text text={item.body} groupOf={groupOf} />
            {when}
          </div>
        </>
      );
    case "line":
      return (
        <>
          <span aria-hidden />
          <div className="min-w-0 py-px text-sub text-text-2" data-line>
            <span
              aria-hidden
              className={cn("mr-2 inline-block size-2 rounded-full align-[1px]", dot ? TONE[dot].bg : "bg-step-done")}
              data-dot={dot ?? "quiet"}
            />
            <Text text={item.body} groupOf={groupOf} />
            {when}
          </div>
        </>
      );
    case "tool": {
      const { args, outcome } = toolLine(item);
      return (
        <>
          <span aria-hidden />
          <details className="group min-w-0 text-body text-text-3" data-tool={item.name}>
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
        </>
      );
    }
  }
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

function Time({ children }: { children: string }) {
  return <span className="ml-2.5 whitespace-nowrap font-mono text-meta text-text-3 tnum">{children}</span>;
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
