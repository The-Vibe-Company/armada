// A session's state card (THE-2028, THE-2045), shared by the session's page
// and the room's agent lane (THE-2089): the state in its colour, what to do
// about it, and the buttons that act (Answer, Release the ticket, Open the
// session), each through one of the daemon's requests.
import { CHAT_MINOR, SESSION_MINOR, type SessionOutputResult } from "@armada/protocol";
import { useEffect, useId, useRef, useState } from "react";
import { TONE } from "@/components/fleet/FleetList";
import { Dot, Input } from "@/components/page";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDaemon, useDaemonClient } from "@/protocol/store";
import { type Acts, type Card, type PageState, type SessionView, STATE_LABEL } from "@/session/view";

/** Each state's colour, the list's; released is as quiet as merged. */
export const TONES: Record<PageState, { text: string; bg: string }> = { ...TONE, released: TONE.merged };

/** The card's edge in its state's colour: the whole edge, never a side border. */
const EDGE: Record<PageState, string> = {
  blocked: "border-red/55",
  you: "border-amber/55",
  running: "border-blue/45",
  ready: "border-green/50",
  merged: "border-merged/45",
  released: "border-merged/45",
};

/** Said beside the decisions the app cannot take yet (plans and validations). */
const NOT_YET = "Not available yet.";

export function StateCard({
  view,
  at,
  tick,
}: {
  view: SessionView;
  at: (time: string | null) => string;
  tick: number;
}) {
  const { card, group } = view;
  return (
    <section
      aria-label="State"
      data-state={group}
      className={cn("flex min-w-0 flex-col gap-3 rounded-card border bg-card px-4.5 py-4", EDGE[group])}
    >
      <div className="flex items-center gap-2.5">
        <span aria-hidden className={`size-2 flex-none rounded-full ${TONES[group].bg}`} />
        <span className={`font-medium text-sub ${TONES[group].text}`}>{STATE_LABEL[group]}</span>
      </div>
      <CardBody card={card} at={at} />
      <Actions view={view} tick={tick} />
    </section>
  );
}

function CardBody({ card, at }: { card: Card; at: (time: string | null) => string }) {
  switch (card.kind) {
    case "blocked":
      return <p className="m-0 whitespace-pre-wrap text-sub text-text">{card.question?.question || card.reason}</p>;
    case "you":
      return (
        <>
          <p
            className={cn(
              "m-0 whitespace-pre-wrap text-sub text-text",
              card.ask === "plan" && "max-h-72 overflow-y-auto rounded-md bg-sunken px-3 py-2.5",
            )}
          >
            {card.question}
          </p>
          {card.checks.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-body text-text-2">
              {card.checks.map((c) => (
                <li key={c} className="flex gap-2">
                  <span aria-hidden className="text-text-3">
                    ✓
                  </span>
                  {c}
                </li>
              ))}
            </ul>
          )}
          {/* The coordinator's question to the owner is answered below; plans and validations not yet. */}
          {card.ask !== "question" && (
            <>
              <div className="flex flex-wrap gap-2">
                {card.choices.map((c, i) => (
                  <Button key={c} variant={i === 0 ? "primary" : "soft"} disabled>
                    {c}
                  </Button>
                ))}
              </div>
              <label className="flex items-center gap-3 text-body text-text-2">
                <span className="w-11 flex-none">Note</span>
                <input
                  type="text"
                  disabled
                  placeholder="Add a note…"
                  className="h-8.5 min-w-0 flex-1 rounded-sm bg-sunken px-3 text-body text-text shadow-ring placeholder:text-text-3 disabled:opacity-60"
                />
              </label>
              <p className="m-0 text-body text-text-3">{NOT_YET}</p>
            </>
          )}
        </>
      );
    case "running":
      return (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-body text-text-3">
            Last report <span className="font-mono tnum">{at(card.at)}</span>
          </span>
          <p className="m-0 whitespace-pre-wrap text-sub text-text">{card.report}</p>
        </div>
      );
    case "released":
      return <p className="m-0 whitespace-pre-wrap text-sub text-text">{card.reason}</p>;
    case "ready":
    case "merged":
      return (
        <p className="m-0 text-sub text-text">
          {card.reason}
          {card.pr?.url && (
            <>
              {" · "}
              <a href={card.pr.url} target="_blank" rel="noreferrer" className="text-text-2 hover:text-text">
                Open #{card.pr.number}
              </a>
            </>
          )}
        </p>
      );
  }
}

const problemOf = (error: unknown, fallback: string) => (error instanceof Error && error.message) || fallback;

/**
 * The card's buttons (THE-2045): Answer opens the question's choices and a
 * note (the coordinator's question to the owner shows them at once, as the
 * room's card does); Release the ticket asks for a reason on a confirmation
 * line, then stops exactly this generation; Open the session opens the
 * worker's output in a drawer, or a V1 session's Conductor workspace. What
 * cannot act says why on one line.
 */
