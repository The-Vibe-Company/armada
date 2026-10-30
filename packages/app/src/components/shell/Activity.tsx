// The sidebar's word on each project's coordinator (THE-2054), loaded after
// the first paint: T3 Code's status pill (Working, Awaiting input, Failed)
// and what the coordinator said since the owner last read its room.
import type { ReactNode } from "react";
import type { FleetState } from "@/fleet/state";
import { useProjectsActivity } from "@/room/activity";
import { ownerQuestions, type StatusPill, statusPill, unreadCount } from "@/room/unread";

/** What follows a project's name on its line. */
export type Badges = (project: string, state: FleetState | null) => ReactNode;

/** Reads every project's activity and hands the sidebar its badges; `open` is the room on screen. */
export default function Activity({ open, children }: { open: string | null; children: (badges: Badges) => ReactNode }) {
  const activityOf = useProjectsActivity(open);
  return children((project, state) => {
    const activity = activityOf(project);
    // The room on screen is being read: nothing in it is unread.
    const unread = project === open ? 0 : unreadCount(activity.times, activity.seen);
    const pill = statusPill({
      turn: activity.turn,
      waiting: state ? ownerQuestions(state).length : 0,
      failed: activity.failed,
    });
    return (
      <>
        {pill && <Pill pill={pill} />}
        {unread > 0 && <Unread count={unread} />}
      </>
    );
  });
}

/** The coordinator's state, as T3 Code's sidebar says it: a dot (pulsing while it works) and its word. */
function Pill({ pill }: { pill: StatusPill }) {
  return (
    <span className={`inline-flex flex-none items-center gap-1 text-label ${pill.text}`} data-pill={pill.label}>
      <span
        aria-hidden
        className={`size-1.5 flex-none rounded-full ${pill.dot} ${pill.pulse ? "motion-safe:animate-pulse" : ""}`}
      />
      {pill.label}
    </span>
  );
}

/** What the coordinator said since the owner last read the room. */
function Unread({ count }: { count: number }) {
  return (
    <span
      className="inline-flex h-4 min-w-4 flex-none items-center justify-center rounded-full bg-blue px-1 font-mono text-label text-bg tnum"
      data-unread={count}
    >
      {count}
      <span className="sr-only"> unread</span>
    </span>
  );
}
