import type { EventInput, FleetEvent, Phase, Ticket } from "../events.ts";
import type { TrackerComment, TrackerReading } from "./types.ts";

const phases: Phase[] = [
  "planning",
  "awaiting-approval",
  "implementing",
  "shipping",
  "blocked",
  "ready-to-merge",
  "awaiting-validation",
  "released",
  "merged",
];
// Adapted from V1 linear.ts parseStatusLine: coordinator notes/answers are not worker reports.
function status(body: string) {
  const first = (body.split("\n").find((line) => line.trim()) ?? "").replace(/[*_`]/g, "");
  const match = /^\s*Agent status\s*:\s*([a-z-]+)\s*(?:[—–-]+\s*(.*))?$/i.exec(first);
  if (!match?.[1]) return null;
  const raw = match[1].toLowerCase();
  const phase = ({ "handed-back": "ready-to-merge", "ci-fixing": "shipping" }[raw] ?? raw) as Phase;
  const summary = match[2]?.trim() ?? "";
  if (!phases.includes(phase)) return null;
  return { phase, summary, coordinator: /^(answer|note)\s*:/i.test(summary) };
}
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Pure translation. History makes cold reads and retries idempotent without a second store. */
export function trackerChanges(project: string, history: readonly FleetEvent[], reading: TrackerReading): EventInput[] {
  const tickets = new Map<string, Ticket>();
  const reports = new Map<string, unknown>();
  const answered = new Set<string>();
  const questions = new Map<string, { ticket: string; body: string }>();
  for (const event of history) {
    if (event.project !== project) continue;
    if (event.kind === "ticket.seen") tickets.set(event.payload.id, event.payload);
    if (event.kind === "ticket.report-posted") reports.set(event.payload.comment, event.payload);
    if (event.kind === "inbox.opened" && event.payload.id.startsWith("linear:"))
      questions.set(event.payload.id, event.payload);
    if (event.kind === "inbox.answered") {
      questions.delete(event.payload.id);
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
    // One question per ticket. A later answer or resumed worker report supersedes it;
    // notes are deliberately excluded, matching V1's coordinator-record rule.
    let pending: TrackerComment | undefined;
    for (const comment of comments) {
      const s = status(comment.body);
      if (!s) continue;
      if (/^answer\s*:/i.test(s.summary) || (!s.coordinator && s.phase !== "blocked")) pending = undefined;
      if (!s.coordinator && s.phase === "blocked" && /^question\s*:/i.test(s.summary)) pending = comment;
    }
    if (phase !== "blocked") pending = undefined;
    const wantedId = pending ? `linear:${pending.id}:${pending.updatedAt}` : undefined;
    for (const [id, question] of questions) {
      if (question.ticket === source.id && id !== wantedId)
        emit("inbox.answered", { id, answer: "Superseded by a later Linear record" }, reading.startedAt);
    }
    if (pending && wantedId && !questions.has(wantedId) && !answered.has(wantedId))
      emit(
        "inbox.opened",
        {
          id: wantedId,
          ticket: source.id,
          kind: "question",
          body: [
            (status(pending.body)?.summary ?? "").replace(/^question\s*:\s*/i, ""),
            ...pending.body.trimStart().split("\n").slice(1),
          ]
            .join("\n")
            .trim(),
        },
        pending.updatedAt,
        pending.author,
      );
    if (!equal(before, ticket)) emit("ticket.seen", ticket, reading.startedAt);
  }
  // Full reads (and ancestry changes) can remove tickets from this program. Keep history,
  // but retire the old tracker session instead of leaving it apparently in flight forever.
  const present = new Set(reading.tickets.map((ticket) => ticket.id));
  for (const [id, ticket] of tickets) {
    if (present.has(id) || ticket.reason === "No longer in tracker scope") continue;
    for (const [key, question] of questions)
      if (question.ticket === id)
        emit("inbox.answered", { id: key, answer: "Ticket left tracker scope" }, reading.startedAt);
    emit(
      "ticket.seen",
      { ...ticket, status: "canceled", phase: "released", reason: "No longer in tracker scope" },
      reading.startedAt,
    );
  }
  return events;
}
