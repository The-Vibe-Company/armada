import { AnimatePresence, m } from "motion/react";
import { useRef } from "react";
import { type FleetItem, GROUP_LABEL, GROUPS, type Group, LONG_LIST, rowTime, STEPS } from "@/fleet/overview";
import type { Harness } from "@/fleet/sky";
import { cn } from "@/lib/utils";
import { ticketPrefix } from "@/room/markdown-rules";
import { Ship } from "@/room/Ship";
import { segments } from "@/room/view";
import { sessionHref } from "@/session/route";

/** Each state's colour: its dot, its group's dot, its reason and its step on the bar. */
export const TONE: Record<Group, { text: string; bg: string }> = {
  blocked: { text: "text-red", bg: "bg-red" },
  you: { text: "text-amber", bg: "bg-amber" },
  running: { text: "text-blue", bg: "bg-blue" },
  ready: { text: "text-green", bg: "bg-green" },
  merged: { text: "text-merged", bg: "bg-merged" },
};

/** In progress and merged say their reason quietly; the others in their state's colour (V1). */
const QUIET = new Set<Group>(["running", "merged"]);

const EMPTY: Record<Group, string> = {
  blocked: "Nothing is blocked.",
  you: "Nothing waits for you.",
  running: "Nothing in progress.",
  ready: "Nothing is ready to merge.",
  merged: "Nothing merged today.",
};

/** A group's heading in the room's panel: a pill scrolls to it and gives it the focus. */
export const groupHeadingId = (group: Group) => `agents-${group}`;

/** A row that changed state glides to its group: transform and opacity only, on the theme's ease-out. */
const GLIDE = { duration: 0.2, ease: [0.23, 1, 0.32, 1] } as const;

/**
 * A project's agents by state, the room's panel's Agents tab (THE-2085, the
 * agents' rail of THE-1996 before it): each group's heading, then its rows,
 * one per agent (its triangle, id, title cut with an ellipsis, step, time and
 * last report; the day's merges compact). Headings and rows are siblings of
 * one list, keyed by group and by `project/ticket`, so a row that changes
 * state is the same element moved, and Motion's layout animation glides it
 * there. Nothing moves on the first paint; a row that arrives fades in, one
 * that leaves fades out. A row's title opens the agent (in the room, its page
 * in the lane, THE-2089; elsewhere the session's page), the row shown marked
 * current; the ids its report names link on their own, a ticket to its agent
 * and `#34` to its pull request.
 */
export function FleetList({
  items,
  harnessOf,
  repository,
  prefixes,
  now,
  zone,
  hrefOf = sessionHref,
  current = null,
  onOpen,
}: {
  items: readonly FleetItem[];
  harnessOf: (ticket: string) => Harness | null;
  /** The project's repository: `#34` links to its pull request there. */
  repository: string;
  /** The project's ticket prefixes, space-separated: only their ids link (`UTF-8` stays a word). */
  prefixes: string;
  now: number;
  zone: string;
  /** Where a ticket's row and the report's ids lead: the session's page unless the room says otherwise. */
  hrefOf?: (ticket: string) => string;
  /** The ticket the room's lane shows: its row is marked current. */
  current?: string | null;
  /** Told when a row's title is followed (the room's sheet closes then). */
  onOpen?: (ticket: string) => void;
}) {
  // A long list lets the browser skip the rows off screen; every row stays in the page.
  const long = items.length > LONG_LIST;
  const teams = new Set(prefixes.split(" ").filter(Boolean));
  // Each line's place in the list: Motion measures a heading or a row only when its own place
  // changes, so the list moving as a whole (the question's card above it leaving) glides nothing.
  let place = 0;
  return (
    <div className="flex min-w-0 flex-col pb-2">
      <AnimatePresence initial={false} mode="popLayout">
        {GROUPS.flatMap((group) => {
          const rows = items.filter((i) => i.group === group);
          return [
            <m.h2
              key={`group:${group}`}
              id={groupHeadingId(group)}
              tabIndex={-1}
              data-group-heading={group}
              layout="position"
              layoutDependency={place++}
              transition={{ layout: GLIDE }}
              className="m-0 flex scroll-mt-2 items-center gap-2 px-4 pt-3 pb-1 font-normal text-body text-text-3 outline-offset-[-2px]"
            >
              <span aria-hidden className={`size-2 rounded-full ${TONE[group].bg}`} />
              {GROUP_LABEL[group]}
              <span className="font-medium font-mono text-meta text-text-2 tnum">{rows.length}</span>
            </m.h2>,
            ...(rows.length === 0
              ? [
                  <m.p
                    key={`empty:${group}`}
                    layout="position"
                    layoutDependency={place++}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ ...GLIDE, layout: GLIDE }}
                    className="m-0 px-4 pt-1.5 pb-2 text-body text-text-3"
                  >
                    {EMPTY[group]}
                  </m.p>,
                ]
              : rows.map((item) => (
                  <Row
                    key={`row:${item.key}`}
                    item={item}
                    harness={harnessOf(item.ticket)}
                    time={rowTime(item.at, now, zone)}
                    long={long}
                    place={place++}
                    href={hrefOf(item.ticket)}
                    current={item.ticket === current}
                    onOpen={onOpen}
                    link={(s) =>
                      s.kind === "pr"
                        ? `https://github.com/${repository}/pull/${s.text.slice(1)}`
                        : teams.has(ticketPrefix(s.text))
                          ? hrefOf(s.text)
                          : null
                    }
                  />
                ))),
          ];
        })}
      </AnimatePresence>
    </div>
  );
}

