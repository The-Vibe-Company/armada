"use client";

// /agents/[ticket] (THE-869): one session from plan to merge. Its status and
// steps, what waits for the owner with the same requests as the overview, its
// activity and its pull request's files, and its session, coordinator and
// code facts. Renders from the overview the shell polls and the ticket's
// history its page read with it; that history is read again when the ticket
// moves (`/api/fleet/activity`, Postgres only).
import {
  type ActivityEntry,
  agentActivity,
  type FleetRow,
  type InboxItem,
  type ProjectOverview,
  type RequestKind,
} from "@armada/core/read";
import { useParams, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { releaseTicket } from "@/app/actions";
import type { TaggedActivity } from "@/lib/fleet-data";
import {
  type AgentState,
  agentState,
  coordinatorHarness,
  fileShape,
  HARNESS_NAME,
  type Harness,
  harnessOf,
  paths,
  sessionLink,
  stepStates,
} from "@/lib/fleet-view";
import type { Strings } from "@/lib/i18n";
import { decisionCards, handBackPr, sentRequest } from "@/lib/overview-view";
import { type ActionContext, splitQuestion } from "../Actions";
import {
  Columns,
  HeaderActions,
  LONG_LIST,
  Page,
  Row,
  RowIcon,
  RowId,
  RowSide,
  RowText,
  RowTime,
  Section,
  SectionBody,
} from "../page";
import { useFleet, useNow, useShell } from "../shell/context";
import { stateLabel } from "../shell/labels";
import {
  Dot,
  EmptyState,
  HarnessBadge,
  harnessColor,
  ProjectChip,
  RelativeTime,
  StatusDot,
  Tabs,
  toneColor,
} from "../ui";
import { RequestAction } from "./AgentActions";
import { rowLine, rowProgress } from "./AgentRow";
import { Attachments, useAttachments } from "./Attachments";
import { DecisionActions } from "./DecisionCard";

/** A key and its value, as a static row. */
function Fact({ k, children, color }: { k: ReactNode; children: ReactNode; color?: string }) {
  return (
    <Row>
      <span className="sc-fact-k">{k}</span>
      <span className="sc-fact-v" style={color ? { color } : undefined}>
        {children}
      </span>
    </Row>
  );
}

/** A time of day in the viewer's zone: rendered after mount, so the server's zone never shows. */
function Clock({ at }: { at: string }) {
  const { lang } = useShell();
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(new Date(at).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }));
  }, [at, lang]);
  return <time dateTime={at}>{text ?? "—"}</time>;
}

const ciColor = (ci: string | null | undefined) =>
  ci === "success" ? "var(--done)" : ci === "failure" ? "var(--critical)" : "var(--active)";

/** The open request of a kind the overview holds for this ticket. */
const openRequest = (p: ProjectOverview | undefined, kind: RequestKind, match: (i: InboxItem) => boolean) =>
  p?.requests.find((i) => i.kind === kind && match(i)) ?? null;

/** What the overview already knows of the ticket's history, shown until the full read answers. */
function knownActivity(row: FleetRow): ActivityEntry[] {
  const s = row.session;
  return agentActivity({
    comments: [],
    events: [
      ...(s
        ? [
            {
              kind: "claim" as const,
              phase: "planning",
              message: null,
              runtime: s.runtime,
              handle: s.handle,
              prUrl: null,
              at: s.claimedAt,
            },
          ]
        : []),
      ...(row.statusLine
        ? [
            {
              kind: "report" as const,
              phase: row.phase,
              message: row.statusLine.summary,
              runtime: null,
              handle: null,
              prUrl: null,
              at: row.statusLine.at,
            },
          ]
        : []),
    ],
    inbox: row.question
      ? [
          {
            id: row.question.id,
            project: row.project,
            ticket: row.id,
            kind: "question",
            recipient: "coordinator",
            author: row.question.author,
            body: row.question.body,
            createdAt: row.question.at,
            resolvedAt: null,
            resolution: null,
          },
        ]
      : [],
    launches: [],
    prs: [],
  });
}

/**
 * The ticket's history from the server, read again when the row changes;
 * the server answers 304 while it is the same.
 */
