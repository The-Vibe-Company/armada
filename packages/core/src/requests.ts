// The owner's requests from the dashboard. The dashboard never talks to a
// worker or a runtime: answering a question or launching a ready ticket becomes
// an item in the coordinator's inbox, scoped to the ticket's project and
// signed by its author. The coordinator carries it out through the runtime
// guide, then resolves it: `armada answer` for an answer, the worker's claim
// for a launch. Every check the dashboard makes before writing lives here.
import type { ArmadaConfig } from "./config.ts";
import type { StatusReport } from "./status.ts";
import { addRequest, type Db, getInboxItem, getRuntimeHandle } from "./turso.ts";

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
  | "launch-waiting";

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
  /** The question's inbox item id. */
  question: number;
  text: string;
  author: string;
  now: Date;
}

/**
 * Asks the coordinator to deliver an answer to a worker's open question. The
 * question stays open, shown as answered-pending, until the coordinator
 * delivers it and records it with `armada answer`.
 */
export async function requestAnswer(db: Db, input: AnswerRequestInput): Promise<number> {
  const author = requestAuthor(input.author);
  const text = input.text.replace(/\r\n?/g, "\n").trim();
  if (!text) throw new RequestRefusal("empty-answer", "the answer is empty");
  if (text.length > REQUEST_LIMITS.answer)
    throw new RequestRefusal("answer-too-long", `an answer has at most ${REQUEST_LIMITS.answer} characters`);
  const question = await getInboxItem(db, input.project, input.question);
  if (question?.kind !== "question" || question.recipient !== "coordinator" || !question.ticket)
    throw new RequestRefusal("no-question", `question #${input.question} does not exist in project ${input.project}`);
  if (question.resolvedAt)
    throw new RequestRefusal("question-closed", `question #${question.id} was already answered or closed`);
  const id = await addRequest(db, {
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
  const again = await getInboxItem(db, input.project, question.id);
  if (again?.resolvedAt)
    throw new RequestRefusal("question-closed", `question #${question.id} was already answered or closed`);
  throw new RequestRefusal("answer-waiting", `an answer to question #${question.id} already waits for the coordinator`);
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
export async function requestLaunch(db: Db, input: LaunchRequestInput): Promise<number> {
  const { config, report } = input;
  const author = requestAuthor(input.author);
  const project = config.project.slug;
  const id = input.ticket.trim().toUpperCase();
  if (report.inFlight.some((t) => t.id === id)) throw new RequestRefusal("in-flight", `${id} is already in flight`);
  const ticket = report.frontier.find((t) => t.id === id);
  if (!ticket) throw new RequestRefusal("not-ready", `${id} is not on the frontier of ${project}: it cannot start yet`);
  // A claim newer than the reading above.
  const held = await getRuntimeHandle(db, project, id);
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
        `Routing gives ${routed} (${ticket.route?.why}); ${author} chose ${profile}: brief and claim with --profile ${profile} --reason "asked from the dashboard by ${author}".`,
      );
  }
  const item = await addRequest(db, {
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
