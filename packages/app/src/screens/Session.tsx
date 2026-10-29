import type { ReactNode } from "react";
import { useMemo } from "react";
import { TONE } from "@/components/fleet/FleetList";
import { Dot, Page, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import type { Group } from "@/fleet/overview";
import { fleetOf } from "@/fleet/state";
import { cn } from "@/lib/utils";
import { useDaemon } from "@/protocol/store";
import { sessionHref, type Tab } from "@/session/route";
import {
  type Card,
  type Entry,
  type FileChange,
  findSession,
  PAGE_STEPS,
  type PullRequestFact,
  type SessionView,
  STATE_LABEL,
  stamp,
} from "@/session/view";

const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** The card's edge in its state's colour: the whole edge, never a side border. */
const EDGE: Record<Group, string> = {
  blocked: "border-red/55",
  you: "border-amber/55",
  running: "border-blue/45",
  ready: "border-green/50",
  merged: "border-merged/45",
};

/** The quiet line: the state, said of this one session. */
const HINT: Record<Group, string> = {
  blocked: "Blocked: it can't go on without someone.",
  you: "Waiting for you: a decision only you can take.",
  running: "In progress: moving on its own.",
  ready: "Ready to merge: approved, the coordinator merges.",
  merged: "Merged.",
};

/** Said beside every action the app cannot take yet (the workers' runtime is Spec 3). */
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
                ← Fleet
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
      <StateCard view={view} at={at} />
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

function StateCard({ view, at }: { view: SessionView; at: (time: string | null) => string }) {
  const { card, group } = view;
  return (
    <section
      aria-label="State"
      data-state={group}
      className={cn("flex min-w-0 flex-col gap-3 rounded-card border bg-card px-4.5 py-4", EDGE[group])}
    >
      <div className="flex items-center gap-2.5">
        <span aria-hidden className={`size-2 flex-none rounded-full ${TONE[group].bg}`} />
        <span className={`font-medium text-sub ${TONE[group].text}`}>{STATE_LABEL[group]}</span>
      </div>
      <CardBody card={card} at={at} />
    </section>
  );
}

function CardBody({ card, at }: { card: Card; at: (time: string | null) => string }) {
  switch (card.kind) {
    case "blocked":
      return (
        <>
          <p className="m-0 whitespace-pre-wrap text-sub text-text">{card.question?.question || card.reason}</p>
          {card.question && card.question.choices.length > 0 && <Choices choices={card.question.choices} />}
          <Actions>
            <Button variant="soft" disabled>
              Answer
            </Button>
            <Button variant="soft" disabled>
              Release the ticket
            </Button>
            <Button variant="soft" disabled>
              Open the session
            </Button>
          </Actions>
        </>
      );
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
          <Choices choices={card.choices} />
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

function Choices({ choices }: { choices: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {choices.map((c, i) => (
        <Button key={c} variant={i === 0 ? "primary" : "soft"} disabled>
          {c}
        </Button>
      ))}
    </div>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">{children}</div>
      <p className="m-0 text-body text-text-3">{NOT_YET}</p>
    </div>
  );
}

/** The six steps: the done ones grey, the current one in its state's colour and marked, those to come dark. */
function Steps({ step, group }: { step: number; group: Group }) {
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
              className={`h-1 rounded-[1px] ${state === "done" ? "bg-step-done" : state === "current" ? TONE[group].bg : "bg-step-next"}`}
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
      <div role="tablist" aria-label="Session" className="flex gap-5 border-line border-b">
        {(["reports", "files"] as const).map((t) => (
          <a
            key={t}
            role="tab"
            aria-selected={t === tab}
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
      </div>
      <div role="tabpanel" aria-label={TAB_LABEL[tab]}>
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
