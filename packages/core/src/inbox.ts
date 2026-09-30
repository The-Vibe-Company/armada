// Questions between workers and the coordinator. A worker asks (`armada ask`):
// its phase becomes blocked and the question lands in the coordinator's inbox.
// The coordinator reads the inbox (`armada inbox`), delivers the answer in the
// worker's session through the runtime guide, then records it (`armada answer`).
// Armada never calls a runtime: these commands only record.
import { NEEDS_HUMAN } from "./fleet.ts";
import {
  addInboxItem,
  type Db,
  ensureProject,
  getInboxItem,
  getRuntimeHandle,
  type InboxKind,
  lastAnsweredAt,
  latestEvents,
  openInboxItems,
  openRuntimeHandles,
  recordCoordinatorSeen,
  redact,
  resolveInboxItem,
  resolveInboxItems,
} from "./turso.ts";
import type { AgentPhase } from "./types.ts";
import { live, type Outcome, projectOf, Refusal, reportPhase, type WorkerContext } from "./worker.ts";

const MIN = 60_000;

// ------------------------------------------------------------------ ask

export interface AskInput {
  ticket: string;
  /** First line becomes the status summary; the rest is the detail. */
  question: string;
  /** The choices the worker sees, shown numbered. */
  options?: readonly string[];
}

/** The question as stored in the inbox: the text, then the numbered options. */
export function questionBody(question: string, options: readonly string[] = []): string {
  const listed = options.map((o) => o.trim()).filter(Boolean);
  const text = question.trim();
  return listed.length ? `${text}\n\nOptions:\n${listed.map((o, k) => `${k + 1}. ${o}`).join("\n")}` : text;
}

/**
 * A worker asks the coordinator: the phase goes to blocked with an
 * `Agent status: blocked — question: …` comment (Linear, the record), then the
 * question is added to the coordinator's inbox (Turso). `item` is its id, or
 * null when Turso did not record it.
 */
export async function askCoordinator(ctx: WorkerContext, input: AskInput): Promise<Outcome & { item: number | null }> {
  if (!input.question.trim())
    throw new Refusal(
      "the question is empty: say what you need decided",
      'armada ask "<question, the options, your recommendation>"',
    );
  const body = questionBody(input.question, input.options);
  const out = await reportPhase(ctx, { ticket: input.ticket, phase: "blocked", message: `question: ${body}` });
  const project = ctx.config.project.slug;
  const item = await live(ctx, out.warnings, "put the question in the coordinator's inbox", async (db) => {
    const held = await getRuntimeHandle(db, project, out.ticket);
    return addInboxItem(db, {
      project,
      ticket: out.ticket,
      kind: "question",
      recipient: "coordinator",
      author: held && !held.releasedAt ? held.handle : null,
      body,
      at: ctx.now(),
    });
  });
  const lines = [
    ...out.lines,
    item === null
      ? "The question is on the ticket only: the coordinator sees the blocked phase in `armada status`."
      : `Question #${item} is in the coordinator's inbox.`,
    "Stop here and wait for the answer in this session; then report the phase you resume.",
  ];
  return { ...out, lines, warnings: [...new Set(out.warnings)], item };
}

// ------------------------------------------------------------------ inbox

export type InboxEntryKind = InboxKind | "silent";

export interface InboxEntry {
  /** Inbox item id for `armada answer`; null for a silent worker (it clears when the worker reports). */
  id: number | null;
  kind: InboxEntryKind;
  ticket: string | null;
  /** Runtime handle of the worker that asked, or of the silent worker. */
  author: string | null;
  body: string;
  /** When the item was added; for a silent worker, its last report. */
  createdAt: string;
  /** Appeared while `armada inbox --wait` was waiting. */
  new: boolean;
}

export interface InboxReport {
  project: string;
  generatedAt: string;
  /** Oldest first. */
  items: InboxEntry[];
  /** Set by --wait: how long it waited at most, and whether it stopped on the timeout. */
  wait: { timeoutSeconds: number; timedOut: boolean } | null;
  /** Problems that did not stop the read, such as a presence that could not be recorded. */
  warnings: string[];
}

export interface InboxOptions {
  project: string;
  /** `policy.silence_minutes`. */
  silentAfterMinutes: number;
  now: () => Date;
}

const entryKey = (e: InboxEntry) => (e.id === null ? `silent:${e.ticket}` : `#${e.id}`);

/**
 * What waits for the coordinator, oldest first: open questions, requests and
 * hand-backs, and silent workers. A worker is silent when it holds a ticket
 * (open runtime handle), its newest event is older than the silence threshold,
 * and its phase does not wait on someone else (awaiting-approval, blocked,
 * ready-to-merge). An answer given after its newest event means it owes a
 * report: silence then counts from the answer, whatever the phase. Read from
 * Turso only, so it is cheap enough to poll.
 */
