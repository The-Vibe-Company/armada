import type { FleetEvent, Ticket } from "@armada/protocol";
import { fold } from "../fold.ts";

export class WorkerTicketScopeRefusal extends Error {
  readonly ticket: string;
  constructor(ticket: string) {
    super(`your capability is for ${ticket}`);
    this.ticket = ticket;
  }
}

export interface WorkerTicketResult {
  ticket: Ticket;
  parent: Pick<Ticket, "id" | "title" | "status"> | null;
  internal: boolean;
}

/** A detached detail from the same log as the fold. Normal snapshots keep their
 * twelve-comment limit; internal workers can read every authored comment. */
export function workerTicket(events: readonly FleetEvent[], project: string, id: string): WorkerTicketResult {
  const history = events.filter((event) => event.project === project);
  const tables = fold(history).projects[project];
  const ticket = tables?.tickets.find((ticket) => ticket.id === id);
  if (!ticket) throw new Error("Worker ticket unavailable");
  const internal = history.some((event) => event.kind === "ticket.created" && event.payload.id === id);
  if (internal) {
    const comments = new Map<string, { body: string; author: string; at: string; seq: number }>();
    let created = false;
    for (const event of history) {
      if (event.kind === "ticket.created" && event.payload.id === id) created = true;
      if (
        created &&
        event.kind === "ticket.commented" &&
        event.payload.ticket === id &&
        !comments.has(event.payload.id)
      )
        comments.set(event.payload.id, { body: event.payload.body, author: event.actor, at: event.at, seq: event.seq });
    }
    ticket.comments = [...comments.values()]
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq)
      .map(({ body, author, at }) => ({ body, author, at }));
  } else {
    // The fold keeps Linear comments newest first. Reverse its source order
    // before the stable timestamp sort so equal instants stay oldest first.
    ticket.comments = [...(ticket.comments ?? [])].reverse().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }
  const parent = tables?.tickets.find((candidate) => candidate.id === ticket.parent);
  return { ticket, parent: parent ? { id: parent.id, title: parent.title, status: parent.status } : null, internal };
}
