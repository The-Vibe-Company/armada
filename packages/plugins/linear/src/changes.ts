import type { EventInput, FleetEvent, Ticket } from "@armada/daemon/events";
import { phaseSchema } from "@armada/protocol";
import type { TrackerComment, TrackerReading } from "./types.ts";

// Adapted from V1 linear.ts parseStatusLine: coordinator notes/answers are not worker reports.
function status(body: string) {
  const first = (body.split("\n").find((line) => line.trim()) ?? "").replace(/[*_`]/g, "");
  const match = /^\s*Agent status\s*:\s*([a-z-]+)\s*(?:[—–-]+\s*(.*))?$/i.exec(first);
  if (!match?.[1]) return null;
  const raw = match[1].toLowerCase();
  const parsed = phaseSchema.safeParse({ "handed-back": "ready-to-merge", "ci-fixing": "shipping" }[raw] ?? raw);
  const summary = match[2]?.trim() ?? "";
  if (!parsed.success) return null;
  const approval = parsed.data === "awaiting-approval" && /^approved[.!]?$/i.test(summary);
  return {
    phase: parsed.data,
    summary,
    approval,
    coordinator:
      /^(answer|note)\s*:/i.test(summary) ||
      approval ||
      /^acceptance: \d+ more runs allowed by the coordinator:/i.test(summary),
  };
}
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Pure translation. History makes cold reads and retries idempotent without a second store. */
export function trackerChanges(project: string, history: readonly FleetEvent[], reading: TrackerReading): EventInput[] {
  const tickets = new Map<string, Ticket>();
  const reports = new Map<string, unknown>();
  const answered = new Set<string>();
  const items = new Map<string, { ticket: string; kind: string; body: string }>();
  const merges = new Map<string, { head: string; pr: number }[]>();
  for (const event of history) {
    if (event.project !== project) continue;
    if (event.kind === "ticket.seen") tickets.set(event.payload.id, event.payload);
    if (event.kind === "ticket.report-posted") reports.set(event.payload.comment, event.payload);
    if (event.kind === "inbox.opened" && event.payload.id.startsWith("linear:"))
      items.set(event.payload.id, event.payload);
    if (event.kind === "merge.confirmed") {
      const confirmed = merges.get(event.payload.ticket) ?? [];
      confirmed.push(event.payload);
      merges.set(event.payload.ticket, confirmed);
    }
    if (event.kind === "inbox.answered") {
      items.delete(event.payload.id);
      answered.add(event.payload.id);
    }
  }
  const events: EventInput[] = [];
  const emit = (kind: EventInput["kind"], payload: unknown, at: string, actor = "Linear") =>
    events.push({ project, kind, payload, at, actor } as EventInput);
  const ordered = [...reading.comments].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  for (const source of reading.tickets) {
    const comments = ordered.filter((comment) => comment.ticket === source.id);
    const worker = comments.filter((comment) => {
      const s = status(comment.body);
      return s && !s.coordinator;
    });
    const latest = worker.at(-1);
    const last = latest ? status(latest.body) : null;
    const phase =
      source.status === "completed"
        ? "merged"
        : source.status === "canceled"
          ? "released"
          : (source.phase ?? last?.phase ?? null);
    const ticket: Ticket = {
      id: source.id,
      title: source.title,
      description: source.description ?? "",
      url: source.url,
      ...(typeof source.branchName === "string" ? { branchName: source.branchName } : {}),
      parent: source.parent,
      ...(source.blockers ? { blockers: source.blockers } : {}),
      comments: comments
        .slice(-12)
        .reverse()
        .map((c) => ({ body: c.body, author: c.author, at: c.updatedAt })),
      labels: source.labels,
      status: source.status,
      phase,
      reason: last?.phase === phase ? last.summary : (phase ?? ""),
      owner: source.owner ?? latest?.author ?? "Linear",
    };
    const before = tickets.get(ticket.id);
    if (before && (before.phase ?? null) !== phase)
      emit("ticket.phase-changed", { ticket: ticket.id, from: before.phase ?? null, to: phase }, reading.startedAt);
    for (const comment of worker) {
      const report = status(comment.body);
      if (!report) continue;
      const payload = {
        ticket: source.id,
        comment: comment.id,
        updatedAt: comment.updatedAt,
        phase: report.phase,
        summary: report.summary,
        body: comment.body,
      };
      if (!equal(reports.get(comment.id), payload))
        emit("ticket.report-posted", payload, comment.updatedAt, comment.author);
    }
    // One item of each kind per ticket. Coordinator records never become worker
    // reports; answers/approvals retire questions and plans without hiding a hand-back.
    type Kind = "question" | "plan" | "hand-back";
    const pending = new Map<Kind, TrackerComment>();
    for (const comment of comments) {
      const s = status(comment.body);
      if (/^approved\b/i.test(comment.body.trimStart()) || s?.approval) pending.delete("plan");
      if (!s) continue;
      if (s.coordinator) {
        if (/^answer\s*:/i.test(s.summary)) {
          pending.delete("question");
          pending.delete("plan");
        }
        continue;
      }
      if (s.phase !== "blocked") pending.delete("question");
      else if (/^question\s*:/i.test(s.summary)) pending.set("question", comment);
      if (s.phase !== "awaiting-approval") pending.delete("plan");
      else if (/^plan\b/i.test(s.summary) || /^## Plan[ \t]*$/m.test(comment.body)) pending.set("plan", comment);
      if (s.phase === "ready-to-merge") pending.set("hand-back", comment);
      else pending.delete("hand-back");
    }
    if (phase !== "blocked") pending.delete("question");
    if (phase !== "awaiting-approval") pending.delete("plan");
    if (phase !== "ready-to-merge") pending.delete("hand-back");
    const handBack = pending.get("hand-back");
    // An external worker may hand back another PR while an older merge is in
    // flight. Only the confirmed PR/head can retire that comment, never its time.
    const handedHead = handBack?.body.match(/\bhead ([0-9a-f]{40})\b/i)?.[1]?.toLowerCase();
    const handedPr = handBack?.body.match(/\bPR #(\d+)/i)?.[1];
    if (
      handedHead &&
      merges
        .get(source.id)
        ?.some((merged) => merged.head === handedHead && (handedPr === undefined || Number(handedPr) === merged.pr))
    )
      pending.delete("hand-back");
    const identity = (comment: TrackerComment) => `linear:${comment.id}:${comment.updatedAt}`;
    const wanted = new Set([...pending.values()].map(identity));
    for (const [id, item] of items) {
      if (item.ticket === source.id && !wanted.has(id))
        emit("inbox.answered", { id, answer: "Superseded by a later Linear record" }, reading.startedAt);
    }
    for (const [kind, comment] of pending) {
      const id = identity(comment);
      if (items.has(id) || answered.has(id)) continue;
      emit(
        "inbox.opened",
        {
          id,
          ticket: source.id,
          kind,
          body:
            kind === "question"
              ? [
                  (status(comment.body)?.summary ?? "").replace(/^question\s*:\s*/i, ""),
                  ...comment.body.trimStart().split("\n").slice(1),
                ]
                  .join("\n")
                  .trim()
              : comment.body,
        },
        comment.updatedAt,
        comment.author,
      );
    }
    if (!equal(before, ticket)) emit("ticket.seen", ticket, reading.startedAt);
  }
  // Full reads (and ancestry changes) can remove tickets from this program. Keep history,
  // but retire the old tracker session instead of leaving it apparently in flight forever.
  const present = new Set(reading.tickets.map((ticket) => ticket.id));
  for (const [id, ticket] of tickets) {
    if (present.has(id) || ticket.reason === "No longer in tracker scope") continue;
    for (const [key, item] of items)
      if (item.ticket === id)
        emit("inbox.answered", { id: key, answer: "Ticket left tracker scope" }, reading.startedAt);
    emit(
      "ticket.seen",
      { ...ticket, status: "canceled", phase: "released", reason: "No longer in tracker scope" },
      reading.startedAt,
    );
  }
  return events;
}
