// The agents' rail (THE-1996): a third of the room, slid in from the right,
// the project's agents grouped by state. One row per agent: its triangle,
// id, title cut with an ellipsis, step, last report and time; the day's
// merges compact. A row opens the session's page.
import { m } from "motion/react";
import { TONE } from "@/components/fleet/FleetList";
import { type FleetItem, GROUP_LABEL, GROUPS, type Group, rowTime, STEPS } from "@/fleet/overview";
import type { Harness } from "@/fleet/sky";
import { sessionHref } from "@/lib/route";
import { Ship } from "./Ship";

const EMPTY: Record<Group, string> = {
  blocked: "Nothing is blocked.",
  you: "Nothing waits for you.",
  running: "Nothing in progress.",
  ready: "Nothing is ready to merge.",
  merged: "Nothing merged today.",
};

export const RAIL_ID = "room-agents";
const SLIDE = { duration: 0.2, ease: [0.23, 1, 0.32, 1] } as const;

export function Rail({
  items,
  harnessOf,
  now,
  zone,
  onClose,
}: {
  items: readonly FleetItem[];
  harnessOf: (ticket: string) => Harness | null;
  now: number;
  zone: string;
  onClose: () => void;
}) {
  const flying = items.filter((i) => i.group !== "merged").length;
  const merged = items.length - flying;
  return (
    <m.aside
      id={RAIL_ID}
      aria-label="Agents"
      initial={{ x: "100%" }}
      animate={{ x: 0 }}
      exit={{ x: "100%" }}
      transition={SLIDE}
      className="absolute inset-y-0 right-0 flex w-1/3 min-w-0 flex-col bg-card shadow-[-1px_0_0_var(--color-line)]"
    >
      <div className="flex h-11 flex-none items-center gap-2.5 whitespace-nowrap border-line border-b px-4">
        <span className="font-semibold text-sub">Agents</span>
        <span className="min-w-0 truncate text-body text-text-3">
          {flying} in flight · {merged} merged today
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the agents"
          className="ml-auto inline-flex size-7 cursor-pointer items-center justify-center rounded-sm text-[18px] text-text-3 leading-none hover:bg-panel-3 hover:text-text"
        >
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-2">
        {GROUPS.map((group) => {
          const rows = items.filter((i) => i.group === group);
          return (
            <section key={group} aria-label={GROUP_LABEL[group]} data-rail-group={group}>
              <h2 className="m-0 flex items-center gap-2 px-4 pt-3 pb-1 font-normal text-body text-text-3">
                <span aria-hidden className={`size-2 rounded-full ${TONE[group].bg}`} />
                {GROUP_LABEL[group]}
                <span className="font-medium font-mono text-meta text-text-2 tnum">{rows.length}</span>
              </h2>
              {rows.length === 0 ? (
                <p className="m-0 px-4 pt-1.5 pb-2 text-body text-text-3">{EMPTY[group]}</p>
              ) : (
                rows.map((i) => (
                  <Row key={i.key} item={i} harness={harnessOf(i.ticket)} time={rowTime(i.at, now, zone)} />
                ))
              )}
            </section>
          );
        })}
      </div>
    </m.aside>
  );
}

function Row({ item: i, harness, time }: { item: FleetItem; harness: Harness | null; time: string }) {
  const id = <span className="mr-2 font-mono text-meta text-text-2">{i.ticket}</span>;
  if (i.group === "merged") {
    const pr = i.reason.match(/^#(\d+) merged$/)?.[1];
    return (
      <a
        href={sessionHref(i.ticket)}
        data-rail-row={i.ticket}
        className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2.5 border-line border-b px-4 py-1.5 hover:bg-panel-3"
      >
        <Ship harness={harness} merged />
        <span className="min-w-0 truncate">
          {id}
          <span className="text-body text-text-2">{i.title}</span>
        </span>
        <span className="whitespace-nowrap font-mono text-meta text-text-3 tnum">
          {pr && <span className="text-text-2">#{pr} · </span>}
          {time}
        </span>
      </a>
    );
  }
  return (
    <a
      href={sessionHref(i.ticket)}
      data-rail-row={i.ticket}
      className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2.5 border-line border-b px-4 py-2 hover:bg-panel-3"
    >
      <span className="mt-1">
        <Ship harness={harness} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="min-w-0 truncate">
          {id}
          <span className="text-sub text-text">{i.title}</span>
        </span>
        <span className="mt-px flex justify-between gap-2.5 text-body text-text-3">
          <span className="truncate text-text-2">{STEPS[Math.min(i.step, STEPS.length - 1)]}</span>
          <span className="whitespace-nowrap font-mono text-meta tnum">{time}</span>
        </span>
        <span className="mt-px truncate text-body text-text-3" data-report>
          {i.reason}
        </span>
      </span>
    </a>
  );
}