export async function readInbox(db: Db, o: InboxOptions): Promise<InboxEntry[]> {
  const now = o.now().getTime();
  const [items, handles, events, answered] = await Promise.all([
    openInboxItems(db, { project: o.project, recipient: "coordinator" }),
    openRuntimeHandles(db, o.project),
    latestEvents(db, o.project),
    lastAnsweredAt(db, o.project),
  ]);
  const entries: InboxEntry[] = items.map((i) => ({
    id: i.id,
    kind: i.kind,
    ticket: i.ticket,
    author: i.author,
    body: i.body,
    createdAt: i.createdAt,
    new: false,
  }));
  const asking = new Set(items.filter((i) => i.kind === "question").map((i) => i.ticket));
  for (const h of handles) {
    const e = events[h.ticket];
    if (e && (e.kind === "release" || e.kind === "merge")) continue;
    if (asking.has(h.ticket)) continue;
    const reported = e?.at ?? h.claimedAt;
    const answer = answered[h.ticket];
    const owesReport = !!answer && answer > reported;
    if (!owesReport && NEEDS_HUMAN.includes(e?.phase as AgentPhase)) continue;
    const last = owesReport ? answer : reported;
    const quiet = now - Date.parse(last);
    if (quiet <= o.silentAfterMinutes * MIN) continue;
    entries.push({
      id: null,
      kind: "silent",
      ticket: h.ticket,
      author: h.handle,
      body: `no report for ${Math.floor(quiet / MIN)} min${owesReport ? " since its question was answered" : ""} (phase ${e?.phase ?? "unknown"}, ${h.runtime} ${h.handle}); check it with the runtime guide's status section`,
      createdAt: last,
      new: false,
    });
  }
  return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id ?? 0) - (b.id ?? 0));
}

export interface WaitOptions {
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  /** How often Turso is read while waiting. */
  pollMs?: number;
}

/** While waiting, the coordinator's presence is refreshed at most this often. */
export const PRESENCE_EVERY_MS = MIN;
export const INBOX_POLL_MS = 5_000;

/**
 * Reads the inbox and records the coordinator's presence for the dashboard.
 * With `wait`, it returns as soon as an item that was not there at the
 * previous read appears (marked `new`), or at the timeout.
 */
export async function checkInbox(
  db: Db,
  o: InboxOptions & { coordinator?: string | null; wait?: WaitOptions },
): Promise<InboxReport> {
  const started = o.now();
  const warnings: string[] = [];
  // The dashboard's view of the coordinator is a nicety: the inbox is read even if it cannot be written.
  const seen = (at: Date) =>
    recordCoordinatorSeen(db, { project: o.project, handle: o.coordinator ?? null, at }).catch((err: unknown) => {
      const w = `could not record the coordinator's presence (${redact(err)})`;
      if (!warnings.includes(w)) warnings.push(w);
    });
  await seen(started);
  let items = await readInbox(db, o);
  const report = (timedOut: boolean | null): InboxReport => ({
    project: o.project,
    generatedAt: o.now().toISOString(),
    items,
    wait: o.wait && timedOut !== null ? { timeoutSeconds: Math.round(o.wait.timeoutMs / 1000), timedOut } : null,
    warnings,
  });
  if (!o.wait) return report(null);
  const { sleep, timeoutMs, pollMs = INBOX_POLL_MS } = o.wait;
  let known = new Set(items.map(entryKey));
  let lastSeen = started.getTime();
  for (;;) {
    const left = timeoutMs - (o.now().getTime() - started.getTime());
    if (left <= 0) return report(true);
    await sleep(Math.min(pollMs, left));
    const at = o.now();
    if (at.getTime() - lastSeen >= PRESENCE_EVERY_MS) {
      await seen(at);
      lastSeen = at.getTime();
    }
    items = (await readInbox(db, o)).map((e) => ({ ...e, new: !known.has(entryKey(e)) }));
    if (items.some((e) => e.new)) return report(false);
    known = new Set(items.map(entryKey));
  }
}

// ------------------------------------------------------------------ answer

export interface AnswerInput {
  /** An inbox item id (`12` or `#12`), or a ticket id: its open questions. With `note`, a ticket id. */
  target: string;
  /** The answer, or the note. First line becomes the status summary. */
  text: string;
  /** An unsolicited coordinator message (main moved, rebase needed) rather than an answer. */
  note?: boolean;
}

const ITEM_ID = /^#?(\d+)$/;

function statusComment(phase: AgentPhase, word: "answer" | "note", text: string, ref: string | null): string {
  const [first = "", ...rest] = text.trim().split("\n");
  const detail = [rest.join("\n").trim(), ref ?? ""].filter(Boolean).join("\n\n");
  const line = `Agent status: ${phase} — ${word}: ${first.trim()}`;
  return detail ? `${line}\n\n${detail}` : line;
}

/**
 * Records a coordinator's answer or note. It never calls a runtime: deliver it
 * in the worker's session with the runtime guide first. An answer resolves the
 * question in Turso and posts `Agent status: <phase> — answer: …` on the ticket;
 * the worker's phase stays as it is until the worker reports the one it resumes.
 */
