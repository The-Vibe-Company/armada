// Questions between workers and the coordinator. A worker asks (`armada ask`):
// its phase becomes blocked and the question lands in the coordinator's inbox.
// The coordinator reads the inbox (`armada inbox`), delivers the answer in the
// worker's session through the runtime guide, then records it (`armada answer`).
// Runtime delivery is injected by the CLI; other runtimes use their guide.
import { entryKey, type Fleet, handBackPr, type InboxEntry, type InboxKind, type StoredInboxItem } from "./live.ts";
import type { AgentPhase } from "./types.ts";
import { live, type Outcome, Refusal, reportPhase, type WorkerContext } from "./worker.ts";

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
 * question is added to the coordinator's inbox, through Armada. `item` is its
 * id, or null when it could not be recorded.
 */
export async function askCoordinator(ctx: WorkerContext, input: AskInput): Promise<Outcome & { item: number | null }> {
  if (!input.question.trim())
    throw new Refusal(
      "the question is empty: say what you need decided",
      'armada ask "<question, the options, your recommendation>"',
    );
  const body = questionBody(input.question, input.options);
  const out = await reportPhase(ctx, { ticket: input.ticket, phase: "blocked", message: `question: ${body}` });
  const item = await live(ctx, out.warnings, "put the question in the coordinator's inbox", (fleet) =>
    fleet.ask({ ticket: out.ticket, body }),
  );
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

export interface InboxReport {
  project: string;
  generatedAt: string;
  /** Oldest first. */
  items: InboxEntry[];
  /** Tickets a worker holds, the coordinator's own excluded; null when Armada did not say. */
  inFlight: string[] | null;
  /** Set by --wait: how long it waited at most, and whether it stopped on the timeout. */
  wait: { timeoutSeconds: number; timedOut: boolean } | null;
  /** Problems that did not stop the read, such as a presence that could not be recorded. */
  warnings: string[];
}

export interface InboxOptions {
  facts?: import("./live.ts").CoordinatorFacts;
  project: string;
  coordinator?: string | null;
  /** `policy.silence_minutes`. */
  silentAfterMinutes: number;
  quietAfterMinutes?: number;
  /** `policy.not_started_minutes`. */
  notStartedMinutes?: number;
  now: () => Date;
  /** Wait at most `timeoutMs` for a new item, asking Armada every `pollMs`. */
  wait?: { timeoutMs: number; sleep: (ms: number) => Promise<void>; pollMs?: number };
}

/**
 * How often `armada inbox --wait` asks Armada. Each ask is one short request
 * that Armada answers "not modified" while the inbox is unchanged: nothing
 * holds a server function open between two asks.
 */
export const INBOX_POLL_MS = 15_000;

/**
 * Reads the coordinator's inbox through Armada, which records the
 * coordinator's presence for the dashboard. With `wait`, it asks again every
 * `INBOX_POLL_MS` and returns as soon as an item that was not there at the
 * previous read appears (marked `new`), or at the timeout.
 */
export async function checkInbox(fleet: Fleet, o: InboxOptions): Promise<InboxReport> {
  const started = o.now();
  const query = {
    coordinator: o.coordinator ?? null,
    silentAfterMinutes: o.silentAfterMinutes,
    quietAfterMinutes: o.quietAfterMinutes,
    ...(o.facts ? { facts: o.facts } : {}),
    ...(o.notStartedMinutes !== undefined ? { notStartedMinutes: o.notStartedMinutes } : {}),
  };
  const first = await fleet.inbox({ ...query, etag: null });
  if (!first) throw new Error("Armada answered the first inbox read with nothing");
  const warnings = [...first.warnings];
  let items = first.items;
  let inFlight = first.inFlight ?? null;
  let etag = first.etag;
  const report = (timedOut: boolean | null): InboxReport => ({
    project: o.project,
    generatedAt: o.now().toISOString(),
    items,
    inFlight,
    wait: o.wait && timedOut !== null ? { timeoutSeconds: Math.round(o.wait.timeoutMs / 1000), timedOut } : null,
    warnings: [...new Set(warnings)],
  });
  if (!o.wait) return report(null);
  const { sleep, timeoutMs, pollMs = INBOX_POLL_MS } = o.wait;
  for (;;) {
    const left = timeoutMs - (o.now().getTime() - started.getTime());
    if (left <= 0) return report(true);
    await sleep(Math.min(pollMs, left));
    const read = await fleet.inbox({ ...query, etag });
    if (!read) continue;
    const known = new Set(items.map(entryKey));
    items = read.items.map((e) => ({ ...e, new: !known.has(entryKey(e)) }));
    inFlight = read.inFlight ?? null;
    etag = read.etag;
    warnings.push(...read.warnings);
    if (items.some((e) => e.new)) return report(false);
  }
}

// ------------------------------------------------------------------ answer

export interface AnswerInput {
  /** An inbox item id (`12` or `#12`), or a ticket id: its open questions and plans. With `note`, a ticket or plan id. */
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

const ANSWERABLE: InboxKind[] = [
  "question",
  "plan",
  "request",
  "answer-request",
  "launch-request",
  "merge-request",
  "release-request",
  "plan-changes",
  "decision",
];

/**
 * Records a coordinator's answer or note after optional injected runtime delivery.
 * Other runtimes are delivered with the runtime guide first. An answer resolves the
 * question or plan in the inbox and posts `Agent status: <phase> — answer: …` on the ticket;
 * the worker's phase stays as it is until the worker reports the one it resumes.
 * An answer-request from the dashboard resolves with its question or plan, and the
 * comment names who asked. A launch-request answered here is declined: the
 * worker's claim is what resolves a launch that happened.
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
  const warnings: string[] = [];
  const lines: string[] = [];

  // Every read that can refuse happens before the first write.
  let item: StoredInboxItem | null = null;
  let itemId: number | null = null;
  let ticketId: string | null = null;
  if (idMatch) {
    itemId = Number(idMatch[1]);
    item = await live(ctx, warnings, `read inbox item #${itemId}`, (fleet) => fleet.inboxItem(itemId ?? 0));
    if (input.note && item?.kind !== "plan")
      throw new Refusal(
        "a note goes to a ticket or a plan, not to another inbox item",
        'armada answer --note <ticket> "<message>"',
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
    if (item.kind === "hand-back" && item.recipient === "coordinator") return answerHandBack(ctx, item, text, warnings);
    if (item.recipient !== "coordinator" || !ANSWERABLE.includes(item.kind))
      throw new Refusal(
        `inbox item #${itemId} is a ${item.kind} for the ${item.recipient}, not something to answer`,
        "armada inbox",
      );
    ticketId = item.ticket;
  } else {
    ticketId = input.target.trim().toUpperCase();
    if (!input.note) {
      const open = await live(ctx, warnings, `read the open questions of ${ticketId}`, (fleet) =>
        fleet.ticketItems(ticketId ?? ""),
      );
      const handle =
        open && !open.some((i) => i.kind === "question" || i.kind === "plan")
          ? await live(ctx, warnings, `read the runtime of ${ticketId}`, (fleet) => fleet.runtimeHandle(ticketId ?? ""))
          : null;
      const observation = handle?.runtimeState;
      const runtimeBlocked =
        ctx.deliverAnswer &&
        handle?.runtime.toLowerCase() === "herdr" &&
        !handle.releasedAt &&
        observation?.state === "blocked" &&
        Date.parse(observation.at) <= ctx.now().getTime() &&
        ctx.now().getTime() - Date.parse(observation.at) <= config.policy.silentAfterMinutes * 60_000;
      if (open && !open.some((i) => i.kind === "question" || i.kind === "plan") && !runtimeBlocked)
        throw new Refusal(
          `${ticketId} has no open question or plan in the inbox`,
          `armada answer --note ${ticketId} "<message>", for an unsolicited message`,
        );
    }
  }

  if (item?.kind === "launch-request") return declineLaunch(ctx, item, text, warnings);
  // The owner's requests and decisions (THE-885) are carried out, then recorded; nothing is posted on the ticket.
  if (item && ["merge-request", "release-request", "plan-changes", "decision"].includes(item.kind)) {
    const recorded = await live(ctx, warnings, "resolve the dashboard request", (fleet) =>
      fleet.answer({ text, note: false, ticket: item.ticket, item: item.id }),
    );
    return { ticket: item.ticket ?? `#${item.id}`, url: "", lines: recorded ? [recorded] : [], warnings, inbox: null };
  }

  // The question an answer-request answers; the answer-request itself is resolved with it.
  const question = item?.kind === "answer-request" ? (item.request?.question ?? null) : null;
  const answered =
    question === null
      ? item
      : await live(ctx, warnings, `read the item answered by #${item?.id}`, (fleet) => fleet.inboxItem(question));
  const answerKind = answered?.kind === "plan" ? "plan" : "question";
  // Freeze the claim generation before tracker reads or terminal delivery.
  const claim =
    ticketId && ctx.deliverAnswer
      ? await live(ctx, warnings, `read the claim of ${ticketId}`, (fleet) => fleet.runtimeHandle(ticketId))
      : null;
  if (claim?.runtime.toLowerCase() === "herdr" && claim.releasedAt)
    throw new Refusal("the herdr worker has ended; no answer was delivered", "armada inbox");
  if (claim?.runtime.toLowerCase() === "herdr" && answered && answered.createdAt < claim.claimedAt)
    throw new Refusal("the question belongs to an earlier worker claim; no answer was delivered", "armada inbox");
  let url = "";
  if (ticketId) {
    const ticket = await linear.readTicket(ticketId);
    if (!ticket) throw new Refusal(`ticket ${ticketId} not found in Linear`, "armada inbox");
    url = ticket.url;
    warnings.push(...ticket.warnings);
    const herdrClaim = claim?.runtime.toLowerCase() === "herdr" && !claim.releasedAt;
    if (!ticket.agentPhase && !herdrClaim) {
      if (input.note)
        throw new Refusal(
          `${ticket.id} has no agent phase: no worker holds it, so there is no one to tell`,
          "armada status, to see which tickets are in flight",
        );
      warnings.push(`${ticket.id} has no agent phase (no worker holds it); the answer was not posted on the ticket`);
    } else {
      const ref =
        item?.kind === "answer-request"
          ? `Answers ${question === null ? "the open question or plan" : `${answerKind} #${question}`}, as ${item.author ?? "the owner"} asked from the dashboard (request #${item.id}).`
          : itemId === null
            ? null
            : `Answers ${answerKind} #${itemId}.`;
      // Delivery happens only after validation and before either record is written.
      // Throwing leaves the question/plan open, with no successful answer comment.
      if (ctx.deliverAnswer && (await ctx.deliverAnswer(ticket.id, text, claim?.runtime ?? ticket.agentRuntime, claim)))
        lines.push(`Delivered to ${ticket.id}'s herdr pane.`);
      if (ticket.agentPhase) {
        await linear.comment(ticket.uuid, statusComment(ticket.agentPhase, input.note ? "note" : "answer", text, ref));
        lines.push(`${input.note ? "Note" : "Answer"} posted on ${ticket.id} (${ticket.agentPhase}).`);
      } else warnings.push(`${ticket.id} has no tracker phase; the delivered answer is recorded in Armada`);
    }
  }

  const recorded = await live(ctx, warnings, `record the ${input.note ? "note" : "answer"}`, (fleet) =>
    fleet.answer({ text, note: !!input.note, ticket: ticketId, item: itemId }),
  );
  if (recorded) lines.push(recorded);
  if (!input.note) lines.push("The worker resumes once it reports its phase again.");
  return { ticket: ticketId ?? `#${itemId}`, url, lines, warnings: [...new Set(warnings)], inbox: null };
}

/** A launch the coordinator will not carry out: closed in the inbox with the reason, nothing posted on the ticket. */
async function declineLaunch(
  ctx: WorkerContext,
  item: StoredInboxItem,
  reason: string,
  warnings: string[],
): Promise<Outcome> {
  const done = await live(ctx, warnings, `decline launch request #${item.id}`, (fleet) =>
    fleet.resolve({ id: item.id, resolution: `declined: ${reason}` }),
  );
  const lines =
    done === null
      ? []
      : [
          done
            ? `Launch request #${item.id} for ${item.ticket} declined; the dashboard shows it closed.`
            : `Launch request #${item.id} was already resolved.`,
        ];
  return { ticket: item.ticket ?? `#${item.id}`, url: "", lines, warnings: [...new Set(warnings)], inbox: null };
}

/** A stale hand-back is resolved directly; a departed worker has no phase to resume. */
async function answerHandBack(
  ctx: WorkerContext,
  item: StoredInboxItem,
  text: string,
  warnings: string[],
): Promise<Outcome> {
  const ticket = item.ticket ? await ctx.linear.readTicket(item.ticket) : null;
  const number = handBackPr(item.body);
  let stale = ticket?.statusType === "completed" || ticket?.statusType === "canceled";
  if (!stale && number !== null && ctx.readPull) {
    const pull = await ctx.readPull(number);
    stale =
      pull?.number === number &&
      pull.repo.toLowerCase() === ctx.config.github.repository.toLowerCase() &&
      (pull.state === "merged" || pull.state === "closed");
  }
  if (!stale)
    throw new Refusal(
      `inbox item #${item.id} is a hand-back: armada merge resolves it once the pull request is merged`,
      `armada merge ${number ?? "<pr>"}${item.ticket ? ` --ticket ${item.ticket}` : ""} --dry-run`,
    );
  warnings.push(...(ticket?.warnings ?? []));
  const recorded = await live(ctx, warnings, "resolve the stale hand-back", (fleet) =>
    fleet.answer({ text, note: false, ticket: item.ticket, item: item.id }),
  );
  return {
    ticket: item.ticket ?? `#${item.id}`,
    url: ticket?.url ?? "",
    lines: recorded ? [recorded] : [],
    warnings: [...new Set(warnings)],
    inbox: null,
  };
}
