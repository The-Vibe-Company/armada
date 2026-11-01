// The panel's Log (THE-2085): the project's last fleet events, newest first,
// each as its time, its kind and the ticket it concerns, read from the
// bounded history pages and the room's newer live events.
import type { ProtocolEvent } from "@armada/protocol";
import { rowTime } from "@/fleet/overview";
import type { DaemonClient } from "@/protocol/client";
import { HistoryControls, mergeHistory, useHistory } from "@/protocol/history";
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

export function Log({
  events,
  now,
  zone,
  project,
  client,
}: {
  events: readonly ProtocolEvent[];
  now: number;
  zone: string;
  project?: string;
  client?: DaemonClient;
}) {
  const history = useHistory(client, project);
  const merged = mergeHistory(events, history.events).filter(
    (event) =>
      event.kind !== "coordinator.checkpoint" || (event.payload as { checkpoint?: unknown } | null)?.checkpoint != null,
  );
  const newest = history.events.at(-1)?.seq ?? Number.MAX_SAFE_INTEGER;
  const rows = logRows(
    merged,
    Math.max(LOG_ROWS, history.events.length + merged.filter((event) => event.seq > newest).length),
  );
  return (
    <>
      {!rows.length && !history.loading && !history.error && (
        <p className="m-0 px-4 py-3 text-body text-text-3">Nothing recorded yet.</p>
      )}
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
      <HistoryControls history={history} />
    </>
  );
}
