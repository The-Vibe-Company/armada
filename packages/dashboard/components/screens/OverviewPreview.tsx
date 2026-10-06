"use client";

// The overview's preview pane (THE-1020, design/dashboard-v7): the session a
// row selects, its state and what to do about it first. A worker's question
// is answered and a plan approved or amended as on its page (DecisionCard:
// a request in the coordinator's inbox); a merge to approve or an escalated
// question is decided as on the Validations page (ValidationCard), a piece
// of work to check opens there, with its images; a red CI or a conflict
// opens its pull request. Then its step, its pull request, CI, files and
// last report, its last reports, and its page. Loaded apart from the list.
import type { ActivityEntry, FleetRow, OwnerValidation } from "@armada/core/read";
import Link from "next/link";
import type { ReactNode } from "react";
import { mergePullRequest } from "@/app/actions";
import { clockIn } from "@/lib/activity-view";
import type { OverviewItem } from "@/lib/coordinator-view";
import { paths } from "@/lib/fleet-view";
import type { Strings } from "@/lib/i18n";
import { decisionCards, handBackPr, sentRequest } from "@/lib/overview-view";
import { mergeAsked } from "@/lib/queue-view";
import { type ActionContext, splitQuestion } from "../Actions";
import { useFleet, useNow, useShell } from "../shell/context";
import { RequestAction } from "./AgentActions";
import { DecisionActions } from "./DecisionCard";
import { JobStrip } from "./JobStrip";
import { itemColor, itemHref, StepBar } from "./OverviewRow";
import { useActivity } from "./use-activity";
import { Decide } from "./ValidationDecide";

/** How many reports the pane lists. */
const REPORTS = 3;

export function OverviewPreview({
  item,
  projectName,
  owner,
}: {
  item: OverviewItem;
  projectName: string;
  /** The session's coordinator, where its project names them (THE-1112). */
  owner: string | null;
}) {
  const { t, account, author, setAuthor, zone } = useShell();
  const { overview, failed, version, refresh } = useFleet();
  const now = useNow();
  const color = itemColor(item);
  const ctx: ActionContext = {
    t,
    signer: { name: author, set: setAuthor, fixed: account !== null },
    live: overview.live.state === "ok" && !failed,
    now,
    version,
    refresh,
  };
  const p = t.overview.preview;
  const row = item.row;
  const files = row?.pr?.files ?? null;
  const facts: { k: string; v: ReactNode; color?: string; mono?: boolean }[] = [
    { k: p.pr, v: item.pr ? `#${item.pr.number}` : p.notYet, mono: true },
    {
      k: p.ci,
      v: row?.pr?.ci ? p.ciStates[row.pr.ci] : "—",
      color: row?.pr?.ci === "success" ? "var(--green)" : row?.pr?.ci === "failure" ? "var(--red)" : undefined,
    },
    {
      k: p.files,
      v: files?.length ? `${files.length} · +${row?.pr?.additions ?? 0} −${row?.pr?.deletions ?? 0}` : "—",
      mono: true,
    },
    {
      k: p.lastReport,
      v: row?.lastReport ? p.ago(t.duration(Math.max(0, now - Date.parse(row.lastReport)))) : "—",
      color: row?.silent ? "var(--amber)" : undefined,
    },
  ];
  const steps = t.overview.steps;

  return (
    <div className="ov-pv">
      <div className="ov-pv-head">
        <span className="ov-pv-meta">
          <span className="mono">{item.id}</span>
          <span aria-hidden>·</span>
          <span>{projectName}</span>
          {owner && (
            <>
              <span aria-hidden>·</span>
              <span>{t.agentPage.owner(owner)}</span>
            </>
          )}
        </span>
        <span className="ov-pv-title">{item.title}</span>
      </div>
      <div className="ov-pv-state">
        <span className="ov-pv-group" style={{ color }}>
          <span className="ov-dot" style={{ background: color }} aria-hidden />
          {t.overview.groups[item.group]}
        </span>
        <Action item={item} ctx={ctx} projectName={projectName} />
      </div>
      <JobStrip project={item.project} ticket={item.id} heading="ov-pv-h" />
      <div className="ov-pv-block">
        <span className="ov-pv-h">{p.step}</span>
        <span className="ov-pv-steps">
          <StepBar step={item.step} color={color} wide />
          <span className="ov-pv-labels" aria-hidden>
            {steps.map((s, k) => (
              <span key={s} className={k === item.step ? "is-now" : k < item.step ? "is-done" : undefined}>
                {s}
              </span>
            ))}
          </span>
        </span>
      </div>
      <dl className="ov-pv-facts">
        {facts.map((f) => (
          <div key={f.k}>
            <dt>{f.k}</dt>
            <dd className={f.mono ? "mono" : undefined} style={f.color ? { color: f.color } : undefined}>
              {f.v}
            </dd>
          </div>
        ))}
      </dl>
      <div className="ov-pv-block">
        <span className="ov-pv-h">{p.reports}</span>
        {row ? <Reports row={row} t={t} zone={zone} /> : <MergedReport item={item} t={t} zone={zone} />}
      </div>
      <Link href={itemHref(item)} prefetch={false} className="ov-pv-open">
        {item.row || !item.pr ? p.open : t.shell.openPr(item.pr.number)}
      </Link>
    </div>
  );
}