function Actions({ view, tick }: { view: SessionView; tick: number }) {
  const { acts, ticket } = view;
  const project = view.project.id;
  const { status, minor } = useDaemon();
  const [answering, setAnswering] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  // A new question, generation or state starts the card's actions afresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on what the actions name.
  useEffect(() => {
    setAnswering(false);
    setReleasing(false);
    setSaid(null);
  }, [acts.answer?.item, acts.release?.session, view.group]);
  if (!acts.answer && !acts.release && !acts.open && !acts.v1) return null;
  const live = status === "live";
  const acting = live && minor !== null && minor >= SESSION_MINOR;
  const canAnswer = acts.answer?.kind === "owner-request" ? live && minor !== null && minor >= CHAT_MINOR : acting;
  const why = !live
    ? "Waiting for the daemon."
    : !acting
      ? "This daemon is older than the app: update it to act on a session."
      : acts.v1
        ? "A V1 session: release it from its own runtime with armada stop."
        : null;
  // The coordinator's question to the owner is answered at once; a worker's question opens on Answer.
  const inline = acts.answer?.kind === "owner-request";
  return (
    <>
      {acts.answer && (inline || answering) && (
        <AnswerForm
          project={project}
          answer={acts.answer}
          disabled={!canAnswer}
          onCancel={inline ? undefined : () => setAnswering(false)}
          onAnswered={() => {
            setAnswering(false);
            setSaid(inline ? "Your answer is recorded." : "Your answer is delivered to the worker.");
          }}
        />
      )}
      {releasing && acts.release ? (
        <ReleaseForm
          project={project}
          ticket={ticket}
          release={acts.release}
          onCancel={() => setReleasing(false)}
          onReleased={() => setReleasing(false)}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {acts.answer && !inline && (
              <Button
                variant="soft"
                aria-expanded={answering}
                disabled={!canAnswer}
                onClick={() => setAnswering((open) => !open)}
              >
                Answer
              </Button>
            )}
            {(acts.release || acts.v1) && (
              <Button
                variant="soft"
                disabled={!acts.release || !acting}
                onClick={() => {
                  setSaid(null);
                  setReleasing(true);
                }}
              >
                Release the ticket
              </Button>
            )}
            {acts.open?.kind === "link" ? (
              <a href={acts.open.href} className={buttonVariants({ variant: "soft" })}>
                Open the session
              </a>
            ) : (
              <Button
                variant="soft"
                aria-expanded={drawer}
                disabled={!acts.open || !acting}
                onClick={() => setDrawer(true)}
              >
                Open the session
              </Button>
            )}
          </div>
          {why && <p className="m-0 text-body text-text-3">{why}</p>}
          {said && (
            <p role="status" className="m-0 text-body text-text-2">
              {said}
            </p>
          )}
        </div>
      )}
      {drawer && acts.open?.kind === "output" && (
        <OutputDrawer
          project={project}
          ticket={ticket}
          session={acts.open.session}
          tick={tick}
          onClose={() => setDrawer(false)}
        />
      )}
    </>
  );
}

