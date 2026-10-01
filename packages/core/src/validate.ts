// The owner's validations from the terminal (THE-885). `armada validate`: a
// worker shows its work (a design, a change) and waits, in the phase
// `awaiting-validation`; the coordinator may send one for any ticket.
// `armada ask-owner`: the coordinator escalates a question with its choices.
// `armada done`: the coordinator closes a ticket whose validation the owner
// approved, with no pull request (a design ticket). Each item lands on the
// dashboard's Validations page, opened from one link; Linear keeps the record.

import { transitionProblem } from "./phases.ts";
import { decidedLine, lastValidation, VALIDATION_LIMITS, type Validation } from "./validations.ts";
import {
  firstState,
  type Outcome,
  others,
  Refusal,
  readOpenTicket,
  reportPhase,
  type WorkerContext,
} from "./worker.ts";

export interface SubmitInput {
  ticket: string;
  /** `validation`: what to check (`armada validate`); `question`: the coordinator's question to the owner (`armada ask-owner`). */
  kind: "validation" | "question";
  what: string;
  choices: string[] | null;
  /** Attachments already uploaded for it (THE-886). */
  attachments: string[];
  /** The worker of the ticket submits its own work: its phase becomes awaiting-validation. */
  worker: boolean;
}

/** The validation as created, with its approval link; the worker's report when it was the worker's. */
export type SubmitOutcome = Outcome & { validation: Validation | null; link: string | null };

const PHASE = "awaiting-validation";

/**
 * Sends the owner something to validate. A worker's phase becomes
 * `awaiting-validation` with the link in its status; the coordinator's
 * submission posts the link on the ticket. Needs Armada: the owner decides on
 * the dashboard.
 */
export async function submitValidation(ctx: WorkerContext, input: SubmitInput): Promise<SubmitOutcome> {
  const what = input.what.trim();
  const usage =
    input.kind === "question"
      ? `armada ask-owner ${input.ticket} "<question>" --choices "<a> | <b>"`
      : `armada validate "<what to check>" --attach <file|url>`;
  if (!what) throw new Refusal("say what the owner checks", usage);
  if (what.length > VALIDATION_LIMITS.what)
    throw new Refusal(`what to check has at most ${VALIDATION_LIMITS.what} characters`, usage);
  if (input.kind === "question" && !input.choices?.length)
    throw new Refusal("a question for the owner needs its choices", usage);
  const ticket = await readOpenTicket(ctx, input.ticket);
  if (input.worker && ticket.agentPhase !== PHASE) {
    const problem = transitionProblem(ticket.agentPhase, PHASE);
    if (problem) throw new Refusal(`${ticket.id}: ${problem}`, `armada report <phase> --message "<what you did>"`);
  }
  const { fleet, warning } = await ctx.fleet();
  if (!fleet)
    throw new Refusal(
      `the owner validates on Armada, which this terminal cannot reach (${warning ?? "not signed in"}); nothing was sent`,
      "armada login, then the same command again",
    );
  const { validation, url } = await fleet.validate({
    ticket: ticket.id,
    kind: input.kind,
    what,
    reason: null,
    choices: input.choices,
    pr: null,
    attachments: input.attachments,
  });
  const [first = "", ...rest] = what.split("\n");
  if (input.worker) {
    const out = await reportPhase(ctx, {
      ticket: ticket.id,
      phase: PHASE,
      message: [`${first.trim()} — ${url}`, rest.join("\n").trim()].filter(Boolean).join("\n"),
    });
    return {
      ...out,
      lines: [
        ...out.lines,
        `Validation #${validation.id} waits for the owner: ${url}`,
        "Stop here until the owner decides: the coordinator relays the decision in this session. On changes, revise and run armada validate again.",
      ],
      validation,
      link: url,
    };
  }
  const label = input.kind === "question" ? "Question for the owner" : "Owner validation asked";
  const choices = input.choices?.length ? `\n\nChoices: ${input.choices.join(" | ")}` : "";
  await ctx.linear.comment(ticket.uuid, `${label}: ${what}${choices}\n\n${url}`);
  return {
    ticket: ticket.id,
    url: ticket.url,
    lines: [
      `${input.kind === "question" ? "Question" : "Validation"} #${validation.id} for ${ticket.id} waits for the owner: ${url}`,
      "The link is posted on the ticket; the owner's decision arrives in your inbox.",
    ],
    warnings: [...ticket.warnings],
    inbox: null,
    validation,
    link: url,
  };
}

/**
 * Closes a ticket whose newest validation the owner approved, with no pull
 * request: the design (what was checked, the owner's note, its attachments)
 * is posted on the ticket, which moves to Done with its agent labels removed;
 * Armada records it like a merge, so the worker's session ends.
 */
export async function closeValidated(
  ctx: WorkerContext,
  input: { ticket: string; attachmentUrl: (id: string) => string },
): Promise<Outcome & { validation: Validation }> {
  const { config, linear } = ctx;
  const ticket = await readOpenTicket(ctx, input.ticket);
  const { fleet, warning } = await ctx.fleet();
  if (!fleet)
    throw new Refusal(
      `the owner's decisions are on Armada, which this terminal cannot reach (${warning ?? "not signed in"})`,
      "armada login, then the same command again",
    );
  const v = lastValidation(await fleet.validations({ ticket: ticket.id }), ticket.id);
  if (v?.decision?.outcome !== "approved")
    throw new Refusal(
      v
        ? `${ticket.id}'s validation #${v.id} is ${v.decision ? decidedLine(v.decision) : "still waiting for the owner"}: only an approved one closes the ticket`
        : `${ticket.id} has no validation the owner approved`,
      v && !v.decision
        ? "armada inbox --wait: the owner's decision arrives there"
        : `armada validate ${ticket.id} "<what to check>"`,
    );
  const decided = decidedLine(v.decision);
  const groups = config.tracker.labels;
  const done = firstState(ticket.states, "completed");
  await linear.updateTicket(ticket.uuid, {
    ...(done ? { stateId: done.id } : {}),
    removeLabelIds: [
      ...others(ticket, groups.phaseGroup, null),
      ...others(ticket, groups.runtimeGroup, null),
      ...ticket.labels.filter((label) => label.name === config.tracker.readyLabel).map((label) => label.id),
    ],
  });
  const attachments = v.attachments.map((id) => `- ${input.attachmentUrl(id)}`);
  const summary = `done without a pull request: validation #${v.id} ${decided}`;
  await linear.comment(
    ticket.uuid,
    [
      `Agent status: merged — ${summary}`,
      `What the owner validated:\n${v.what}`,
      v.decision.note ? `The owner's note:\n${v.decision.note}` : "",
      attachments.length ? `Attachments:\n${attachments.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
  const warnings = [...ticket.warnings];
  try {
    await fleet.done({ ticket: ticket.id, message: summary });
  } catch (err) {
    warnings.push(`Armada did not record it (${err instanceof Error ? err.message : String(err)})`);
  }
  return {
    ticket: ticket.id,
    url: ticket.url,
    lines: [
      `${ticket.id}: ${done ? `moved to ${done.name}` : "state unchanged"}, agent and ready labels removed; ${summary}.`,
      "Building it is a separate ticket: cut it, blocked by this one.",
    ],
    warnings,
    inbox: null,
    validation: v,
  };
}
