import { CHAT_MINOR, SESSION_MINOR, type SessionOutputResult } from "@armada/protocol";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { TONE } from "@/components/fleet/FleetList";
import { Dot, Input, Page, PageHeader } from "@/components/page";
import { Button, buttonVariants } from "@/components/ui/button";
import { fleetOf } from "@/fleet/state";
import { cn } from "@/lib/utils";
import { useDaemon, useDaemonClient } from "@/protocol/store";
import { sessionHref, type Tab } from "@/session/route";
import {
  type Acts,
  type Card,
  type Entry,
  type FileChange,
  findSession,
  PAGE_STEPS,
  type PageState,
  type PullRequestFact,
  type SessionView,
  STATE_LABEL,
  stamp,
} from "@/session/view";

const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Each state's colour, the list's; released is as quiet as merged. */
const TONES: Record<PageState, { text: string; bg: string }> = { ...TONE, released: TONE.merged };

/** The card's edge in its state's colour: the whole edge, never a side border. */
const EDGE: Record<PageState, string> = {
  blocked: "border-red/55",
  you: "border-amber/55",
  running: "border-blue/45",
  ready: "border-green/50",
  merged: "border-merged/45",
  released: "border-merged/45",
};

/** The quiet line: the state, said of this one session. */
const HINT: Record<PageState, string> = {
  blocked: "Blocked: it can't go on without someone.",
  you: "Waiting for you: a decision only you can take.",
  running: "In progress: moving on its own.",
  ready: "Ready to merge: approved, the coordinator merges.",
  merged: "Merged.",
  released: "Released: no worker holds this ticket now.",
};

/** Said beside the decisions the app cannot take yet (plans and validations). */
const NOT_YET = "Not available yet.";

/**
 * A session's page (`#/sessions/<ticket>`, THE-2028), in the v7 anatomy: the
 * facts line (back to the project, the ticket, its project, runtime and
 * harness, branch, pull request and its checks, when it was claimed and last
 * reported), the ticket's title, the state's hint; then a card edged in the
 * state's colour saying the state and what to do about it, the six steps, and
 * two tabs: the session's reports and events, newest first, and its pull
 * request's files. Read from the project's folded state and the events the
 * subscription replayed; `now` and `zone` are the viewer's unless a test gives them.
 * The card's buttons act (THE-2045): Answer, Release the ticket and Open the
 * session, each through one of the daemon's requests.
 */
export function Session({
  ticket,
  tab,
  now: givenNow,
  zone: givenZone,
}: {
  ticket: string;
  tab: Tab;
  now?: number;
  zone?: string;
}) {
  const { projects, fleets, logs } = useDaemon();
  const now = givenNow ?? Date.now();
  const zone = givenZone ?? viewerZone();
  const read = projects?.every((p) => fleets[p.id]) ?? false;
  // A page opened from a scrolled list starts at its top, the keyboard's focus on its title.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per ticket the page opens on.
  useEffect(() => {
    const main = document.querySelector("main");
    main?.scrollTo?.(0, 0);
    const title = main?.querySelector<HTMLElement>("header h1");
    if (!title) return;
    title.tabIndex = -1;
    title.classList.add("outline-none");
    title.focus({ preventScroll: true });
  }, [ticket]);
  const view = useMemo(
    () =>
      findSession(ticket, projects ?? [], (id) => {
        const snapshot = fleets[id];
        return snapshot ? { state: fleetOf(snapshot), events: logs[id]?.events ?? [] } : null;
      }),
    [ticket, projects, fleets, logs],
  );
  if (!view)
    return (
      <Page>
        <PageHeader
          facts={
            <span className="text-body">
              <a href="#/" className="text-text-2 hover:text-text">
                ← Hangar
              </a>
            </span>
          }
          title={<span className="font-mono">{ticket}</span>}
          quiet={
            projects === null
              ? "Waiting for the daemon to list its projects."
              : read
                ? `No project of this daemon has a session on ${ticket}.`
                : "Reading the projects' logs."
          }
        />
      </Page>
    );
  const at = (time: string | null) => (time ? stamp(time, now, zone) : "");
  const { facts, group } = view;
  // The session's latest event: an open output drawer reads the runtime again on each one.
  const tick = (logs[view.project.id]?.events ?? []).findLast(
    (e) => (e.payload as { ticket?: unknown } | null)?.ticket === view.ticket,
  )?.seq;
  return (
    <Page>
      <PageHeader
        facts={
          <span className="contents text-body">
            <a href={`#/projects/${encodeURIComponent(view.project.id)}`} className="text-text-2 hover:text-text">
              ← {view.project.name}
            </a>
            <Dot />
            <span className="font-mono text-text">{view.ticket}</span>
            <Dot />
            <span>
              {facts.runtime}
              {facts.harness && facts.harness.toLowerCase() !== facts.runtime.toLowerCase() && ` · ${facts.harness}`}
            </span>
            {facts.branch && (
              <>
                <Dot />
                <span className="max-w-[36ch] truncate font-mono" title={facts.branch}>
                  {facts.branch}
                </span>
              </>
            )}
            {facts.pr && (
              <>
                <Dot />
                <PullRequest pr={facts.pr} />
              </>
            )}
            {facts.claimedAt && (
              <>
                <Dot />
                <span>
                  claimed <span className="font-mono tnum">{at(facts.claimedAt)}</span>
                </span>
              </>
            )}
            {facts.reportedAt && (
              <>
                <Dot />
                <span>
                  last report <span className="font-mono tnum">{at(facts.reportedAt)}</span>
                </span>
              </>
            )}
          </span>
        }
        title={view.title}
        quiet={HINT[group]}
      />
      <StateCard view={view} at={at} tick={tick ?? 0} />
      <Steps step={view.step} group={group} />
      <Tabs view={view} tab={tab} at={at} />
    </Page>
  );
}

