import { useEffect, useMemo } from "react";
import { Dot, Page, PageHeader } from "@/components/page";
import { fleetOf } from "@/fleet/state";
import { cn } from "@/lib/utils";
import { useDaemon } from "@/protocol/store";
import { Facts } from "@/session/Facts";
import { Quiet, Reports } from "@/session/Reports";
import { sessionHref, type Tab } from "@/session/route";
import { StateCard } from "@/session/StateCard";
import { Steps } from "@/session/Steps";
import {
  type FileChange,
  findSession,
  type PageState,
  type PullRequestFact,
  type SessionView,
  stamp,
} from "@/session/view";

const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** The quiet line: the state, said of this one session. */
const HINT: Record<PageState, string> = {
  blocked: "Blocked: it can't go on without someone.",
  you: "Waiting for you: a decision only you can take.",
  running: "In progress: moving on its own.",
  ready: "Ready to merge: approved, the coordinator merges.",
  merged: "Merged.",
  released: "Released: no worker holds this ticket now.",
};

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
            <Facts facts={facts} at={at} />
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
function Files({ files, pr }: { files: readonly FileChange[]; pr: PullRequestFact | null }) {
  if (!pr) return <Quiet text="No pull request yet." />;
  if (!files.length) return <Quiet text={`No file of #${pr.number} read yet.`} />;
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
