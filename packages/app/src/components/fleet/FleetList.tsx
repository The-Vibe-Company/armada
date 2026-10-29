import { AnimatePresence, m } from "motion/react";
import { useRef } from "react";
import {
  type FleetItem,
  GROUP_HINT,
  GROUP_LABEL,
  type Group,
  groupItems,
  LONG_LIST,
  rowTime,
  STEPS,
} from "@/fleet/overview";
import { cn } from "@/lib/utils";

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

/** A row that changed state glides to its group: transform and opacity only, on the theme's ease-out. */
const GLIDE = { duration: 0.2, ease: [0.23, 1, 0.32, 1] } as const;

/**
 * The fleet by state (design/dashboard-v7's overview list): each group's
 * header, then its rows. Headers and rows are siblings of one list, keyed by
 * group and by `project/ticket`, so a row that changes state is the same
 * element moved, and Motion's layout animation glides it there. Nothing moves
 * on the first paint; a row that arrives fades in, one that leaves fades out.
 */
export function FleetList({
  items,
  names,
  now,
  zone,
}: {
  items: readonly FleetItem[];
  /** Each project's name by id. */
  names: ReadonlyMap<string, string>;
  now: number;
  zone: string;
}) {
  const groups = groupItems(items);
  if (!groups.length)
    return (
      <p className="m-0 rounded-card border border-line-strong border-dashed px-4 py-6 text-center text-text-2">
        No agent in flight and nothing merged today.
      </p>
    );
  // A long list lets the browser skip the rows off screen; every row stays in the page.
  const long = items.length > LONG_LIST;
  return (
    <div className="flex min-w-0 flex-col border-line border-t">
      <AnimatePresence initial={false} mode="popLayout">
        {groups.flatMap(({ group, items }) => [
          <m.h2
            key={`group:${group}`}
            id={`fleet-${group}`}
            layout="position"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ ...GLIDE, layout: GLIDE }}
            className="m-0 flex h-8.5 items-center gap-2.5 whitespace-nowrap border-line border-b bg-band px-3 font-semibold text-meta"
          >
            <span aria-hidden className={`size-2 flex-none rounded-full ${TONE[group].bg}`} />
            <span>{GROUP_LABEL[group]}</span>
            <span className="font-mono font-normal text-heading text-text-3 tnum">{items.length}</span>
            {GROUP_HINT[group] && (
              <span className="min-w-0 truncate font-normal text-small text-text-3">{GROUP_HINT[group]}</span>
            )}
          </m.h2>,
          ...items.map((item) => (
            <Row
              key={`row:${item.key}`}
              item={item}
              projectName={names.get(item.project) ?? item.project}
              time={rowTime(item.at, now, zone)}
              long={long}
            />
          )),
        ])}
      </AnimatePresence>
    </div>
  );
}

function Row({
  item: i,
  projectName,
  time,
  long,
}: {
  item: FleetItem;
  projectName: string;
  time: string;
  long: boolean;
}) {
  const tone = TONE[i.group];
  // The row that changed group passes over the others on its way: drawn above them while it glides.
  const settled = useRef(i.group);
  const raise = (el: HTMLElement | null, up: boolean) => {
    if (el) el.style.zIndex = up ? "1" : "";
  };
  const self = useRef<HTMLDivElement>(null);
  return (
    <m.div
      ref={self}
      layout="position"
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
      aria-describedby={`fleet-${i.group}`}
      className={cn(
        "relative grid h-12 grid-cols-[8px_72px_minmax(0,1fr)_96px_64px_48px] items-center gap-3.5 border-line-soft border-b bg-bg px-3",
        long && "[contain-intrinsic-size:auto_48px] [content-visibility:auto]",
      )}
    >
      <span aria-hidden className={`size-2 rounded-full ${tone.bg}`} />
      <span className="truncate font-mono text-small text-text-2">{i.ticket}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-text">{i.title}</span>
        <span data-reason className={`truncate text-small ${QUIET.has(i.group) ? "text-text-2" : tone.text}`}>
          {i.reason}
        </span>
      </span>
      <span className="truncate text-small text-text-2">{projectName}</span>
      <StepBar step={i.step} bg={tone.bg} />
      <span className="text-right font-mono text-heading text-text-3 tnum">{time}</span>
    </m.div>
  );
}

/** The six steps: the done ones grey, the one at work in its state's colour, those to come dark. */
export function StepBar({ step, bg }: { step: number; bg: string }) {
  const label = STEPS[Math.min(step, STEPS.length - 1)];
  return (
    <span role="img" aria-label={`Step: ${label}`} className="flex gap-0.5">
      {STEPS.map((s, k) => (
        <span
          key={s}
          className={`h-1 flex-1 rounded-[1px] ${k < step ? "bg-step-done" : k === step ? bg : "bg-step-next"}`}
        />
      ))}
    </span>
  );
}