/** The question's choices (the recommended one primary) and a labelled note; without choices, the answer itself. */
function AnswerForm({
  project,
  answer,
  disabled,
  onCancel,
  onAnswered,
}: {
  project: string;
  answer: NonNullable<Acts["answer"]>;
  disabled: boolean;
  onCancel: (() => void) | undefined;
  onAnswered: () => void;
}) {
  const client = useDaemonClient();
  const field = useId();
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { choices } = answer;
  async function send(choice: string, withNote: boolean) {
    setSending(true);
    setProblem(null);
    try {
      await client.request({
        type: "owner.answer",
        project,
        item: answer.item,
        choice,
        ...(withNote && note.trim() ? { note: note.trim() } : {}),
      });
      setNote("");
      onAnswered();
    } catch (error) {
      setProblem(problemOf(error, "The answer was not recorded. Try again."));
    } finally {
      setSending(false);
    }
  }
  return (
    <form
      aria-label="Answer"
      className="flex flex-col gap-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        // Enter answers a question without choices; with choices, a button does.
        if (!choices.length && note.trim() && !sending) send(note.trim(), false);
      }}
    >
      {choices.length > 0 && (
        <div className="flex flex-wrap gap-2" data-choices>
          {choices.map((c) => (
            <Button
              key={c.label}
              type="button"
              variant={c.recommended ? "primary" : "soft"}
              disabled={disabled || sending}
              onClick={() => send(c.label, true)}
            >
              {c.label}
              {c.recommended && <span className="font-normal opacity-75">· recommended</span>}
            </Button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3">
        <label htmlFor={`${field}-note`} className="w-14 flex-none text-body text-text-2">
          {choices.length ? "Note" : "Answer"}
        </label>
        <Input
          id={`${field}-note`}
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={choices.length ? 4096 : 1024}
          placeholder={choices.length ? "Add a note…" : "Your answer…"}
          disabled={disabled || sending}
          className="h-8.5 flex-1"
        />
        {choices.length === 0 && (
          <Button type="submit" variant="primary" disabled={disabled || sending || !note.trim()}>
            Send answer
          </Button>
        )}
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {problem && (
        <p role="alert" className="m-0 text-body text-red">
          {problem}
        </p>
      )}
    </form>
  );
}

/** The confirmation line before a release: what stops, what stays, and why it stops. */
function ReleaseForm({
  project,
  ticket,
  release,
  onCancel,
  onReleased,
}: {
  project: string;
  ticket: string;
  release: NonNullable<Acts["release"]>;
  onCancel: () => void;
  onReleased: () => void;
}) {
  const client = useDaemonClient();
  const field = useId();
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      aria-label="Release the ticket"
      className="flex flex-col gap-2.5 rounded-md bg-sunken px-3.5 py-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!reason.trim() || sending) return;
        setSending(true);
        setProblem(null);
        try {
          await client.request({ type: "session.release", project, ticket, ...release, reason: reason.trim() });
          onReleased();
        } catch (error) {
          setProblem(problemOf(error, "The worker was not released. Check the session before trying again."));
        } finally {
          setSending(false);
        }
      }}
    >
      <p className="m-0 text-sub text-text">
        Release {ticket}? Its worker stops now; its branch and any work not pushed stay in its workspace.
      </p>
      <div className="flex items-center gap-3">
        <label htmlFor={`${field}-reason`} className="w-14 flex-none text-body text-text-2">
          Reason
        </label>
        <Input
          id={`${field}-reason`}
          type="text"
          required
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={4096}
          placeholder="Why it stops…"
          disabled={sending}
          className="h-8.5 flex-1"
        />
        <Button type="submit" variant="primary" disabled={sending || !reason.trim()}>
          Release
        </Button>
        <Button type="button" variant="ghost" disabled={sending} onClick={onCancel}>
          Keep it
        </Button>
      </div>
      {problem && (
        <p role="alert" className="m-0 text-body text-red">
          {problem}
        </p>
      )}
    </form>
  );
}

const RUNTIME_WORD: Record<SessionOutputResult["state"], string> = {
  starting: "Starting",
  running: "Running",
  stopped: "Stopped",
  failed: "Failed",
  unknown: "State unknown",
};

/**
 * The worker's terminal output in a drawer at the window's right: read-only,
 * its last lines as the runtime observes them, read again on each new event
 * of the session (`tick`) while it is open. Escape or Close shuts it.
 */
function OutputDrawer({
  project,
  ticket,
  session,
  tick,
  onClose,
}: {
  project: string;
  ticket: string;
  session: string;
  tick: number;
  onClose: () => void;
}) {
  const client = useDaemonClient();
  const { status } = useDaemon();
  const [read, setRead] = useState<SessionOutputResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  const screen = useRef<HTMLPreElement>(null);
  const leave = useRef(onClose);
  leave.current = onClose;
  // Opened: the focus on Close, given back on closing to what opened it (Open the session).
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Handled here: the room's lane, listening on the window, does not also leave the agent.
      e.preventDefault();
      leave.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the subscription's word that the session moved.
  useEffect(() => {
    if (status !== "live") return;
    let current = true;
    client
      .request({ type: "session.output", project, ticket, session })
      .then((r) => {
        if (!current) return;
        setRead(r);
        setProblem(null);
      })
      .catch((error: unknown) => {
        if (current) setProblem(problemOf(error, "The worker's output could not be read."));
      });
    return () => {
      current = false;
    };
  }, [client, project, ticket, session, tick, status]);
  // The newest line in view, as a terminal keeps it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolled on each new reading.
  useEffect(() => {
    const el = screen.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [read]);
  return (
    <aside
      role="dialog"
      aria-label={`${ticket}'s session`}
      className="fixed inset-y-0 right-0 z-40 flex w-[min(640px,100vw)] flex-col border-line border-l bg-card shadow-[0_0_40px_rgba(0,0,0,0.5)]"
    >
      <div className="flex min-h-12 flex-none items-center gap-2.5 border-line border-b px-4 text-body text-text-2">
        <span className="font-medium font-mono text-text">{ticket}</span>
        <Dot />
        <span>
          {read ? `${RUNTIME_WORD[read.state]}${read.activity ? ` · ${read.activity}` : ""}` : "Reading the output…"}
        </span>
        <span className="text-text-3">read-only</span>
        <Button ref={close} variant="ghost" className="ml-auto" onClick={onClose}>
          Close
        </Button>
      </div>
      {problem && (
        <p role="alert" className="m-0 border-line border-b px-4 py-2.5 text-body text-red">
          {problem}
        </p>
      )}
      <pre
        ref={screen}
        role="log"
        aria-label="Output"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the keyboard scrolls the output.
        tabIndex={0}
        data-output
        className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-sunken px-4 py-3 font-mono text-body text-text-soft"
      >
        {read && (read.lines.length ? read.lines.join("\n") : "No output yet.")}
      </pre>
    </aside>
  );
}
