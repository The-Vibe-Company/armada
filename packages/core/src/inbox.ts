// Questions between workers and the coordinator. A worker asks (`armada ask`):
// its phase becomes blocked and the question lands in the coordinator's inbox.
// The coordinator reads the inbox (`armada inbox`), delivers the answer in the
// worker's session through the runtime guide, then records it (`armada answer`).
// Runtime delivery is injected by the CLI; other runtimes use their guide.

import type { Ticket } from "./linear-write.ts";
import type { PendingLaunch, RuntimeHandle } from "./live.ts";
import {
  entryKey,
  type Fleet,
  handBackPr,
  type InboxEntry,
  type InboxItem,
  type InboxKind,
  type StoredInboxItem,
} from "./live.ts";
import { runtimeNameOf } from "./runtime.ts";
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
  pendingDeliveries?: { id: number; ticket: string; kind: string }[];
  ownedPendingDeliveries?: { id: number; ticket: string; kind: string }[];
  waiting?: string[];
  ownedWaiting?: string[];
  slots?: { taken: number; max: number | null };
  ownedInFlight?: string[];
  ownedOpenJobs?: number[];
  project: string;
  generatedAt: string;
  /** Oldest first. */
  items: InboxEntry[];
  /** Tickets a worker holds, the coordinator's own excluded; null when Armada did not say. */
  inFlight: string[] | null;
  openJobs?: number[];
  /** Set by --wait: how long it waited at most, and whether it stopped on the timeout. */
  wait: { timeoutSeconds: number; timedOut: boolean } | null;
  /** Problems that did not stop the read, such as a presence that could not be recorded. */
  warnings: string[];
}

