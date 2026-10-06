// The owner's requests from the dashboard. The dashboard never talks to a
// worker or a runtime: answering a question or launching a ready ticket becomes
// an item in the coordinator's inbox, scoped to the ticket's project and
// signed by its author. The coordinator carries it out through the runtime
// guide, then resolves it: `armada answer` for an answer, the worker's claim
// for a launch. Every check the dashboard makes before writing lives here,
// over `RequestStore`: the fleet's live data in the app's database.
import { shellWord } from "./brief.ts";
import type { ArmadaConfig } from "./config.ts";
import { type DeferredLaunch, deferredHeld, deferredLaunchState } from "./deferred.ts";
import { attachPullRequests } from "./github.ts";
import type { FleetStore, HandBackSnapshot } from "./live.ts";
import { buildModel } from "./model.ts";
import { routeProfile } from "./routing.ts";
import type { StatusReport } from "./status.ts";
import { decisionBody, VALIDATION_LIMITS, type ValidationDecision } from "./validations.ts";

/** The reads and the writes a request needs. */
export type RequestStore = Pick<
  FleetStore,
  "getInboxItem" | "getRuntimeHandle" | "latestEvents" | "addRequest" | "getValidation" | "decideValidation"
>;

export const REQUEST_LIMITS = { answer: 4000, author: 80 } as const;

/** Why a request was refused; the dashboard shows each in the viewer's language. */
export type RequestRefusalCode =
  | "no-author"
  | "empty-answer"
  | "answer-too-long"
  | "no-question"
  | "question-closed"
  | "answer-waiting"
  | "not-ready"
  | "in-flight"
  | "unknown-profile"
  | "launch-waiting"
  | "no-pr"
  | "no-session"
  | "request-waiting"
  | "no-validation"
  | "validation-closed"
  | "no-choice";

