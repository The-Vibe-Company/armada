// The panel's Log (THE-2085): the project's last fleet events, newest first,
// each as its time, its kind and the ticket it concerns, read from the
// subscription the room already holds (the client's log of the project).
import type { ProtocolEvent } from "@armada/protocol";
import { rowTime } from "@/fleet/overview";
import { sessionHref } from "@/session/route";

const LOG_ROWS = 50;

interface LogRow {
  seq: number;
  at: string;
  kind: string;
  ticket: string | null;
}

/** The last `n` events, newest first, with the ticket each one names. */
function logRows(events: readonly ProtocolEvent[], n = LOG_ROWS): LogRow[] {
  return events
    .slice(-n)
    .reverse()
    .map((e) => {
      const payload = e.payload && typeof e.payload === "object" && !Array.isArray(e.payload) ? e.payload : {};
      // A ticket's own events carry it whole: its id is the ticket.
      const named = e.kind.startsWith("ticket.") ? payload.id : payload.ticket;
      const ticket = typeof named === "string" ? named : null;
      return { seq: e.seq, at: e.at, kind: e.kind, ticket };
    });
}

export function Log({ events, now, zone }: { events: readonly ProtocolEvent[]; now: number; zone: string }) {
  const rows = logRows(events);
  if (!rows.length) return <p className="m-0 px-4 py-3 text-body text-text-3">Nothing recorded yet.</p>;
  return (
    <ol aria-label="The project's last events" className="m-0 list-none p-0 pb-2">
      {rows.map((r) => (
        <li
          key={r.seq}
          data-event={r.seq}
          className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap border-line border-b px-4 py-1.5 text-body text-text-2"
        >
          <time dateTime={r.at} title={r.at} className="flex-none font-mono text-meta text-text-3 tnum">
            {rowTime(r.at, now, zone)}
          </time>
          <span aria-hidden className="text-text-3">
            ·
          </span>
          <span className="min-w-0 truncate font-mono text-meta text-text">{r.kind}</span>
          {r.ticket && (
            <>
              <span aria-hidden className="text-text-3">
                ·
              </span>
              <a href={sessionHref(r.ticket)} className="flex-none font-mono text-meta text-text-2 hover:text-text">
                {r.ticket}
              </a>
            </>
          )}
        </li>
      ))}
    </ol>
  );
}