function PullRequest({ pr }: { pr: PullRequestFact }) {
  const ink = pr.ci === "failure" ? "text-red" : pr.ci === "success" ? "text-green" : "text-text-2";
  const number = <span className="font-mono text-text">#{pr.number}</span>;
  return (
    <span>
      {pr.url ? (
        <a href={pr.url} target="_blank" rel="noreferrer" className="hover:underline">
          {number}
        </a>
      ) : (
        number
      )}{" "}
      <span className={ink}>{pr.checks}</span>
    </span>
  );
}

function StateCard({ view, at, tick }: { view: SessionView; at: (time: string | null) => string; tick: number }) {
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
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
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

/** The six steps: the done ones grey, the current one in its state's colour and marked, those to come dark. */
function Steps({ step, group }: { step: number; group: PageState }) {
  return (
    <ol aria-label="Steps" className="m-0 grid list-none grid-cols-6 gap-1.5 p-0">
      {PAGE_STEPS.map((s, k) => {
        const state = k < step ? "done" : k === step ? "current" : "next";
        return (
          <li
            key={s}
            data-step={state}
            aria-current={state === "current" ? "step" : undefined}
            className="flex min-w-0 flex-col gap-1.5"
          >
            <span
              aria-hidden
              className={`h-1 rounded-[1px] ${state === "done" ? "bg-step-done" : state === "current" ? TONES[group].bg : "bg-step-next"}`}
            />
            <span
              className={cn(
                "truncate text-body",
                state === "current" ? "font-medium text-text" : state === "done" ? "text-text-2" : "text-text-3",
              )}
            >
              {s}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const TAB_LABEL: Record<Tab, string> = { reports: "Reports", files: "Files" };

function Tabs({ view, tab, at }: { view: SessionView; tab: Tab; at: (time: string | null) => string }) {
  return (
    <section className="flex min-w-0 flex-col">
      <nav aria-label="Session" className="flex gap-5 border-line border-b">
        {(["reports", "files"] as const).map((t) => (
          <a
            key={t}
            aria-current={t === tab ? "page" : undefined}
            href={sessionHref(view.ticket, t)}
            className={cn(
              "-mb-px flex h-9 items-center gap-1.5 border-b text-body",
              t === tab ? "border-text font-medium text-text" : "border-transparent text-text-2 hover:text-text",
            )}
          >
            {TAB_LABEL[t]}
            <span className="font-mono text-text-3 tnum">
              {t === "reports" ? view.entries.length : view.files.length}
            </span>
          </a>
        ))}
      </nav>
      <div data-tab={tab}>
        {tab === "reports" ? (
          <Reports entries={view.entries} at={at} />
        ) : (
          <Files files={view.files} pr={view.facts.pr} />
        )}
      </div>
    </section>
  );
}

const quiet = (text: string) => <p className="m-0 py-6 text-center text-body text-text-3">{text}</p>;

/** Each report or event on one line, its text cut with an ellipsis; a click opens the whole of it. */
function Reports({ entries, at }: { entries: readonly Entry[]; at: (time: string | null) => string }) {
  if (!entries.length) return quiet("No report yet.");
  const line =
    "grid min-h-10 grid-cols-[minmax(52px,max-content)_minmax(0,max-content)_minmax(0,1fr)] items-center gap-3.5 px-1";
  return (
    <ol className="m-0 flex list-none flex-col p-0">
      {entries.map((e) => {
        const head = (
          <>
            <span className="whitespace-nowrap font-mono text-body text-text-3 tnum">{at(e.at)}</span>
            <span className="truncate text-body text-text">{e.title}</span>
            <span className="truncate text-body text-text-2">{firstLine(e.body)}</span>
          </>
        );
        return (
          <li key={e.seq} data-entry={e.seq} className="border-line-soft border-b">
            {e.body.trim() ? (
              <details className="group">
                <summary
                  className={cn(line, "cursor-pointer list-none hover:bg-hover [&::-webkit-details-marker]:hidden")}
                >
                  {head}
                </summary>
                <p className="m-0 whitespace-pre-wrap px-1 pb-3 text-body text-text-soft">{e.body.trim()}</p>
              </details>
            ) : (
              <div className={line}>{head}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

const firstLine = (text: string) =>
  text
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? "";

function Files({ files, pr }: { files: readonly FileChange[]; pr: PullRequestFact | null }) {
  if (!pr) return quiet("No pull request yet.");
  if (!files.length) return quiet(`No file of #${pr.number} read yet.`);
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {files.map((f) => (
        <li
          key={f.path}
          data-file={f.path}
          className="grid h-10 grid-cols-[minmax(0,1fr)_max-content_max-content] items-center gap-3.5 border-line-soft border-b px-1 font-mono text-body tnum"
        >
          <span className="truncate text-text" title={f.path}>
            {f.path}
          </span>
          <span className="text-green">+{f.additions}</span>
          <span className="text-red">−{f.deletions}</span>
        </li>
      ))}
    </ul>
  );
}
