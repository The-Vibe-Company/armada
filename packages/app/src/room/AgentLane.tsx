// An agent's page in the room's lane (THE-2089), after T3 Code's thread view
// swapping under a sidebar that keeps its place: the session page's content
// (THE-2028, THE-2045) at the lane's full width, in place of the chat, while
// the panel stays open beside it. Its first line goes back to the chat; then
// the state card and its buttons, the six steps, the facts, the reports and
// events, and the session's full page at the end. A session that hands back
// or is released stays on screen in its new state.
import type { Project, ProtocolEvent } from "@armada/protocol";
import { type RefObject, useEffect, useMemo } from "react";
import { Dot } from "@/components/page";
import type { FleetState } from "@/fleet/state";
import { Facts } from "@/session/Facts";
import { Reports } from "@/session/Reports";
import { sessionHref } from "@/session/route";
import { StateCard } from "@/session/StateCard";
import { Steps } from "@/session/Steps";
import { findSession, stamp } from "@/session/view";

export function AgentLane({
  project,
  ticket,
  state,
  events,
  chatHref,
  now,
  zone,
  read,
  lane,
}: {
  project: Project;
  ticket: string;
  state: FleetState;
  events: readonly ProtocolEvent[];
  /** The room's chat, the panel kept as it is. */
  chatHref: string;
  now: number;
  zone: string;
  /** Whether the project's log is read: until then the session may only be unknown yet. */
  read: boolean;
  /** The lane itself: the room's keys hear the focus in it. */
  lane: RefObject<HTMLElement | null>;
}) {
  // The next agent's page opens at its top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per agent the lane shows.
  useEffect(() => {
    lane.current?.scrollTo?.(0, 0);
  }, [ticket]);
  const view = useMemo(
    () => findSession(ticket, [project], () => ({ state, events })),
    [ticket, project, state, events],
  );
  const at = (time: string | null) => (time ? stamp(time, now, zone) : "");
  // The session's latest event: an open output drawer reads the runtime again on each one.
  const tick = events.findLast((e) => (e.payload as { ticket?: unknown } | null)?.ticket === ticket)?.seq ?? 0;
  return (
    <section
      ref={lane}
      aria-label={view ? `${ticket}: ${view.title}` : ticket}
      data-agent-lane={ticket}
      // A click anywhere in the lane keeps the focus in it, so its keys still hop between agents.
      tabIndex={-1}
      className="absolute inset-0 z-10 overflow-y-auto overflow-x-hidden bg-bg outline-none"
    >
      {/* One agent's content: hopping to the next starts its card's actions afresh, the lane keeps the focus. */}
      <div key={ticket} className="flex min-w-0 flex-col gap-5.5 px-8 pt-5 pb-14">
        <header className="flex min-w-0 items-center gap-2 text-body text-text-2">
          <a href={chatHref} data-chat className="flex-none text-text-2 hover:text-text">
            ← Coordinator
          </a>
          <Dot />
          <span className="flex-none font-mono text-meta text-text">{ticket}</span>
          {view && (
            <>
              <Dot />
              <h2 className="m-0 min-w-0 truncate font-medium text-sub text-text" title={view.title}>
                {view.title}
              </h2>
            </>
          )}
        </header>
        {view ? (
          <>
            <StateCard view={view} at={at} tick={tick} />
            <Steps step={view.step} group={view.group} />
            <div data-facts className="flex min-w-0 flex-wrap items-center gap-2 text-body text-text-2">
              <Facts facts={view.facts} at={at} />
            </div>
            <section aria-label="Reports and events" className="flex min-w-0 flex-col">
              <h3 className="m-0 flex items-center gap-1.5 border-line border-b pb-2 font-medium text-body text-text-3">
                Reports and events
                <span className="font-mono text-text-3 tnum">{view.entries.length}</span>
              </h3>
              <Reports entries={view.entries} at={at} />
            </section>
          </>
        ) : (
          <p className="m-0 text-sub text-text-2">
            {read ? `${project.name} has no session on ${ticket}.` : "Reading the project's log."}
          </p>
        )}
        <a href={sessionHref(ticket)} data-full-page className="self-start text-body text-text-2 hover:text-text">
          Open full page →
        </a>
      </div>
    </section>
  );
}
