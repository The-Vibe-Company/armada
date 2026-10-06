"use client";

// /agents/[ticket] (THE-1021, design/dashboard-v7): one session. Its ticket,
// project and harness over its title; its state and what to do about it, in
// a card edged in the state's color (the overview pane's `Action`: answers
// and decisions are requests in the coordinator's inbox); its six steps; then
// two tabs, in the address (`?tab=files`): its reports and events beside its
// facts, with "Open the session" and "Release the ticket", or its pull
// request's files. A ticket merged today, no longer in flight, shows from its
// overview line. Renders from the overview the shell polls and the ticket's
// history its page read with it; that history is read again when the ticket
// moves (`/api/fleet/activity`, Postgres only).
import type { ActivityEntry, FleetRow, ProjectOverview } from "@armada/core/read";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { type ReactNode, useMemo } from "react";
import { releaseTicket } from "@/app/actions";
import { clockIn } from "@/lib/activity-view";
import { type OverviewItem, showsOwners } from "@/lib/coordinator-view";
import type { TaggedActivity } from "@/lib/fleet-data";
import { HARNESS_NAME, harnessOf, paths, sessionLink } from "@/lib/fleet-view";
import type { Strings } from "@/lib/i18n";
import type { ActionContext } from "../Actions";
import { useFleet, useNow, useShell } from "../shell/context";
import { useOverviewItems } from "../shell/use-items";
import { EmptyState, RelativeTime, Tabs } from "../ui";
import { RequestAction } from "./AgentActions";
import { JobStrip } from "./JobStrip";
import { Action, entryText } from "./OverviewPreview";
import { itemColor } from "./session-state";
import { useActivity } from "./use-activity";

const TABS = ["summary", "files"] as const;
type Tab = (typeof TABS)[number];

/** An entry's dot: blocked red, the owner's amber, a start blue, a hand-back or merge green, the rest grey. */
function entryColor(e: ActivityEntry): string {
  if (e.kind === "release" || (e.kind === "phase" && e.phase === "blocked")) return "var(--red)";
  if (e.kind === "question" || e.kind === "plan" || e.kind === "request") return "var(--amber)";
  if (e.kind === "claim" || e.kind === "launch") return "var(--blue)";
  if (e.kind === "hand-back" || e.kind === "merge") return "var(--green)";
  return "var(--text-3)";
}

export function AgentScreen({ initialActivity = null }: { initialActivity?: TaggedActivity | null }) {
  const { t, author, setAuthor, account } = useShell();
  const { overview, failed, refresh, version } = useFleet();
  const now = useNow();
  const ticket = decodeURIComponent(String(useParams<{ ticket: string }>().ticket ?? ""));
  const tab: Tab = useSearchParams().get("tab") === "files" ? "files" : "summary";
  const items = useOverviewItems();
  const item = items.find((i) => i.id.toLowerCase() === ticket.toLowerCase());
  const project = overview.projects.find((p) => p.slug === item?.project);
  if (!item)
    return (
      <div className="pg">
        <EmptyState title={t.shell.agentMissing} hint={t.shell.agentMissingHint} />
      </div>
    );
  const ctx: ActionContext = {
    t,
    signer: { name: author, set: setAuthor, fixed: account !== null },
    live: overview.live.state === "ok" && !failed,
    now,
    version,
    refresh,
  };
  return <Agent item={item} project={project} tab={tab} ctx={ctx} initialActivity={initialActivity} />;
}