export class RequestRefusal extends Error {
  override name = "RequestRefusal";
  constructor(
    readonly code: RequestRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

/** One line, trimmed: a name or a title never carries a line break into the tracker. */
export function requestAuthor(raw: string | null | undefined): string {
  const author = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!author) throw new RequestRefusal("no-author", "say who asks: the request is signed with your name");
  if (author.length > REQUEST_LIMITS.author)
    throw new RequestRefusal("no-author", `a name has at most ${REQUEST_LIMITS.author} characters`);
  return author;
}

export interface AnswerRequestInput {
  project: string;
  /** The question or plan's inbox item id. */
  question: number;
  text: string;
  author: string;
  now: Date;
}

/**
 * Asks the coordinator to deliver an answer to a worker's open question or plan. The
 * item stays open, shown as answered-pending, until the coordinator
 * delivers it and records it with `armada answer`.
 */
export async function requestAnswer(db: RequestStore, input: AnswerRequestInput): Promise<number> {
  const author = requestAuthor(input.author);
  const text = input.text.replace(/\r\n?/g, "\n").trim();
  if (!text) throw new RequestRefusal("empty-answer", "the answer is empty");
  if (text.length > REQUEST_LIMITS.answer)
    throw new RequestRefusal("answer-too-long", `an answer has at most ${REQUEST_LIMITS.answer} characters`);
  const question = await db.getInboxItem(input.project, input.question);
  if (
    !question ||
    !["question", "plan"].includes(question.kind) ||
    question.recipient !== "coordinator" ||
    !question.ticket
  )
    throw new RequestRefusal(
      "no-question",
      `question or plan #${input.question} does not exist in project ${input.project}`,
    );
  if (question.resolvedAt)
    throw new RequestRefusal("question-closed", `${question.kind} #${question.id} was already answered or closed`);
  const id = await db.addRequest({
    project: input.project,
    ticket: question.ticket,
    kind: "answer-request",
    author,
    body: text,
    question: question.id,
    profile: null,
    at: input.now,
  });
  if (id !== null) return id;
  // Nothing was added: tell which guard stopped it.
  const again = await db.getInboxItem(input.project, question.id);
  if (again?.resolvedAt)
    throw new RequestRefusal("question-closed", `${question.kind} #${question.id} was already answered or closed`);
  throw new RequestRefusal(
    "answer-waiting",
    `an answer to ${question.kind} #${question.id} already waits for the coordinator`,
  );
}

export interface LaunchRequestInput {
  config: ArmadaConfig;
  /** The project's current reading: the ticket must be on its frontier. */
  report: StatusReport;
  ticket: string;
  /** Null: the profile routing gives the ticket. */
  profile: string | null;
  author: string;
  now: Date;
}

/**
 * Asks the coordinator to launch a worker on a ready ticket. The ticket must
 * be on the project's frontier and held by no worker; the profile must be one
 * armada.toml declares. The worker's claim resolves the request.
 */
export async function requestLaunch(db: RequestStore, input: LaunchRequestInput): Promise<number> {
  const { config, report } = input;
  const author = requestAuthor(input.author);
  const project = config.project.slug;
  const id = input.ticket.trim().toUpperCase();
  if (report.inFlight.some((t) => t.id === id)) throw new RequestRefusal("in-flight", `${id} is already in flight`);
  const ticket = report.frontier.find((t) => t.id === id);
  if (!ticket) throw new RequestRefusal("not-ready", `${id} is not on the frontier of ${project}: it cannot start yet`);
  // A claim newer than the reading above.
  const held = await db.getRuntimeHandle(project, id);
  if (held && !held.releasedAt)
    throw new RequestRefusal("in-flight", `${id} was claimed by ${held.runtime} (${held.handle})`);

  const names = Object.keys(config.conductor.profiles);
  const routed = ticket.route?.profile ?? null;
  const profile = input.profile?.trim() || routed;
  if (profile !== null && !Object.hasOwn(config.conductor.profiles, profile))
    throw new RequestRefusal(
      "unknown-profile",
      `no Conductor profile "${profile}" in ${project} (available: ${names.join(", ") || "none"})`,
    );

  const lines = [`Launch ${id} — ${ticket.title}`];
  if (profile) {
    const p = config.conductor.profiles[profile];
    lines.push(`Profile: ${profile}${p ? ` (agent ${p.agent}, model ${p.model}, effort ${p.effort})` : ""}`);
    if (routed && profile !== routed)
      lines.push(
        `Routing gives ${routed} (${ticket.route?.why}); ${author} chose ${profile}: brief and claim with --profile ${shellWord(profile)} --reason ${shellWord(`asked from the dashboard by ${author}`)}`,
      );
  }
  const item = await db.addRequest({
    project,
    ticket: id,
    kind: "launch-request",
    author,
    body: lines.join("\n"),
    question: null,
    profile,
    at: input.now,
  });
  if (item === null) throw new RequestRefusal("launch-waiting", `a launch of ${id} already waits for the coordinator`);
  return item;
}

type SteeringInput = { project: string; author: string; coordinator?: string | null; now: Date };

export async function requestMerge(
  db: RequestStore,
  input: SteeringInput & { pr: number; openPrs: readonly number[]; ticket?: string | null },
): Promise<number> {
  if (!Number.isSafeInteger(input.pr) || input.pr <= 0 || !input.openPrs.includes(input.pr))
    throw new RequestRefusal("no-pr", `PR #${input.pr} is not open in ${input.project}`);
  const id = await db.addRequest({
    project: input.project,
    ticket: input.ticket ?? null,
    kind: "merge-request",
    coordinator: input.coordinator,
    author: requestAuthor(input.author),
    body: `Please merge PR #${input.pr}.`,
    question: null,
    profile: null,
    pr: input.pr,
    at: input.now,
  });
  if (id === null)
    throw new RequestRefusal("request-waiting", `a merge of PR #${input.pr} already waits for the coordinator`);
  return id;
}

export async function requestRelease(db: RequestStore, input: SteeringInput & { ticket: string }): Promise<number> {
  const ticket = input.ticket.trim().toUpperCase();
  const handle = await db.getRuntimeHandle(input.project, ticket);
  if (!handle || handle.releasedAt) throw new RequestRefusal("no-session", `${ticket} has no session to release`);
  const id = await db.addRequest({
    project: input.project,
    ticket,
    kind: "release-request",
    coordinator: input.coordinator,
    author: requestAuthor(input.author),
    body: `Please release ${ticket}.`,
    question: null,
    profile: null,
    at: input.now,
  });
  if (id === null)
    throw new RequestRefusal("request-waiting", `a release of ${ticket} already waits for the coordinator`);
  return id;
}

export async function requestPlanChanges(
  db: RequestStore,
  input: SteeringInput & { question: number; text: string },
): Promise<number> {
  const author = requestAuthor(input.author);
  const body = input.text.replace(/\r\n?/g, "\n").trim();
  if (!body) throw new RequestRefusal("empty-answer", "the plan amendments are empty");
  if (body.length > REQUEST_LIMITS.answer)
    throw new RequestRefusal("answer-too-long", `plan amendments have at most ${REQUEST_LIMITS.answer} characters`);
  const plan = await db.getInboxItem(input.project, input.question);
  if (plan?.kind !== "plan" || plan.recipient !== "coordinator" || !plan.ticket)
    throw new RequestRefusal("no-question", `plan #${input.question} does not exist in ${input.project}`);
  if (plan.resolvedAt) throw new RequestRefusal("question-closed", `plan #${plan.id} is already closed`);
  const id = await db.addRequest({
    project: input.project,
    ticket: plan.ticket,
    kind: "plan-changes",
    coordinator: input.coordinator,
    author,
    body,
    question: plan.id,
    profile: null,
    at: input.now,
  });
  if (id === null) {
    if ((await db.getInboxItem(input.project, plan.id))?.resolvedAt)
      throw new RequestRefusal("question-closed", `plan #${plan.id} is already closed`);
    throw new RequestRefusal("request-waiting", `amendments to plan #${plan.id} already wait for the coordinator`);
  }
  return id;
}

export interface DecisionInput {
  project: string;
  /** The validation decided. */
  id: number;
  /** `approve` or `changes` for a merge or a validation; `choice` picks one of the choices it was sent with. */
  action: "approve" | "changes" | "choice";
  choice?: string | null;
  /** The changes to make (required with `changes`), or a note with the decision. */
  note?: string | null;
  author: string;
  now: Date;
}

/**
 * The owner decides a validation (THE-885): the decision is kept on it and
 * reaches the coordinator's inbox as a `decision` item, which wakes `armada
 * watch`. The coordinator merges, or relays it to the worker. Returns the
 * inbox item's id.
 */
export async function requestDecision(db: RequestStore, input: DecisionInput): Promise<number> {
  const by = requestAuthor(input.author);
  const note = (input.note ?? "").replace(/\r\n?/g, "\n").trim() || null;
  if (note && note.length > VALIDATION_LIMITS.note)
    throw new RequestRefusal("answer-too-long", `a note has at most ${VALIDATION_LIMITS.note} characters`);
  const v = await db.getValidation(input.project, input.id);
  if (!v) throw new RequestRefusal("no-validation", `validation #${input.id} does not exist in ${input.project}`);
  if (v.decision) throw new RequestRefusal("validation-closed", `validation #${v.id} was already decided`);
  if (v.kind === "secret")
    throw new RequestRefusal("no-choice", "an owner or admin sets this secret through its password field");
  let decision: Omit<ValidationDecision, "at">;
  if (v.choices) {
    const choice = input.choice?.trim() ?? "";
    if (input.action !== "choice" || !v.choices.includes(choice))
      throw new RequestRefusal("no-choice", `pick one of: ${v.choices.join(", ")}`);
    decision = { outcome: "answered", answer: choice, note, by };
  } else if (input.action === "approve") decision = { outcome: "approved", answer: null, note, by };
  else if (input.action === "changes") {
    if (!note) throw new RequestRefusal("empty-answer", "say which changes to make");
    decision = { outcome: "changes", answer: null, note, by };
  } else throw new RequestRefusal("no-choice", "approve, or request changes");
  const done = await db.decideValidation({
    project: input.project,
    id: v.id,
    decision,
    body: decisionBody(v, decision),
    at: input.now,
  });
  if (!done) throw new RequestRefusal("validation-closed", `validation #${v.id} was already decided`);
  return done.item;
}

export async function requestDeferredLaunch(
  db: RequestStore,
  input: {
    config: ArmadaConfig;
    snapshot?: HandBackSnapshot;
    ticket: string;
    profile: string | null;
    after?: string | null;
    author: string;
    coordinator?: string | null;
    now: Date;
  },
): Promise<DeferredLaunch> {
  const { config, snapshot } = input;
  const author = requestAuthor(input.author);
  if (!snapshot?.flight)
    throw new RequestRefusal("not-ready", "no stored reading of the project yet; open its dashboard and retry");
  const model = buildModel(
    attachPullRequests(snapshot.flight.program, snapshot.flight.forge),
    snapshot.flight.program.rootId,
  );
  const ticket = input.ticket.trim().toUpperCase();
  const issue = model.program.find((i) => i.id === ticket);
  const profile = input.profile?.trim() || (issue ? routeProfile(config, issue.labels)?.name : null) || null;
  if (profile && !Object.hasOwn(config.conductor.profiles, profile))
    throw new RequestRefusal("unknown-profile", `no Conductor profile "${profile}" in ${config.project.slug}`);
  const after = input.after?.trim().toUpperCase();
  if (after && !issue?.blockedBy.some((b) => b.id === after))
    throw new RequestRefusal(
      "not-ready",
      `${after} is not a blocker of ${ticket}; add the blocked-by relation in Linear first`,
    );
  const held = await db.getRuntimeHandle(config.project.slug, ticket);
  const item = {
    id: 0,
    project: config.project.slug,
    ticket,
    kind: "launch-request" as const,
    recipient: "coordinator" as const,
    author,
    body: "",
    createdAt: input.now.toISOString(),
    request: { question: null, profile, deferred: true },
  };
  const events = await db.latestEvents(config.project.slug, { tickets: [ticket] });
  const heldTickets = deferredHeld(model, snapshot.flight, input.now, held ? [held] : [], events);
  const state = deferredLaunchState(
    item,
    model,
    config.tracker.parkedLabel,
    heldTickets.has(ticket),
    author,
    !!profile && config.conductor.profiles[profile]?.runtime === "claude-code",
  );
  if (!state.blockers?.length && issue && state.reason === null)
    throw new RequestRefusal("not-ready", `${ticket} is not blocked; run ${state.command}`);
  if (!state.blockers?.length || state.reason !== `waits on ${state.blockers.join(", ")}`)
    throw new RequestRefusal(
      "not-ready",
      `${ticket} cannot wait for launch: ${state.reason ?? "it has no open blockers"}`,
    );
  const id = await db.addRequest({
    project: config.project.slug,
    ticket,
    kind: "launch-request",
    author,
    coordinator: input.coordinator,
    body: `${ticket} will launch once ${state.blockers.join(", ")} ${state.blockers.length === 1 ? "is" : "are"} done`,
    question: null,
    profile,
    deferred: true,
    at: input.now,
  });
  if (id === null)
    throw new RequestRefusal("launch-waiting", `a launch of ${ticket} already waits for the coordinator`);
  return { ...state, id };
}