/** What the worker said last: its reports and the other steps of its history, newest first (as core gives them). */
function Reports({ row, t, zone }: { row: FleetRow; t: Strings; zone: string }) {
  const { overview } = useFleet();
  const requests = overview.projects.find((p) => p.slug === row.project)?.requests ?? [];
  const { entries } = useActivity(row, requests);
  const shown = entries.filter((e) => e.text || e.kind === "pr" || e.kind === "merge").slice(0, REPORTS);
  if (!shown.length) return <p className="ov-pv-none">{t.overview.preview.noReports}</p>;
  return (
    <ol className="ov-pv-reports">
      {shown.map((e) => (
        <li key={`${e.kind}-${e.at}`}>
          <time dateTime={e.at}>{clockIn(e.at, zone, t.overview.locale)}</time>
          <span>{entryText(t, e)}</span>
        </li>
      ))}
    </ol>
  );
}

function MergedReport({ item, t, zone }: { item: OverviewItem; t: Strings; zone: string }) {
  if (!item.last || !item.pr) return <p className="ov-pv-none">{t.overview.preview.noReports}</p>;
  return (
    <ol className="ov-pv-reports">
      <li>
        <time dateTime={item.last}>{clockIn(item.last, zone, t.overview.locale)}</time>
        <span>{t.overview.reasons.merged(item.pr.number)}</span>
      </li>
    </ol>
  );
}

/** One entry of a ticket's history in one line, as the pane and the session's page list them. */
export const entryText = (t: Strings, e: ActivityEntry): string => {
  if (e.kind === "question") return splitQuestion(e.text ?? "").text.split("\n")[0] ?? "";
  if (e.kind === "pr") return t.shell.agent.entries.pr(e.pr ?? 0);
  if (e.kind === "merge" && !e.text) return t.shell.agent.entries.merge;
  return (e.text ?? "").split("\n")[0] ?? "";
};