export interface InboxOptions {
  scope?: import("./live.ts").CoordinatorScope;
  coordinatorName?: string;
  facts?: import("./live.ts").CoordinatorFacts;
  project: string;
  coordinator?: string | null;
  /** `policy.silence_minutes`. */
  silentAfterMinutes: number;
  launchGraceMinutes?: number;
  ciWaitMinutes?: number;
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
    coordinatorName: o.coordinatorName,
    scope: o.scope,
    silentAfterMinutes: o.silentAfterMinutes,
    launchGraceMinutes: o.launchGraceMinutes,
    ciWaitMinutes: o.ciWaitMinutes,
    quietAfterMinutes: o.quietAfterMinutes,
    ...(o.facts ? { facts: o.facts } : {}),
    ...(o.notStartedMinutes !== undefined ? { notStartedMinutes: o.notStartedMinutes } : {}),
  };
  const first = await fleet.inbox({ ...query, etag: null });
  if (!first) throw new Error("Armada answered the first inbox read with nothing");
  const warnings = [...first.warnings];
  let items = first.items;
  let inFlight = first.inFlight ?? null;
  let waiting = first.waiting ?? [];
  let pendingDeliveries = first.pendingDeliveries ?? [];
  let ownedPendingDeliveries = first.ownedPendingDeliveries;
  let ownedWaiting = first.ownedWaiting;
  let slots = first.slots;
  let ownedInFlight = first.ownedInFlight;
  let openJobs = first.openJobs ?? [];
  let ownedOpenJobs = first.ownedOpenJobs;
  let etag = first.etag;
  const report = (timedOut: boolean | null): InboxReport => ({
    project: o.project,
    generatedAt: o.now().toISOString(),
    items,
    inFlight,
    waiting,
    ownedWaiting,
    pendingDeliveries,
    ownedPendingDeliveries,
    slots,
    ...(ownedInFlight ? { ownedInFlight } : {}),
    ...(openJobs.length ? { openJobs } : {}),
    ...(ownedOpenJobs ? { ownedOpenJobs } : {}),
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
    waiting = read.waiting ?? [];
    pendingDeliveries = read.pendingDeliveries ?? [];
    ownedPendingDeliveries = read.ownedPendingDeliveries;
    ownedWaiting = read.ownedWaiting;
    slots = read.slots;
    ownedInFlight = read.ownedInFlight;
    openJobs = read.openJobs ?? [];
    ownedOpenJobs = read.ownedOpenJobs;
    etag = read.etag;
    warnings.push(...read.warnings);
    if (items.some((e) => e.new && !e.queue)) return report(false);
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
  "launch-failed",
  "launch-uncertain",
  "job",
  "question",
  "plan",
  "request",
  "answer-request",
  "launch-request",
  "merge-request",
  "release-request",
  "plan-changes",
  "decision",
  "linear-pending",
  "queue-refused",
  "delivery-failed",
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
  let openItems: InboxItem[] = [];
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
    if (item.kind === "hold")
      throw new Refusal(
        `inbox item #${itemId} is a merge hold; clear the hold to resume merges`,
        'armada hold clear <hold-id> --reason "<why>"',
      );
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
      openItems = open ?? [];
      const handle =
        open && !open.some((i) => i.kind === "question" || i.kind === "plan")
          ? await live(ctx, warnings, `read the runtime of ${ticketId}`, (fleet) => fleet.runtimeHandle(ticketId ?? ""))
          : null;
      const observation = handle?.runtimeState;
      const runtimeBlocked =
        ctx.deliverAnswer &&
        !!handle &&
        ctx.deliversTo?.(handle.runtime) &&
        runtimeNameOf(handle.runtime) === "herdr" &&
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
  if (
    item &&
    [
      "job",
      "merge-request",
      "release-request",
      "plan-changes",
      "decision",
      "linear-pending",
      "queue-refused",
      "delivery-failed",
      "launch-failed",
      "launch-uncertain",
    ].includes(item.kind)
  ) {
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
  // Freeze the claim generation before tracker reads or terminal delivery.
  const claim =
    ticketId && ctx.deliverAnswer
      ? await live(ctx, warnings, `read the claim of ${ticketId}`, (fleet) => fleet.runtimeHandle(ticketId))
      : null;
  const launch =
    ticketId && ctx.deliverAnswer && (!claim || claim.releasedAt)
      ? await live(
          ctx,
          warnings,
          `read the pending launch of ${ticketId}`,
          async (fleet) => (await fleet.pendingLaunches()).find((l) => l.ticket === ticketId) ?? null,
        )
      : null;
  const runtime = launch?.runtime ?? claim?.runtime;
  const automatic = !!runtime && !!ctx.deliversTo?.(runtime);
  if (automatic && claim?.releasedAt && !launch)
    throw new Refusal("the runtime worker has ended; no answer was delivered", "armada inbox");
  const generationAt = launch?.launchedAt ?? claim?.claimedAt;
  const answeredItems = answered ? [answered] : openItems.filter((i) => i.kind === "question" || i.kind === "plan");
  if (automatic && generationAt && answeredItems.some((i) => i.createdAt < generationAt))
    throw new Refusal("the question belongs to an earlier worker claim; no answer was delivered", "armada inbox");
  let deliveredToRuntime = false;
  let deliveryAttempts: number | undefined;
  let deliveredText = text;
  let ticket: Ticket | null = null;
  if (ticketId) {
    ticket = await linear.readTicket(ticketId);
    if (!ticket) throw new Refusal(`ticket ${ticketId} not found in Linear`, "armada inbox");
    warnings.push(...ticket.warnings);
    const integratedClaim = automatic && (!!launch || (!!claim && !claim.releasedAt));
    const ticketRuntime = runtime ?? ticket.agentRuntime;
    if (ticketRuntime && ctx.deliversTo?.(ticketRuntime) && !integratedClaim)
      throw new Refusal("the runtime claim or bound launch is missing; no answer was delivered", "armada status");
    if (!ticket.agentPhase && !integratedClaim) {
      if (input.note)
        throw new Refusal(
          `${ticket.id} has no agent phase: no worker holds it, so there is no one to tell`,
          "armada status",
        );
      warnings.push(`${ticket.id} has no agent phase (no worker holds it); the answer was not posted on the ticket`);
    } else if (ctx.deliverAnswer && integratedClaim) {
      const delivered = await ctx.deliverAnswer({
        ticket: ticket.id,
        text,
        claim,
        launch,
        item: itemId,
        kind: input.note ? "note" : "answer",
      });
      if (delivered) {
        deliveredToRuntime = true;
        deliveryAttempts = delivered.attempts;
        deliveredText = delivered.text ?? text;
        lines.push(
          `Delivered to ${ticket.id}'s ${runtimeNameOf(runtime) === "conductor" ? "Conductor" : runtime} session (${delivered.via}${delivered.queued ? ", queued" : ""}).`,
        );
      }
    } else if (runtimeNameOf(ticketRuntime) === "claude-code") {
      lines.push("Deliver with the armada-runtime-claude-code guide first; this command records the answer.");
    }
  }
  try {
    return await recordDeliveredAnswer(ctx, {
      ticket: ticketId,
      text: deliveredText,
      note: !!input.note,
      item: itemId,
      claim,
      launch,
      delivered: deliveredToRuntime,
      deliveryAttempts,
      readTicket: ticket,
      readItem: item,
      warnings,
      lines,
    });
  } catch (error) {
    if (deliveredToRuntime && !(error instanceof Refusal))
      throw new Refusal(
        `${ticketId}'s answer was delivered; Armada could not record it`,
        "inspect the ticket before recording manually; never send it by hand too",
      );
    throw error;
  }
}

/** The recording half is shared by a confirmed command and watch redelivery. Never sends a runtime message. */
export async function recordDeliveredAnswer(
  ctx: WorkerContext,
  input: {
    ticket: string | null;
    text: string;
    note: boolean;
    item: number | null;
    claim: RuntimeHandle | null;
    launch?: PendingLaunch | null;
    delivered?: boolean;
    deliveryAttempts?: number;
    readTicket?: Ticket | null;
    readItem?: StoredInboxItem | null;
    warnings?: string[];
    lines?: string[];
  },
): Promise<Outcome> {
  const warnings = input.warnings ?? [];
  const lines = input.lines ?? [];
  const ticket = input.readTicket ?? (input.ticket ? await ctx.linear.readTicket(input.ticket) : null);
  const item =
    input.readItem ??
    (input.item === null
      ? null
      : await live(ctx, warnings, "read the delivered answer's item", (fleet) => fleet.inboxItem(input.item ?? 0)));
  const question = item?.kind === "answer-request" ? (item.request?.question ?? null) : null;
  const answered =
    question === null
      ? item
      : await live(ctx, warnings, "read the answered question", (fleet) => fleet.inboxItem(question));
  const answerKind = answered?.kind === "plan" ? "plan" : "question";
  const ref =
    item?.kind === "answer-request"
      ? `Answers ${question === null ? "the open question or plan" : `${answerKind} #${question}`}, as ${item.author ?? "the owner"} asked from the dashboard (request #${item.id}).`
      : input.item === null
        ? null
        : `Answers ${answerKind} #${input.item}.`;
  const check = input.delivered
    ? () => ctx.checkAnswerTarget?.({ claim: input.claim, launch: input.launch ?? null }) ?? Promise.resolve()
    : undefined;
  if (ticket?.agentPhase) {
    await check?.();
    await ctx.linear.comment(
      ticket.uuid,
      statusComment(ticket.agentPhase, input.note ? "note" : "answer", input.text, ref),
      { beforeWrite: check },
    );
    lines.push(`${input.note ? "Note" : "Answer"} posted on ${ticket.id} (${ticket.agentPhase}).`);
  } else if (input.delivered)
    warnings.push(`${input.ticket} has no tracker phase; the delivered answer is recorded in Armada`);
  await check?.();
  const recorded = await live(ctx, warnings, `record the ${input.note ? "note" : "answer"}`, (fleet) =>
    fleet.answer({
      text: input.text,
      note: input.note,
      ticket: input.ticket,
      item: input.item,
      ...(input.deliveryAttempts && input.deliveryAttempts > 1 ? { deliveryAttempts: input.deliveryAttempts } : {}),
    }),
  );
  if (recorded) lines.push(recorded);
  if (!input.note) lines.push("The worker resumes once it reports its phase again.");
  return {
    ticket: input.ticket ?? `#${input.item}`,
    url: ticket?.url ?? "",
    lines,
    warnings: [...new Set(warnings)],
    inbox: null,
  };
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
