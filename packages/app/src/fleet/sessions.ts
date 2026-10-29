import type { ProtocolEvent } from "@armada/protocol";

// The daemon owns its event kinds (packages/protocol README). These are the
// ones its event log names for a session's life in THE-1986 (PR #324, not yet
// on main); any other kind, or a payload of another shape, is ignored. app/fleet
// reads the daemon's kinds in full.
const STARTS = new Set(["session.claimed"]);
const ENDS = new Set(["session.released", "merge.confirmed"]);

function sessionOf(event: ProtocolEvent): string | null {
  const payload = event.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const session = payload.session;
  return typeof session === "string" && session ? session : null;
}

/** How many sessions a project's log has claimed and not yet released or merged: the sidebar's count. */
export function sessionsInFlight(events: readonly ProtocolEvent[]): number {
  const open = new Set<string>();
  for (const event of events) {
    const session = sessionOf(event);
    if (!session) continue;
    if (STARTS.has(event.kind)) open.add(session);
    else if (ENDS.has(event.kind)) open.delete(session);
  }
  return open.size;
}