function useActivity(row: FleetRow, requests: InboxItem[], initial: TaggedActivity | null) {
  const [read, setRead] = useState<{ key: string; entries: ActivityEntry[]; live: boolean } | null>(null);
  const tag = useRef<string | null>(null);
  const project = row.project;
  const ticket = row.id;
  const key = `${project}/${ticket}`;
  // The activity the page was rendered with, while it is this ticket's.
  const given = initial && `${initial.activity.project}/${initial.activity.ticket}` === key ? initial : null;
  const changed = [
    row.lastUpdate,
    row.lastReport,
    row.phase,
    row.question?.id,
    row.pr?.number,
    ...requests.filter((r) => r.ticket === ticket).map((r) => r.id),
  ].join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `changed` says when the history may have changed.
  useEffect(() => {
    let live = true;
    const url = `/api/fleet/activity?project=${encodeURIComponent(project)}&ticket=${encodeURIComponent(ticket)}`;
    const known = read?.key === key ? tag.current : (given?.tag ?? null);
    fetch(url, { cache: "no-store", headers: known ? { "If-None-Match": known } : {} })
      .then(async (res) => {
        if (res.status === 304 || !res.ok || !live) return;
        const body = (await res.json()) as { entries: ActivityEntry[]; live: boolean };
        tag.current = res.headers.get("etag");
        setRead({ key, entries: body.entries, live: body.live });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [project, ticket, changed]);
  if (read?.key === key) return read;
  if (given) return { key, entries: given.activity.entries, live: given.activity.live };
  return { entries: knownActivity(row), live: true, key: "" };
}

function ActivityRow({ e, row, t }: { e: ActivityEntry; row: FleetRow; t: Strings }) {
  const a = t.shell.agent;
  const x = a.entries;
  const harness = (r: string | null) => (r ? HARNESS_NAME[harnessOf(r)] : "—");
  const view = ((): { title: string; line?: string | null; color: string } => {
    switch (e.kind) {
      case "launch":
        return { title: x.launch(e.author ?? "—"), color: "var(--text-4)" };
      case "claim":
        return {
          title: x.claim(harness(e.runtime)),
          line: [e.handle && x.session(e.handle), e.profile && x.profile(e.profile)].filter(Boolean).join(" · "),
          color: "var(--text-4)",
        };
      case "branch":
        return { title: x.branch(e.branch ?? ""), color: "var(--text-4)" };
      case "phase":
        return {
          title: x.phase(e.phase ? t.shell.phases[e.phase] : "—"),
          line: e.text,
          color: e.phase === "blocked" ? "var(--critical)" : "var(--frontier)",
        };
      case "report":
        return { title: x.report, line: e.text, color: "var(--done)" };
      case "question":
        return { title: x.question, line: e.text && splitQuestion(e.text).text, color: "var(--accent)" };
      case "plan":
        return { title: x.plan, line: e.text, color: "var(--accent)" };
      case "answer":
        return { title: x.answer, line: e.text, color: "var(--frontier)" };
      case "hand-back":
        return { title: x.handBack, line: e.text, color: "var(--done)" };
      case "note":
        return { title: x.note, line: e.text, color: "var(--frontier)" };
      case "request":
        return {
          title: x.request(e.request ? a.requests[e.request] : "—", e.author),
          line: e.resolvedAt ? x.resolved : e.request === "plan-changes" ? e.text : null,
          color: "var(--accent)",
        };
      case "pr": {
        const files = row.pr?.number === e.pr ? row.pr.files : null;
        return {
          title: x.pr(e.pr ?? 0),
          line: files ? `${a.fileCount(files.length)} · +${row.pr?.additions ?? 0} −${row.pr?.deletions ?? 0}` : null,
          color: "var(--text)",
        };
      }
      case "release":
        return { title: x.release, line: e.text, color: "var(--critical)" };
      case "merge":
        return { title: x.merge, line: e.text, color: "var(--done)" };
      default:
        return { title: x.comment(e.author), line: e.text, color: "var(--text-3)" };
    }
  })();
  return (
    <Row className="sc-activity">
      <RowIcon>
        <Dot color={view.color} size={8} />
      </RowIcon>
      <RowText title={view.title} line={view.line || undefined} />
      <RowTime>
        <RelativeTime at={e.at} />
      </RowTime>
    </Row>
  );
}

function FilesList({ row, t }: { row: FleetRow; t: Strings }) {
  const a = t.shell.agent;
  const files = row.pr?.files ?? [];
  if (!row.pr)
    return (
      <SectionBody>
        <p>{a.noPrYet}</p>
      </SectionBody>
    );
  if (!files.length)
    return (
      <SectionBody>
        <p>{a.noFiles}</p>
      </SectionBody>
    );
  return (
    <>
      {files.map((f) => {
        const shape = fileShape(f);
        return (
          <Row key={f.path}>
            <RowIcon />
            <RowText
              title={
                <span className="sc-file-path">
                  <span className="faint">{shape.dir}</span>
                  {shape.name}
                </span>
              }
            />
            <RowSide>
              <span className="sc-file-delta">
                <span className="sc-add">+{f.additions}</span> <span className="sc-del">−{f.deletions}</span>
              </span>
            </RowSide>
            <RowSide roomy>
              <span className="sc-file-bar" aria-hidden>
                {shape.bar.map((b, k) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: five fixed squares
                  <span key={k} className={`is-${b}`} />
                ))}
              </span>
            </RowSide>
          </Row>
        );
      })}
      {row.pr.filesComplete === false && (
        <SectionBody>
          <p>{a.filesIncomplete}</p>
        </SectionBody>
      )}
    </>
  );
}

/** What waits for the owner on this agent, with the requests the overview cards make. */
function Decision({
  ctx,
  row,
  state,
  label,
  project,
}: {
  ctx: ActionContext;
  row: FleetRow;
  state: AgentState;
  label: string;
  project: ProjectOverview | undefined;
}) {
  const { t } = ctx;
  const a = t.shell.agent;
  const { overview } = useFleet();
  const name = project?.name ?? row.project;
  const coordinator = project?.coordinator.state ?? "unknown";
  // The overview's decision on this ticket, with the overview card's actions.
  const decision = decisionCards(overview).find((w) => w.project === row.project && w.ticket === row.id);
  const head = (text: string, color: string, since: string | null) => ({
    icon: <Dot color={color} />,
    label: <span style={{ color }}>{text}</span>,
    side: since ? <RelativeTime at={since} /> : undefined,
  });

  if (decision) {
    const pr = decision.kind === "hand-back" ? handBackPr(overview, decision) : null;
    const title =
      decision.kind === "question"
        ? a.waitsAnswer(row.id)
        : decision.kind === "approval"
          ? a.planToApprove
          : t.shell.reasons.ready;
    const color = decision.kind === "hand-back" ? "var(--done)" : "var(--accent)";
    return (
      <Section {...head(title, color, decision.since)}>
        <SectionBody>
          <DecisionActions
            ctx={ctx}
            w={decision}
            projectName={name}
            coordinator={coordinator}
            pr={pr}
            sent={sentRequest(overview, decision, pr)}
            full
          />
          <p className="calm">{decision.kind === "hand-back" ? a.mergeHint(name) : a.relays(name)}</p>
        </SectionBody>
      </Section>
    );
  }
  if (state.status === "error")
    return (
      <Section {...head(label, "var(--critical)", row.since)}>
        <SectionBody>
          {row.pr?.failingChecks?.length ? <p className="sc-decision-text">{row.pr.failingChecks.join(", ")}</p> : null}
          {row.statusLine && <p>{row.statusLine.summary}</p>}
        </SectionBody>
      </Section>
    );
  if (state.status === "silent")
    return (
      <Section {...head(label, "var(--active)", row.lastReport)}>
        <SectionBody>
          <p className="sc-decision-text">
            {a.silentFor(t.duration(Math.max(0, ctx.now - Date.parse(row.lastReport ?? row.since))))}
          </p>
          {row.statusLine && <p>{a.lastMessage(row.statusLine.summary)}</p>}
        </SectionBody>
      </Section>
    );
  return null;
}

function Stepper({ row, color }: { row: FleetRow; color: string }) {
  const { t } = useShell();
  const states = stepStates(row.pipeline.step);
  return (
    <span className="sc-stepper" style={{ ["--tone" as string]: color }}>
      {t.shell.steps.map((s, k) => (
        <span
          key={s}
          className={`sc-stepper-step is-${states[k]}`}
          aria-current={states[k] === "now" ? "step" : undefined}
        >
          <span className="sc-stepper-dot" aria-hidden />
          <span className="sc-stepper-label">
            {s}
            <span className="sc-stepper-sub">
              {states[k] === "now" ? (
                <RelativeTime at={row.since} format="duration" />
              ) : states[k] === "done" ? (
                t.shell.agent.done
              ) : (
                " "
              )}
            </span>
          </span>
        </span>
      ))}
    </span>
  );
}

const TABS = ["activity", "files", "attachments"] as const;
type Tab = (typeof TABS)[number];

export function AgentScreen({ initialActivity = null }: { initialActivity?: TaggedActivity | null }) {
  const { t, author, setAuthor, account } = useShell();
  const { overview, failed, refresh, version } = useFleet();
  const now = useNow();
  const ticket = decodeURIComponent(String(useParams<{ ticket: string }>().ticket ?? ""));
  const asked = useSearchParams().get("tab");
  const tab: Tab = asked === "files" || asked === "attachments" ? asked : "activity";
  const row = overview.rows.find((r) => r.id.toLowerCase() === ticket.toLowerCase());
  const project = overview.projects.find((p) => p.slug === row?.project);
  const requests = useMemo(() => project?.requests ?? [], [project]);
  if (!row)
    return (
      <Page>
        <EmptyState title={t.shell.agentMissing} hint={t.shell.agentMissingHint} />
      </Page>
    );
  const ctx: ActionContext = {
    t,
    signer: { name: author, set: setAuthor, fixed: account !== null },
    live: overview.live.state === "ok" && !failed,
    now,
    version,
    refresh,
  };
  return (
    <Agent row={row} project={project} requests={requests} tab={tab} ctx={ctx} initialActivity={initialActivity} />
  );
}

function Agent({
  row,
  project,
  requests,
  tab,
  ctx,
  initialActivity,
}: {
  row: FleetRow;
  project: ProjectOverview | undefined;
  requests: InboxItem[];
  tab: Tab;
  ctx: ActionContext;
  initialActivity: TaggedActivity | null;
}) {
  const { t } = ctx;
  const a = t.shell.agent;
  const state = agentState(row);
  const label = stateLabel(t, state, row.phase);
  const color = toneColor(state.status);
  const harness = harnessOf(row.runtime);
  const handle = row.session?.handle ?? row.handle;
  const link = sessionLink(row.runtime, handle);
  const activity = useActivity(row, requests, initialActivity);
  const attachments = useAttachments(row.project, row.id, ctx.version);
  const branch = row.session?.branch ?? activity.entries.find((e) => e.kind === "branch")?.branch ?? null;
  const files = row.pr?.files ?? null;
  const coordinator = project?.coordinator;
  const coordHarness: Harness | null = coordinatorHarness(coordinator?.harness);
  const tabPath = (k: Tab) => `${paths.agent(row.id)}${k !== "activity" ? `?tab=${k}` : ""}`;
  const session = row.session;

  return (
    <Page>
      <HeaderActions>
        {link && (
          <a className="ui-button is-primary" href={link}>
            {a.openIn("Conductor")}
          </a>
        )}
        <a className="ui-button" href={row.url} target="_blank" rel="noreferrer">
          {t.shell.openLinear}
        </a>
        {row.pr ? (
          <a className="ui-button" href={row.pr.url} target="_blank" rel="noreferrer">
            {t.shell.openPr(row.pr.number)}
          </a>
        ) : (
          <span className="ui-button is-disabled">{t.shell.noPr}</span>
        )}
      </HeaderActions>
      <Section
        icon={<StatusDot status={state.status} progress={rowProgress(row)} />}
        label={<span style={{ color }}>{label}</span>}
        side={
          <span className="mono">
            <RelativeTime at={row.since} format="duration" />
          </span>
        }
      >
        <Row>
          <RowIcon />
          <RowId>{row.id}</RowId>
          <RowText title={row.title} line={rowLine(row)} lineColor={row.question ? "var(--accent)" : undefined} />
          <RowSide roomy>
            <ProjectChip slug={row.project} name={project?.name ?? row.project} />
          </RowSide>
          <RowSide>
            <HarnessBadge harness={harness} />
          </RowSide>
        </Row>
      </Section>
      <Section label={t.shell.stepsHeading} count={`${row.pipeline.step + 1}/${t.shell.steps.length}`}>
        <Row>
          <RowIcon />
          <Stepper row={row} color={color} />
        </Row>
      </Section>
      <Columns
        side={
          <>
            <Section label={t.shell.session}>
              <Fact k={t.shell.harness}>
                <Dot color={harnessColor(harness)} />
                {HARNESS_NAME[harness]}
              </Fact>
              <Fact k={t.shell.profile}>
                <span className="mono">{session?.profile ?? row.profile ?? "—"}</span>
                {row.profileReason && <span> · {row.profileReason}</span>}
              </Fact>
              <Fact k={a.model}>
                <span className="mono">
                  {session?.model ? [session.model, session.effort].filter(Boolean).join(" · ") : "—"}
                </span>
              </Fact>
              <Fact k={a.sessionId}>
                <span className="mono" title={handle ?? undefined}>
                  {handle ?? "—"}
                </span>
              </Fact>
              <Fact k={t.shell.started}>
                {session ? (
                  <span className="mono">
                    <Clock at={session.claimedAt} /> · <RelativeTime at={session.claimedAt} format="duration" />
                  </span>
                ) : (
                  "—"
                )}
              </Fact>
              <Fact k={t.shell.lastReportKey} color={row.silent ? "var(--active)" : undefined}>
                {row.lastReport ? <RelativeTime at={row.lastReport} /> : t.shell.neverReported}
              </Fact>
            </Section>
            <Section label={t.shell.coordinator}>
              <Fact k={project?.name ?? row.project}>
                {coordHarness ? (
                  <>
                    <Dot color={harnessColor(coordHarness)} />
                    {coordHarness === "other" ? a.terminal : HARNESS_NAME[coordHarness]}
                  </>
                ) : (
                  "—"
                )}
              </Fact>
              <Fact
                k={a.state}
                color={
                  coordinator?.state === "active"
                    ? "var(--done)"
                    : coordinator?.state === "idle"
                      ? "var(--active)"
                      : "var(--text-3)"
                }
              >
                {coordinator?.state === "active"
                  ? t.shell.coordinatorActive(t.ago(Math.max(0, ctx.now - Date.parse(coordinator.seenAt ?? ""))))
                  : coordinator?.state === "idle"
                    ? t.shell.coordinatorIdle(t.duration(Math.max(0, ctx.now - Date.parse(coordinator.seenAt ?? ""))))
                    : t.shell.coordinatorUnknown}
              </Fact>
            </Section>
            <Section label={t.shell.code}>
              <Fact k={t.shell.branch}>
                <span className="mono" title={branch ?? undefined}>
                  {branch ?? "—"}
                </span>
              </Fact>
              <Fact k={t.shell.pr}>
                {row.pr ? (
                  <a className="mono" href={row.pr.url} target="_blank" rel="noreferrer">
                    <Dot color={ciColor(row.pr.ci)} /> #{row.pr.number}
                  </a>
                ) : (
                  "—"
                )}
              </Fact>
              {row.pr?.ci && (
                <Fact k={a.checks} color={ciColor(row.pr.ci)}>
                  {a.checkStates[row.pr.ci]}
                </Fact>
              )}
              {row.pr && (
                <Fact k={a.mergeable} color={row.pr.mergeable === "CONFLICTING" ? "var(--critical)" : undefined}>
                  {row.pr.mergeable === "CONFLICTING" ? a.conflict : row.pr.mergeable === "MERGEABLE" ? a.yes : "—"}
                </Fact>
              )}
              <Fact k={a.changes}>
                {row.pr?.additions != null ? (
                  <span className="sc-file-delta">
                    <span className="sc-add">+{row.pr.additions}</span>{" "}
                    <span className="sc-del">−{row.pr.deletions ?? 0}</span>
                  </span>
                ) : (
                  "—"
                )}
              </Fact>
            </Section>
            <SectionBody>
              <RequestAction
                ctx={ctx}
                label={a.askRelease}
                what={a.requests["release-request"]}
                send={releaseTicket}
                fields={{ project: row.project, ticket: row.id }}
                pending={openRequest(project, "release-request", (i) => i.ticket === row.id)}
                coordinator={coordinator?.state ?? "unknown"}
                hint={a.releaseHint}
              />
            </SectionBody>
          </>
        }
      >
        <Decision ctx={ctx} row={row} state={state} label={label} project={project} />
        <Section
          id="agent-tab"
          long={tab === "activity" && activity.entries.length > LONG_LIST}
          label={tab === "attachments" ? a.attachments : tab === "files" ? a.files : a.activity}
          count={
            tab === "attachments"
              ? (attachments?.items.length ?? 0)
              : tab === "files"
                ? (files?.length ?? 0)
                : activity.entries.length
          }
          side={
            <Tabs
              label={a.tabs}
              value={tab}
              size="sm"
              controls="agent-tab"
              items={TABS.map((k) => ({
                key: k,
                label: k === "attachments" ? a.attachments : k === "files" ? a.files : a.activity,
                count:
                  k === "attachments" ? attachments?.items.length : k === "files" ? (files?.length ?? 0) : undefined,
                href: tabPath(k),
              }))}
            />
          }
        >
          {tab === "attachments" ? (
            <Attachments items={attachments?.items ?? null} failed={attachments?.failed ?? false} t={t} />
          ) : tab === "files" ? (
            <FilesList row={row} t={t} />
          ) : (
            <>
              {!activity.live && (
                <SectionBody>
                  <p>{a.activityPartial}</p>
                </SectionBody>
              )}
              {activity.entries.length === 0 ? (
                <SectionBody>
                  <p>{a.noActivity}</p>
                </SectionBody>
              ) : (
                activity.entries.map((e, k) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: entries have no id; the list is rebuilt whole
                  <ActivityRow key={`${e.kind}-${e.at}-${k}`} e={e} row={row} t={t} />
                ))
              )}
            </>
          )}
        </Section>
      </Columns>
    </Page>
  );
}