export async function answerItem(ctx: WorkerContext, input: AnswerInput): Promise<Outcome> {
  const { config, linear } = ctx;
  const project = config.project.slug;
  const text = input.text.trim();
  if (!text)
    throw new Refusal(
      `the ${input.note ? "note" : "answer"} is empty`,
      input.note
        ? `armada answer --note ${input.target.trim()} "<message>"`
        : `armada answer ${input.target.trim()} "<answer>"`,
    );
  const idMatch = input.target.trim().match(ITEM_ID);
  if (input.note && idMatch)
    throw new Refusal("a note goes to a ticket, not to an inbox item", 'armada answer --note <ticket> "<message>"');
  const warnings: string[] = [];
  const lines: string[] = [];

  // Every read that can refuse happens before the first write.
  let itemId: number | null = null;
  let ticketId: string | null = null;
  if (idMatch) {
    itemId = Number(idMatch[1]);
    const item = await live(ctx, warnings, `read inbox item #${itemId}`, (db) =>
      getInboxItem(db, project, itemId ?? 0),
    );
    if (!item)
      throw new Refusal(
        warnings.length
          ? `inbox item #${itemId} cannot be read (${warnings.join("; ")})`
          : `inbox item #${itemId} does not exist in project ${project}`,
        warnings.length ? 'armada answer <ticket> "<answer>", to answer by ticket instead' : "armada inbox",
      );
    if (item.resolvedAt)
      throw new Refusal(`inbox item #${itemId} was already resolved at ${item.resolvedAt}`, "armada inbox");
    if (item.kind === "hand-back")
      throw new Refusal(
        `inbox item #${itemId} is a hand-back: armada merge resolves it once the pull request is merged`,
        `armada merge <pr>${item.ticket ? ` --ticket ${item.ticket}` : ""} --dry-run`,
      );
    if (item.recipient !== "coordinator" || (item.kind !== "question" && item.kind !== "request"))
      throw new Refusal(
        `inbox item #${itemId} is a ${item.kind} for the ${item.recipient}, not something to answer`,
        "armada inbox",
      );
    ticketId = item.ticket;
  } else {
    ticketId = input.target.trim().toUpperCase();
    if (!input.note) {
      const open = await live(ctx, warnings, `read the open questions of ${ticketId}`, (db) =>
        openInboxItems(db, { project, recipient: "coordinator", ticket: ticketId ?? "" }),
      );
      if (open && !open.some((i) => i.kind === "question"))
        throw new Refusal(
          `${ticketId} has no open question in the inbox`,
          `armada answer --note ${ticketId} "<message>", for an unsolicited message`,
        );
    }
  }

  let url = "";
  if (ticketId) {
    const ticket = await linear.readTicket(ticketId);
    if (!ticket) throw new Refusal(`ticket ${ticketId} not found in Linear`, "armada inbox");
    url = ticket.url;
    warnings.push(...ticket.warnings);
    if (!ticket.agentPhase) {
      if (input.note)
        throw new Refusal(
          `${ticket.id} has no agent phase: no worker holds it, so there is no one to tell`,
          "armada status, to see which tickets are in flight",
        );
      warnings.push(`${ticket.id} has no agent phase (no worker holds it); the answer was not posted on the ticket`);
    } else {
      const ref = itemId === null ? null : `Answers question #${itemId}.`;
      await linear.comment(ticket.uuid, statusComment(ticket.agentPhase, input.note ? "note" : "answer", text, ref));
      lines.push(`${input.note ? "Note" : "Answer"} posted on ${ticket.id} (${ticket.agentPhase}).`);
    }
  }

  const at = ctx.now();
  const recorded = await live(ctx, warnings, `record the ${input.note ? "note" : "answer"}`, async (db) => {
    await ensureProject(db, projectOf(config), at);
    if (input.note) {
      const id = await addInboxItem(db, {
        project,
        ticket: ticketId,
        kind: "note",
        recipient: "worker",
        author: "coordinator",
        body: text,
        at,
      });
      await resolveInboxItem(db, { project, id, resolution: "delivered through the runtime", at });
      return `Note #${id} recorded.`;
    }
    if (itemId !== null) {
      const done = await resolveInboxItem(db, { project, id: itemId, resolution: text, at });
      return done ? `Inbox item #${itemId} resolved.` : `Inbox item #${itemId} was already resolved.`;
    }
    const n = await resolveInboxItems(db, { project, ticket: ticketId ?? "", kind: "question", resolution: text, at });
    return `${n} open question${n === 1 ? "" : "s"} of ${ticketId} resolved.`;
  });
  if (recorded) lines.push(recorded);
  if (!input.note) lines.push("The worker resumes once it reports its phase again.");
  return { ticket: ticketId ?? `#${itemId}`, url, lines, warnings: [...new Set(warnings)], inbox: null };
}
