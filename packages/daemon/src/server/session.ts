// A session's page acts (THE-2045): the owner releases one worker generation,
// reads its terminal output from the runtime's `observe`, and answers its
// question. Each goes through the same `Workers` the coordinator's tools use
// (the generation fence, the keyed delivery, the masked reply); nothing here
// reaches a runtime another way. Each request answers one message; its
// failure is one line, never the runtime's.
import {
  OUTPUT_LINES,
  type OwnerAnswerRequest,
  type ServerMessage,
  type SessionOutputRequest,
  type SessionReleaseRequest,
  PROTOCOL_VERSION as version,
} from "@armada/protocol";
import type { SubmissionDraft } from "@earendil-works/pi-durable";
import { fold } from "../fold.ts";
import type { EventStore } from "../store.ts";
import { WorkerRefusal, type Workers } from "../workers/service.ts";

export type SessionRequest = SessionReleaseRequest | SessionOutputRequest;
export interface SessionOptions {
  store: EventStore;
  workers?: Workers | undefined;
}

const NO_WORKERS = "No worker runtime runs in this daemon";
const ended = (phase: string) => phase === "released" || phase === "merged";

/** The ticket's current session when it is the request's generation and still runs here; else the line saying why not. */
function current(store: EventStore, request: SessionRequest) {
  const tables = fold(store.readSince(0, request.project)).projects[request.project];
  const session = tables?.sessions.find((s) => s.ticket === request.ticket);
  const action = request.type === "session.release" ? "nothing was released" : "open its current session";
  if (!session) return `${request.ticket} has no session in this project`;
  // A V1 session is the tracker's reading of a worker another runtime holds.
  if (session.runtime === "tracker")
    return request.type === "session.release"
      ? `${request.ticket} runs on a V1 runtime: release it there with armada stop`
      : `${request.ticket} runs on a V1 runtime: open it there`;
  if (
    session.session !== request.session ||
    (request.type === "session.release" && session.generation !== request.generation)
  )
    return `${request.ticket}'s worker generation changed; ${action}`;
  if (ended(session.phase)) return `${request.ticket}'s worker is already ${session.phase}`;
  return session;
}

/** Answers one of the session page's requests. */
export async function dispatchSession(request: SessionRequest, options: SessionOptions): Promise<ServerMessage> {
  const { id, project, ticket } = request;
  const refuse = (message: string, code: "not-found" | "internal" = "not-found"): ServerMessage => ({
    type: "error",
    version,
    id,
    code,
    message,
  });
  const session = current(options.store, request);
  if (typeof session === "string") return refuse(session);
  const workers = options.workers;
  if (!workers) return refuse(NO_WORKERS);
  const ref = { project, ticket, session: session.session, generation: session.generation, handle: session.handle };
  try {
    if (request.type === "session.release") {
      // Workers.stop fences the exact generation before and after the runtime's stop.
      const stopped = await workers.stop(ref, request.reason.trim(), () => {});
      return {
        type: "session.release.result",
        version,
        id,
        project,
        ticket,
        session: ref.session,
        disposed: stopped.disposed === true,
      };
    }
    const observed = await workers.observe(project, ticket);
    return {
      type: "session.output.result",
      version,
      id,
      project,
      ticket,
      session: ref.session,
      state: observed.state,
      ...(observed.activity ? { activity: observed.activity } : {}),
      lines: outputLines(observed.reply ?? ""),
    };
  } catch (error) {
    if (error instanceof WorkerRefusal) return refuse(error.message);
    return refuse(
      request.type === "session.release"
        ? "The worker could not be stopped; check its session before trying again"
        : "The worker's output could not be read",
      "internal",
    );
  }
}

// CSI and OSC sequences, then any other escape, then the control characters a terminal does not print.
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal output is cleaned of exactly these.
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?|[\x00-\x08\x0b-\x1f\x7f]/g;

/** A terminal's output as lines: its last `OUTPUT_LINES`, each as a carriage return left it, without control sequences. */
export function outputLines(output: string): string[] {
  const lines = output.split(/\r?\n/).map((line) => (line.split("\r").at(-1) ?? "").replace(CONTROL, "").trimEnd());
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines.slice(-OUTPUT_LINES);
}

const NOTE = "\n\nNote: ";

/**
 * The owner's answer to a worker's open question, with the guards of the
 * coordinator's `inbox.answer` (copied from coordinator/native.ts): the
 * question is open, its worker claimed it and still runs, and it was not asked
 * by an earlier claim. The answer is delivered once (keyed by the item) before
 * it is recorded; the same answer again, once recorded, is not delivered again.
 * Returns the coordinator's input that tells it, or the line saying why not.
 */
export async function answerWorker(
  request: OwnerAnswerRequest,
  options: SessionOptions & { now: () => number },
): Promise<{ refused: string } | "taken" | Extract<SubmissionDraft, { type: "input" }>> {
  const { store, project, item } = { ...options, ...request };
  const note = request.note?.trim() || null;
  const answer = note ? `${request.choice}${NOTE}${note}` : request.choice;
  const events = store.readSince(0, project);
  const tables = fold(events).projects[project];
  const asked = tables?.inbox.find((i) => i.id === item);
  const told = (ticket: string): Extract<SubmissionDraft, { type: "input" }> => ({
    type: "input",
    content: `The owner answered ${ticket}'s question to its worker: ${request.choice}${note ? `\nNote: ${note}` : ""}`,
    requestId: `owner-answer:${item}`,
    whenBusy: "steer",
    entry: { kind: "armada.owner-answer", data: { ticket, choice: request.choice, note } },
  });
  if (!asked) {
    const recorded = events.findLast((e) => e.kind === "inbox.answered" && e.payload.id === item);
    const opened = events.find((e) => e.kind === "inbox.opened" && e.payload.id === item);
    if (recorded?.kind !== "inbox.answered" || recorded.actor !== "owner" || recorded.payload.answer !== answer)
      return "taken";
    return told(opened?.kind === "inbox.opened" ? opened.payload.ticket : "");
  }
  const session = tables?.sessions.find((s) => s.ticket === asked.ticket);
  const claim = events.find((e) => e.kind === "session.claimed" && e.payload.session === session?.session);
  if (!session || !claim || ended(session.phase))
    return { refused: "The runtime worker has ended; no answer was delivered" };
  if (asked.seq < claim.seq)
    return { refused: "The question belongs to an earlier worker claim; no answer was delivered" };
  if (!options.workers) return { refused: `${NO_WORKERS}; no answer was delivered` };
  const unchanged = () => {
    const fresh = fold(store.readSince(0, project)).projects[project];
    const now = fresh?.sessions.find((s) => s.ticket === session.ticket);
    if (now?.session !== session.session || ended(now.phase) || !fresh?.inbox.some((i) => i.id === item))
      throw new Error("Answer target changed");
  };
  try {
    unchanged();
    await options.workers.answer(
      {
        key: `owner-answer:${item}`,
        session: { ticket: session.ticket, session: session.session },
        answer,
        beforeWrite: unchanged,
      },
      project,
    );
  } catch (error) {
    return {
      refused:
        error instanceof WorkerRefusal
          ? `${error.message}; no answer was delivered`
          : "The answer's delivery or its worker could not be confirmed; the question stays open",
    };
  }
  // Delivered: recorded unless another answer closed the question meanwhile.
  if (fold(store.readSince(0, project)).projects[project]?.inbox.some((i) => i.id === item))
    store.append({
      project,
      kind: "inbox.answered",
      at: new Date(options.now()).toISOString(),
      actor: "owner",
      payload: { id: item, answer },
    });
  return told(asked.ticket);
}
