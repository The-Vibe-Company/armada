// The Tickets page's rules (THE-2124), pure: a project's tickets in four
// groups, the order of each, and what an edit form sends.
import { GROUP_OF, type Group } from "@/fleet/overview";
import type { FleetState, FoldedSession, FoldedTicket } from "@/fleet/state";

export const READY_LABEL = "ready-for-agent";
export const TICKET_GROUPS = ["ready", "flight", "backlog", "done"] as const;
export type TicketGroup = (typeof TICKET_GROUPS)[number];

export interface TicketRow {
  ticket: FoldedTicket;
  group: TicketGroup;
  /** The session in flight on it: its phase and reason, and the colour of its state. */
  session?: FoldedSession;
  tone?: Group;
}

const ENDED = new Set(["released", "merged"]);
const DONE = new Set(["completed", "canceled"]);

/** A ticket's number (`ABC-12` is 12): the newest are the highest. */
const numberOf = (id: string) => Number(id.match(/-(\d+)$/)?.[1] ?? 0);

export const isReady = (ticket: FoldedTicket) => ticket.labels?.includes(READY_LABEL) ?? false;

/**
 * Each ticket in its group:
 * - in flight: a session that has not ended, or a phase still on the ticket;
 * - done: completed or canceled, newest first (its merge, else its number);
 * - ready to launch: the coordinator's own candidates (coordinator/read.ts): not
 *   started, no phase, the ready label, not parked, not a parent, no open pull
 *   request; and what the launch itself checks of blockers (workers/service.ts):
 *   their evidence read, every one done;
 * - backlog: every other ticket.
 */
export function ticketRows(state: FleetState): Record<TicketGroup, TicketRow[]> {
  const out: Record<TicketGroup, TicketRow[]> = { ready: [], flight: [], backlog: [], done: [] };
  const parents = new Set(state.tickets.flatMap((t) => (t.parent ? [t.parent] : [])));
  const open = new Set(state.pullRequests.filter((p) => p.state === "open").map((p) => p.ticket));
  const merged = new Map<string, number>();
  for (const ticket of state.tickets) {
    const session = state.sessions.findLast((s) => s.ticket === ticket.id);
    if (session && !ENDED.has(session.phase)) {
      out.flight.push({ ticket, group: "flight", session, tone: GROUP_OF[session.state] ?? "running" });
      continue;
    }
    if (ticket.phase && !ENDED.has(ticket.phase)) {
      out.flight.push({ ticket, group: "flight" });
      continue;
    }
    if (ticket.status && DONE.has(ticket.status)) {
      if (session?.phase === "merged") merged.set(ticket.id, Date.parse(session.at) || 0);
      out.done.push({ ticket, group: "done" });
      continue;
    }
    const ready =
      (ticket.status === "unstarted" || ticket.status === "backlog") &&
      !ticket.phase &&
      isReady(ticket) &&
      !ticket.labels?.includes("parked") &&
      !parents.has(ticket.id) &&
      !open.has(ticket.id) &&
      ticket.blockers?.every((b) => DONE.has(b.status)) === true;
    out[ready ? "ready" : "backlog"].push({ ticket, group: ready ? "ready" : "backlog" });
  }
  out.done.sort(
    (a, b) =>
      (merged.get(b.ticket.id) ?? -1) - (merged.get(a.ticket.id) ?? -1) ||
      numberOf(b.ticket.id) - numberOf(a.ticket.id),
  );
  return out;
}

/** The labels a form's field names: separated by commas, trimmed, each once. */
export const labelsOf = (field: string) => [
  ...new Set(
    field
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean),
  ),
];

export interface TicketDraft {
  title: string;
  description: string;
  labels: string;
  parent: string;
  ready: boolean;
}

/** What the new ticket's form sends. */
export function createFields(draft: TicketDraft) {
  const parent = draft.parent.trim();
  return {
    title: draft.title.trim(),
    description: draft.description,
    labels: labelsOf(draft.labels).filter((l) => l !== READY_LABEL),
    ...(parent ? { parent } : {}),
    ...(draft.ready ? { ready: true } : {}),
  };
}

/**
 * What the edit form sends: only what the owner changed since the form opened
 * (`opened`, the ticket then), so a change the coordinator made meanwhile to
 * another field stays; labels as added and removed ones, the ready label untouched.
 */
export function updateFields(opened: FoldedTicket, draft: TicketDraft) {
  const was = draftOf(opened);
  const before = labelsOf(was.labels);
  const after = labelsOf(draft.labels).filter((l) => l !== READY_LABEL);
  const addLabels = after.filter((l) => !before.includes(l));
  const removeLabels = before.filter((l) => !after.includes(l));
  const title = draft.title.trim();
  const parent = draft.parent.trim() || null;
  return {
    ...(title !== was.title.trim() ? { title } : {}),
    ...(draft.description !== was.description ? { description: draft.description } : {}),
    ...(addLabels.length ? { addLabels } : {}),
    ...(removeLabels.length ? { removeLabels } : {}),
    ...(parent !== (was.parent.trim() || null) ? { parent } : {}),
  };
}

/** The edit form's fields, from the ticket as folded. */
export const draftOf = (ticket: FoldedTicket): TicketDraft => ({
  title: ticket.title ?? "",
  description: ticket.description ?? "",
  labels: (ticket.labels ?? []).filter((l) => l !== READY_LABEL).join(", "),
  parent: ticket.parent ?? "",
  ready: isReady(ticket),
});

export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * Sends a write with its request id. The same write (`key`) sent again after
 * the daemon did not answer (the connection dropped) keeps its id, so the
 * daemon replays its first answer rather than write twice; once the daemon
 * answered, a confirmation or a refusal (an error frame, with its code), the
 * next write takes a new one.
 */
export function requestWrites(id: () => string = newId) {
  let held: { key: string; id: string } | null = null;
  return async <T>(key: string, send: (requestId: string) => Promise<T>): Promise<T> => {
    if (held?.key !== key) held = { key, id: id() };
    const sent = held;
    try {
      const reply = await send(sent.id);
      if (held === sent) held = null;
      return reply;
    } catch (error) {
      if (held === sent && (error as { code?: unknown }).code !== undefined) held = null;
      throw error;
    }
  };
}