function Agent({
  item,
  project,
  tab,
  ctx,
  initialActivity,
}: {
  item: OverviewItem;
  project: ProjectOverview | undefined;
  tab: Tab;
  ctx: ActionContext;
  initialActivity: TaggedActivity | null;
}) {
  const { t, now } = ctx;
  const { zone } = useShell();
  const a = t.agentPage;
  const row = item.row;
  const color = itemColor(item);
  const projectName = project?.name ?? item.project;
  const harness = row ? HARNESS_NAME[harnessOf(row.session?.runtime ?? row.runtime)] : null;
  const files = row?.pr?.files ?? [];
  const since =
    item.group === "merged"
      ? item.last && a.mergedAt(clockIn(item.last, zone, t.overview.locale))
      : row && a.since(t.shell.phases[row.phase].toLowerCase(), t.duration(Math.max(0, now - Date.parse(row.since))));
  const steps = t.overview.steps;
  return (
    <div className="pg ag">
      <div className="pg-head">
        <p className="pg-meta">
          {row ? (
            <a href={row.url} target="_blank" rel="noreferrer" className="mono pg-link">
              {item.id}
            </a>
          ) : (
            <span className="mono">{item.id}</span>
          )}
          <span aria-hidden>·</span>
          <Link href={paths.project(item.project)} prefetch={false} className="pg-link">
            {projectName}
          </Link>
          {harness && (
            <>
              <span aria-hidden>·</span>
              <span>{harness}</span>
            </>
          )}
          {(row?.session?.profile ?? row?.profile) && (
            <>
              <span aria-hidden>·</span>
              <span>{row?.session?.profile ?? row?.profile}</span>
            </>
          )}
          {item.owner && project && showsOwners(project, [item]) && (
            <>
              <span aria-hidden>·</span>
              <span>{a.owner(item.owner)}</span>
            </>
          )}
        </p>
        <p className="pg-title">{item.title}</p>
      </div>

      <section className="ag-action" style={{ borderLeftColor: color }} aria-label={t.overview.groups[item.group]}>
        <p className="ag-state">
          <span style={{ color }}>{t.overview.groups[item.group]}</span>
          {since && <span className="ag-since">{since}</span>}
        </p>
        <Action item={item} ctx={ctx} projectName={projectName} />
      </section>
      <JobStrip project={item.project} ticket={item.id} heading="pg-h" />

      <ol className="ag-steps" aria-label={t.overview.stepLabel(steps[Math.min(item.step, steps.length - 1)] ?? "")}>
        {steps.map((s, k) => {
          const state = k < item.step ? "is-done" : k === item.step ? "is-now" : undefined;
          return (
            <li key={s} className={state} aria-current={k === item.step ? "step" : undefined}>
              <span
                className="ag-step-bar"
                style={{
                  background: k < item.step ? "var(--step-done)" : k === item.step ? color : "var(--step-next)",
                }}
                aria-hidden
              />
              <span className="ag-step-label">{s}</span>
              <span className="ag-step-sub">
                {k === item.step && row ? <RelativeTime at={row.since} format="duration" /> : null}
              </span>
            </li>
          );
        })}
      </ol>

      <Tabs
        label={a.tabs}
        value={tab}
        controls="ag-tab"
        items={TABS.map((k) => ({
          key: k,
          label: k === "files" ? a.files(files.length) : a.summary,
          href: k === "files" ? `${paths.agent(item.id)}?tab=files` : paths.agent(item.id),
        }))}
      />
      <div id="ag-tab" role="tabpanel">
        {tab === "files" ? (
          <Files row={row} t={t} />
        ) : (
          <div className="ag-cols">
            <div className="ag-col">
              <p className="pg-h">{a.history}</p>
              {row ? (
                <History row={row} project={project} t={t} zone={zone} initial={initialActivity} />
              ) : (
                <ol className="ag-history">
                  {item.last && item.pr && (
                    <li>
                      <time dateTime={item.last}>{clockIn(item.last, zone, t.overview.locale)}</time>
                      <span className="ag-history-dot" style={{ background: "var(--green)" }} aria-hidden />
                      <span>{t.overview.reasons.merged(item.pr.number)}</span>
                    </li>
                  )}
                </ol>
              )}
            </div>
            <div className="ag-col">
              <p className="pg-h">{a.details}</p>
              <Facts item={item} t={t} zone={zone} now={now} />
              {row && <SessionButtons row={row} project={project} ctx={ctx} />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The session's history, newest first: its reports, phases, questions, pull request and merge. */
function History({
  row,
  project,
  t,
  zone,
  initial,
}: {
  row: FleetRow;
  project: ProjectOverview | undefined;
  t: Strings;
  zone: string;
  initial: TaggedActivity | null;
}) {
  const requests = useMemo(() => project?.requests ?? [], [project]);
  const activity = useActivity(row, requests, initial);
  const shown = activity.entries.filter((e) => entryText(t, e) || e.kind === "claim" || e.kind === "branch");
  if (!shown.length) return <p className="pg-none">{t.overview.preview.noReports}</p>;
  return (
    <ol className="ag-history">
      {shown.map((e, k) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: entries have no id; the list is rebuilt whole
        <li key={`${e.kind}-${e.at}-${k}`}>
          <time dateTime={e.at}>{clockIn(e.at, zone, t.overview.locale)}</time>
          <span className="ag-history-dot" style={{ background: entryColor(e) }} aria-hidden />
          <span>{line(t, e)}</span>
        </li>
      ))}
    </ol>
  );
}

/** What an entry says: its own words, else what happened. */
function line(t: Strings, e: ActivityEntry): string {
  const x = t.shell.agent.entries;
  const text = entryText(t, e);
  if (text) return text;
  switch (e.kind) {
    case "claim":
      return x.claim(e.runtime ? HARNESS_NAME[harnessOf(e.runtime)] : "—");
    case "branch":
      return x.branch(e.branch ?? "");
    case "launch":
      return x.launch(e.author ?? "—");
    case "phase":
      return x.phase(e.phase ? t.shell.phases[e.phase] : "—");
    case "release":
      return x.release;
    default:
      return "";
  }
}

function Facts({ item, t, zone, now }: { item: OverviewItem; t: Strings; zone: string; now: number }) {
  const a = t.agentPage;
  const p = t.overview.preview;
  const row = item.row;
  const pr = row?.pr ?? null;
  const session = row?.session ?? null;
  const facts: { k: string; v: ReactNode; color?: string; mono?: boolean }[] = [
    {
      k: p.pr,
      v: item.pr ? (
        <a href={item.pr.url} target="_blank" rel="noreferrer" className="pg-link">
          #{item.pr.number}
        </a>
      ) : (
        p.notYet
      ),
      mono: true,
    },
    {
      k: p.ci,
      v: pr?.ci ? p.ciStates[pr.ci] : "—",
      color: pr?.ci === "success" ? "var(--green)" : pr?.ci === "failure" ? "var(--red)" : undefined,
    },
    {
      k: p.files,
      v: pr?.files?.length ? `${pr.files.length} · +${pr.additions ?? 0} −${pr.deletions ?? 0}` : "—",
      mono: true,
    },
    {
      k: p.lastReport,
      v: row?.lastReport ? p.ago(t.duration(Math.max(0, now - Date.parse(row.lastReport)))) : "—",
      color: row?.silent ? "var(--amber)" : undefined,
    },
    { k: a.harness, v: row ? HARNESS_NAME[harnessOf(session?.runtime ?? row.runtime)] : "—" },
    { k: a.session, v: session?.handle ?? row?.handle ?? "—", mono: true },
    {
      k: a.model,
      v: [session?.profile ?? row?.profile, session?.model].filter(Boolean).join(" · ") || "—",
      mono: true,
    },
    { k: a.claimed, v: session ? clockIn(session.claimedAt, zone, t.overview.locale) : "—", mono: true },
  ];
  return (
    <dl className="pg-facts">
      {facts.map((f) => (
        <div key={f.k}>
          <dt>{f.k}</dt>
          <dd className={f.mono ? "mono" : undefined} style={f.color ? { color: f.color } : undefined}>
            {f.v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Open the worker's session where its harness has a link, and ask the coordinator to release the ticket. */
function SessionButtons({
  row,
  project,
  ctx,
}: {
  row: FleetRow;
  project: ProjectOverview | undefined;
  ctx: ActionContext;
}) {
  const a = ctx.t.agentPage;
  const link = sessionLink(row.runtime, row.session?.handle ?? row.handle);
  const pending = project?.requests.find((i) => i.kind === "release-request" && i.ticket === row.id) ?? null;
  return (
    <div className="ag-buttons">
      {link && (
        <a className="btn is-soft" href={link}>
          {a.openSession}
        </a>
      )}
      <RequestAction
        ctx={ctx}
        label={a.release}
        what={ctx.t.shell.agent.requests["release-request"]}
        send={releaseTicket}
        fields={{ project: row.project, ticket: row.id }}
        pending={pending}
        coordinator={project?.coordinator.state ?? "unknown"}
        hint={ctx.t.shell.agent.releaseHint}
      />
    </div>
  );
}

function Files({ row, t }: { row: FleetRow | null; t: Strings }) {
  const files = row?.pr?.files ?? [];
  if (!files.length) return <p className="pg-none">{t.agentPage.noFiles}</p>;
  return (
    <>
      <ul className="ag-files">
        {files.map((f) => (
          <li key={f.path}>
            <span className="ag-file-path">{f.path}</span>
            <span className="ag-file-add">+{f.additions}</span>
            <span className="ag-file-del">−{f.deletions}</span>
          </li>
        ))}
      </ul>
      {row?.pr?.filesComplete === false && <p className="pg-none">{t.shell.agent.filesIncomplete}</p>}
    </>
  );
}
