import type { FleetEvent, ProjectTables, Ticket } from "@armada/protocol";

const ended = (phase: string) => phase === "merged" || phase === "released";
const line = (text: string, max = 160) => {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
};

/** The coordinator reads a summary; full snapshots belong to ticket.read, never this result. */
export function fleetStatus(tables: ProjectTables, events: FleetEvent[], at: string) {
  const active = tables.sessions.filter((s) => !ended(s.phase));
  const activeTickets = new Set(active.map((s) => s.ticket));
  const parents = new Set(tables.tickets.flatMap((t) => (t.parent ? [t.parent] : [])));
  const open = tables.pullRequests.filter((pr) => pr.state === "open");
  const openTickets = new Set(open.map((pr) => pr.ticket));
  const candidates = tables.tickets.filter(
    (t) =>
      ["unstarted", "backlog"].includes(t.status) &&
      !t.phase &&
      t.labels?.includes("ready-for-agent") &&
      !t.labels.includes("parked") &&
      !parents.has(t.id) &&
      !activeTickets.has(t.id) &&
      !openTickets.has(t.id),
  );
  const byKind: Record<string, number> = {};
  for (const item of tables.inbox) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
  const rules = tables.rules ?? { revision: 0, value: {} };
  const { routing, gates, coordinatorModel, ...value } = rules.value;
  return {
    at,
    readAt: tables.readAt ?? {},
    sessions: active.map((s) => {
      const pr = open.findLast((p) => p.ticket === s.ticket);
      const report = events.findLast(
        (e) => e.kind === "session.reported" && e.payload.ticket === s.ticket && e.payload.session === s.session,
      );
      const lastReport =
        report?.kind === "session.reported"
          ? report.payload.reason
          : s.runtime === "tracker"
            ? tables.tickets.find((t) => t.id === s.ticket)?.reason
            : null;
      const lastAt = Math.max(Date.parse(s.at), s.heartbeat ? Date.parse(s.heartbeat) : 0);
      const age = (Date.parse(at) - lastAt) / 1000;
      return {
        ticket: s.ticket,
        title: line(s.title),
        phase: s.phase,
        step: s.step,
        runtime: line(s.runtime, 80),
        head: pr?.head ?? null,
        checks: pr?.ci ?? null,
        lastReport: lastReport ? line(lastReport) : null,
        ageSeconds: Number.isFinite(age) ? Math.max(0, Math.floor(age)) : null,
      };
    }),
    inbox: { total: tables.inbox.length, byKind },
    frontier: candidates
      .filter((t) => t.blockers?.every((b) => ["completed", "canceled"].includes(b.status)))
      .map((t) => ({ id: t.id, title: line(t.title), blockers: t.blockers })),
    pullRequests: open.map((pr) => ({
      number: pr.number,
      ticket: pr.ticket,
      head: pr.head,
      checks: pr.ci,
      mergeable: !pr.conflicting,
    })),
    holds: tables.holds.map((h) => ({ id: h.id, reason: line(h.reason), at: h.at })),
    rules: {
      revision: rules.revision,
      value: {
        ...value,
        ...(routing ? { routing: routing.map((r) => ("when" in r ? { ...r, when: line(r.when) } : r)) } : {}),
        ...(gates
          ? { gates: { requiredChecks: gates.requiredChecks, localCommandCount: gates.localCommands.length } }
          : {}),
        ...(coordinatorModel
          ? { coordinatorModel: "kind" in coordinatorModel ? { kind: coordinatorModel.kind } : coordinatorModel }
          : {}),
      },
    },
    ...(tables.defaultBranch ? { defaultBranch: tables.defaultBranch } : {}),
    unavailable: [
      ...(candidates.some((t) => t.blockers === undefined) ? ["frontier-blockers"] : []),
      "runtime-observations",
      "jobs",
      ...(tables.defaultBranch ? [] : ["default-branch-health"]),
      "launch-capacity",
    ],
  };
}

/** Match indirect events (answers, queue progress, decisions) to their opening ticket. */
function ticketEvents(events: FleetEvent[]) {
  const tickets = new Map<string, string>();
  return events.map((event) => {
    const p = event.payload;
    let ticket: string | undefined;
    if (event.kind === "ticket.seen") ticket = event.payload.id;
    else if ("ticket" in p) ticket = p.ticket;
    else if ("id" in p) ticket = tickets.get(p.id);
    if (ticket && "id" in p) tickets.set(p.id, ticket);
    return { event, ticket };
  });
}

/** Full ticket data is intentionally fetched one ticket at a time. */
export function ticketRead(tables: ProjectTables, events: FleetEvent[], ticket: Ticket) {
  const parent = tables.tickets.find((t) => t.id === ticket.parent);
  const session = tables.sessions.find((s) => s.ticket === ticket.id) ?? null;
  const reports = new Map<string, { at: string; phase: string; body: string; session: string | null }>();
  for (const e of events) {
    if (e.kind === "session.reported" && e.payload.ticket === ticket.id && e.payload.session === session?.session)
      reports.set(`session:${e.seq}`, {
        at: e.at,
        phase: e.payload.phase,
        body: e.payload.reason,
        session: e.payload.session,
      });
    if (e.kind === "ticket.report-posted" && e.payload.ticket === ticket.id)
      reports.set(`comment:${e.payload.comment}`, {
        at: e.payload.updatedAt,
        phase: e.payload.phase,
        body: e.payload.body,
        session: null,
      });
  }
  return {
    ticket: {
      ...ticket,
      parent: ticket.parent ? { id: ticket.parent, title: parent?.title ?? null } : null,
      comments: ticket.comments?.toSorted((a, b) => b.at.localeCompare(a.at)).slice(0, 12) ?? [],
    },
    session,
    reports: [...reports.values()].sort((a, b) => a.at.localeCompare(b.at)),
  };
}

/** Checkpoints carry private harness storage, not fleet history. Receipts are write internals. */
export function fleetHistory(
  events: FleetEvent[],
  ticket: string | undefined,
  since: string | undefined,
  limit: number,
) {
  const matching = ticketEvents(events).filter(
    ({ event: e, ticket: id }) =>
      e.kind !== "coordinator.checkpoint" &&
      (!ticket || id === ticket) &&
      (!since || Date.parse(e.at) > Date.parse(since)),
  );
  return {
    events: matching.slice(-limit).map(({ event: e }) => {
      const payload = { ...e.payload };
      Reflect.deleteProperty(payload, "receipt");
      if (e.kind === "ticket.seen") {
        Reflect.deleteProperty(payload, "description");
        Reflect.deleteProperty(payload, "comments");
      }
      return { ...e, payload };
    }),
    more: matching.length > limit,
  };
}
