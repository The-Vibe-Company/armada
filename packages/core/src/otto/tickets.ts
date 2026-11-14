export interface OttoTicket {
  id: string;
  outcome: string;
  criteria: { use: string; proof: string }[];
  exclusions: string[];
  dependencies: string[];
}
export interface OttoTicketGraph {
  briefRevision: number;
  tickets: OttoTicket[];
}
/** Validate the whole objective-local graph before any durable write. No completion claims are accepted. */
export function validateTicketGraph(value: unknown): OttoTicketGraph {
  const g = value as OttoTicketGraph;
  const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 20000;
  if (
    !g ||
    !Number.isSafeInteger(g.briefRevision) ||
    g.briefRevision < 1 ||
    !Array.isArray(g.tickets) ||
    g.tickets.length < 1 ||
    g.tickets.length > 100
  )
    throw new Error("invalid_graph");
  const ids = new Set<string>();
  for (const t of g.tickets) {
    if (
      !t ||
      !text(t.id) ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(t.id) ||
      ids.has(t.id) ||
      !text(t.outcome) ||
      !Array.isArray(t.criteria) ||
      t.criteria.length < 1 ||
      t.criteria.length > 3 ||
      t.criteria.some((c) => !c || !text(c.use) || !text(c.proof)) ||
      !Array.isArray(t.exclusions) ||
      !t.exclusions.length ||
      !t.exclusions.every(text) ||
      !Array.isArray(t.dependencies) ||
      !t.dependencies.every(text) ||
      new Set(t.dependencies).size !== t.dependencies.length
    )
      throw new Error("invalid_ticket");
    ids.add(t.id);
  }
  const byId = new Map(g.tickets.map((t) => [t.id, t]));
  const visiting = new Set<string>(),
    visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error("cyclic_graph");
    if (visited.has(id)) return;
    const ticket = byId.get(id);
    if (!ticket) throw new Error("cross_objective_dependency");
    visiting.add(id);
    for (const dep of ticket.dependencies) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);
  // Strip untrusted fields (notably claimed state/completion).
  return {
    briefRevision: g.briefRevision,
    tickets: g.tickets.map((t) => ({
      id: t.id,
      outcome: t.outcome,
      criteria: t.criteria.map((c) => ({ use: c.use, proof: c.proof })),
      exclusions: [...t.exclusions],
      dependencies: [...t.dependencies],
    })),
  };
}
/** Trusted server projection, never parsed from submitted graph fields. */
export interface OttoTicketProof {
  ticketId: string;
  criterionIndex: number;
  factId: string;
}
export function ticketStates(graph: OttoTicketGraph, proofs: readonly OttoTicketProof[] = []) {
  const done = new Set(
    graph.tickets
      .filter((ticket) =>
        ticket.criteria.every((_, index) =>
          proofs.some(
            (proof) => proof.ticketId === ticket.id && proof.criterionIndex === index && proof.factId.length > 0,
          ),
        ),
      )
      .map((ticket) => ticket.id),
  );
  return graph.tickets.map((ticket) => ({
    ...ticket,
    state: done.has(ticket.id)
      ? ("done" as const)
      : ticket.dependencies.every((id) => done.has(id))
        ? ("ready" as const)
        : ("blocked" as const),
  }));
}