function Row({
  item: i,
  harness,
  time,
  long,
  place,
  href,
  current,
  onOpen,
  link,
}: {
  item: FleetItem;
  harness: Harness | null;
  time: string;
  long: boolean;
  place: number;
  href: string;
  current: boolean;
  onOpen: ((ticket: string) => void) | undefined;
  link: (s: { kind: "ticket" | "pr"; text: string }) => string | null;
}) {
  // The row that changed group passes over the others on its way: drawn above them while it glides.
  const settled = useRef(i.group);
  const raise = (el: HTMLElement | null, up: boolean) => {
    if (el) el.style.zIndex = up ? "1" : "";
  };
  const self = useRef<HTMLDivElement>(null);
  const merged = i.group === "merged";
  const pr = merged ? i.reason.match(/^#(\d+) merged$/)?.[1] : undefined;
  // The title is the row's link, stretched over the whole row; the report's own links sit above it.
  const open = (
    <a
      href={href}
      data-open
      aria-current={current ? "page" : undefined}
      aria-describedby={groupHeadingId(i.group)}
      onClick={onOpen && (() => onOpen(i.ticket))}
      className="min-w-0 truncate outline-none after:absolute after:inset-0 focus-visible:after:shadow-[inset_0_0_0_2px_var(--color-blue)]"
    >
      <span className="mr-2 font-mono text-meta text-text-2">{i.ticket}</span>
      <span className={merged ? "text-body text-text-2" : "text-sub text-text"}>{i.title}</span>
    </a>
  );
  return (
    <m.div
      ref={self}
      layout="position"
      layoutDependency={`${place} ${i.group}`}
      onLayoutAnimationStart={() => raise(self.current, settled.current !== i.group)}
      onLayoutAnimationComplete={() => {
        settled.current = i.group;
        raise(self.current, false);
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ ...GLIDE, layout: GLIDE }}
      data-row={i.key}
      data-group={i.group}
      data-current={current || undefined}
      className={cn(
        "relative grid gap-2.5 border-line border-b px-4",
        current ? "bg-panel-3" : "bg-card hover:bg-panel-3",
        merged
          ? "grid-cols-[16px_minmax(0,1fr)_auto] items-center py-1.5"
          : "grid-cols-[16px_minmax(0,1fr)] items-start py-2",
        long && "[contain-intrinsic-size:auto_64px] [content-visibility:auto]",
      )}
    >
      {merged ? (
        <>
          <Ship harness={harness} merged />
          {open}
          <span className="whitespace-nowrap font-mono text-meta text-text-3 tnum" data-time>
            {pr && <span className="text-text-2">#{pr} · </span>}
            {time}
          </span>
        </>
      ) : (
        <>
          <span className="mt-1">
            <Ship harness={harness} />
          </span>
          <span className="flex min-w-0 flex-col">
            {open}
            <span className="mt-px flex justify-between gap-2.5 text-body text-text-3">
              <span className="truncate text-text-2">{STEPS[Math.min(i.step, STEPS.length - 1)]}</span>
              <span className="whitespace-nowrap font-mono text-meta tnum" data-time>
                {time}
              </span>
            </span>
            <span
              data-reason
              className={cn("mt-px truncate text-body", QUIET.has(i.group) ? "text-text-3" : TONE[i.group].text)}
            >
              <Report text={i.reason} link={link} onTicket={onOpen} />
            </span>
          </span>
        </>
      )}
    </m.div>
  );
}

/** A report with its ids as links, above the row's own link. */
function Report({
  text,
  link,
  onTicket,
}: {
  text: string;
  link: (s: { kind: "ticket" | "pr"; text: string }) => string | null;
  /** Told when a ticket's id is followed, as the row's own link tells it. */
  onTicket: ((ticket: string) => void) | undefined;
}) {
  return (
    <>
      {segments(text).map((s) => {
        const href = s.kind === "text" ? null : link({ kind: s.kind, text: s.text });
        if (!href) return s.text;
        const external = s.kind === "pr";
        return (
          <a
            key={s.at}
            href={href}
            {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
            {...(external ? { "data-pr": s.text } : { "data-ticket": s.text, onClick: () => onTicket?.(s.text) })}
            className="relative z-1 font-mono text-meta underline decoration-current/40 underline-offset-2 hover:decoration-current"
          >
            {s.text}
          </a>
        );
      })}
    </>
  );
}