/** The state's sentence and what the owner can do about it: the pane's and the session's page's. */
export function Action({ item, ctx, projectName }: { item: OverviewItem; ctx: ActionContext; projectName: string }) {
  const { t, now } = ctx;
  const { overview } = useFleet();
  const a = t.overview.preview.action;
  const p = t.overview.preview;
  const r = item.reason;
  const row = item.row;
  const v: OwnerValidation | undefined = item.checks[0];
  const project = overview.projects.find((x) => x.slug === item.project);
  const coordinator = project?.coordinator.state ?? "unknown";
  const decision = (kind: "question" | "approval") =>
    decisionCards(overview).find((w) => w.kind === kind && w.project === item.project && w.ticket === item.id);
  const decide = (kind: "question" | "approval") => {
    const w = decision(kind);
    if (!w) return null;
    return (
      <DecisionActions
        ctx={ctx}
        w={w}
        projectName={projectName}
        coordinator={coordinator}
        pr={handBackPr(overview, w)}
        sent={sentRequest(overview, w, handBackPr(overview, w))}
      />
    );
  };
  const line = row?.session?.lastReport?.message || row?.statusLine?.summary || null;
  const prLink = item.pr && (
    <a href={item.pr.url} target="_blank" rel="noreferrer" className="btn is-soft">
      {p.openPr(item.pr.number)}
    </a>
  );
  const validationLink = (label: string, primary = false) =>
    v && (
      <Link href={paths.validation(v.id)} prefetch={false} className={`btn ${primary ? "is-primary" : "is-soft"}`}>
        {label}
      </Link>
    );

  switch (r.kind) {
    case "runtime":
      return <Title>{t.shell.runtimeState[r.state]}</Title>;
    case "question":
      return (
        <>
          <Title>{a.question(row?.question ? t.ago(Math.max(0, now - Date.parse(row.question.at))) : "")}</Title>
          {decide("question") ?? <Body>{r.text}</Body>}
        </>
      );
    case "plan":
      return (
        <>
          <Title>{a.plan}</Title>
          {decide("approval")}
        </>
      );
    case "ci":
      return (
        <>
          <Title>{a.ci(r.pr, (row?.pr?.failingChecks ?? []).join(", "))}</Title>
          <Buttons>{prLink}</Buttons>
        </>
      );
    case "conflict":
      return (
        <>
          <Title>{a.conflict(r.pr)}</Title>
          <Buttons>{prLink}</Buttons>
        </>
      );
    case "silent":
      return (
        <>
          <Title>{a.silent(t.duration(r.since ? Math.max(0, now - Date.parse(r.since)) : 0))}</Title>
          {line && <Body>{a.lastMessage(line)}</Body>}
        </>
      );
    case "blocked":
      return (
        <>
          <Title>{a.blocked}</Title>
          {r.text && <Body>{r.text}</Body>}
        </>
      );
    case "merge":
      return (
        <>
          <Title>{a.merge(r.pr)}</Title>
          {v?.reason && <Body>{v.reason}</Body>}
          {v ? (
            <Decide ctx={ctx} v={v} projectName={projectName} changes={false}>
              {validationLink(p.seeShots)}
            </Decide>
          ) : null}
        </>
      );
    case "owner-question":
      return (
        <>
          <Title>{v?.what ?? r.text}</Title>
          {v?.reason && <Body>{v.reason}</Body>}
          {v && <Decide ctx={ctx} v={v} projectName={projectName} />}
        </>
      );
    case "validation":
      return (
        <>
          <Title>{v?.what ?? r.text}</Title>
          {v?.reason && <Body>{v.reason}</Body>}
          <Buttons>{validationLink(p.openValidation, true)}</Buttons>
        </>
      );
    case "awaiting-validation":
      return <Title>{a.awaitingValidation}</Title>;
    case "ready": {
      // Merge (THE-1103): the queue takes a pull request handed back at its head; else the coordinator decides.
      const m = p.mergeButton;
      const asked = mergeAsked(project, r.pr);
      return (
        <>
          <Title>{a.ready(r.by, r.pr)}</Title>
          {r.pr !== null && (
            <Buttons>
              <RequestAction
                ctx={ctx}
                label={m.label}
                what={m.asked}
                send={mergePullRequest}
                fields={{ project: item.project, ticket: item.id, pr: r.pr }}
                pending={
                  asked && {
                    author: asked.author,
                    createdAt: asked.at,
                    ...(asked.queued ? { what: m.queued, detail: m.queuedDetail } : {}),
                  }
                }
                coordinator={coordinator}
                hint={m.hint}
              />
            </Buttons>
          )}
        </>
      );
    }
    case "merged":
      return <Title>{a.merged(r.pr)}</Title>;
    case "working":
      return <Title>{r.text ?? a.working}</Title>;
  }
}

const Title = ({ children }: { children: ReactNode }) => <p className="ov-pv-reason">{children}</p>;
const Body = ({ children }: { children: ReactNode }) => <p className="ov-pv-body">{children}</p>;
const Buttons = ({ children }: { children: ReactNode }) =>
  children ? <div className="ov-pv-buttons">{children}</div> : null;
