"use client";

// The overview (THE-1020, design/dashboard-v7): one sentence for what is
// blocked and what waits for the owner, a card per project, then every
// session in flight and every ticket merged today in one list, grouped by
// state (blocked, waiting for your decision, in progress, ready to merge,
// merged today) or by project. Each row says why it is in its state, in the
// state's color, with its step on a six-step bar. "List + preview" keeps the
// rows short and shows the selected session beside them, its action first
// (OverviewPreview.tsx, loaded apart); on a phone the list comes first and a
// row opens the session's page. The view lives in the address
// (lib/coordinator-view.ts: ?coordinator=, ?group=, ?view=, ?ticket=).
// `Overview` draws it on the view it is given: the landing's replica
// (components/landing/Replica.tsx, THE-931), which has no router, plays it.
import type { ProjectOverview } from "@armada/core/read";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type MouseEvent, useCallback, useMemo, useState } from "react";
import {
  groupItems,
  type ItemGroup,
  type OverviewItem,
  type OverviewView,
  overviewHeadline,
  overviewHref,
  parseOverviewView,
  projectSummaries,
  type Reason,
  type SessionGroup,
} from "@/lib/coordinator-view";
import { paths } from "@/lib/fleet-view";
import { LONGEST_TIMES, type Strings } from "@/lib/i18n";
import { Alert, HeaderActions, LONG_LIST, Notice } from "../page";
import { useFleet, useNow, useShell } from "../shell/context";
import { useOverviewItems } from "../shell/use-items";
import { RelativeTime, Steady } from "../ui";
import { useLazy } from "../use-lazy";

// The preview pane is its own chunk (THE-892): the list does not wait for its code.
const loadPreview = () => import("./OverviewPreview").then((m) => m.OverviewPreview);

/** Each state's color: a dot, its group's header, its reason. */
export const GROUP_COLOR: Record<SessionGroup, string> = {
  blocked: "var(--red)",
  you: "var(--amber)",
  running: "var(--blue)",
  ready: "var(--green)",
  merged: "var(--text-3)",
};

export const itemColor = (item: Pick<OverviewItem, "group" | "reason">) =>
  item.reason.kind === "runtime" && item.reason.state === "gone" ? "var(--text-3)" : GROUP_COLOR[item.group];

const COORDINATOR_COLOR = { active: "var(--green)", idle: "var(--amber)", unknown: "var(--text-3)" } as const;

/** A row's reason line, in the viewer's language. */
export function reasonText(t: Strings, r: Reason, now: number): string {
  const o = t.overview.reasons;
  switch (r.kind) {
    case "runtime":
      return t.shell.runtimeState[r.state];
    case "question":
      return o.question(r.text);
    case "ci":
      return o.ci(r.pr);
    case "conflict":
      return o.conflict(r.pr);
    case "silent":
      return o.silent(t.duration(r.since ? Math.max(0, now - Date.parse(r.since)) : 0));
    case "blocked":
      return o.blocked(r.text);
    case "plan":
      return o.plan;
    case "merge":
      return o.merge(r.pr, r.ci ? t.overview.ci[r.ci] : "");
    case "validation":
      return r.text;
    case "owner-question":
      return o.ownerQuestion(r.text);
    case "awaiting-validation":
      return o.awaitingValidation;
    case "ready":
      return o.ready(r.by, r.pr, r.ci ? t.overview.ci[r.ci] : "");
    case "merged":
      return o.merged(r.pr);
    case "working":
      return r.text ?? o.working;
  }
}

/** Where a row opens: its session's page, else (merged earlier today) its pull request. */
export const itemHref = (i: OverviewItem) => (i.row || !i.pr ? paths.agent(i.id) : i.pr.url);

/** The six steps, the done ones grey, the one at work in its state's color. */
export function StepBar({ step, color, wide = false }: { step: number; color: string; wide?: boolean }) {
  const { t } = useShell();
  const steps = t.overview.steps;
  const label = steps[Math.min(step, steps.length - 1)] ?? "";
  return (
    <span className={wide ? "ov-steps is-wide" : "ov-steps"} role="img" aria-label={t.overview.stepLabel(label)}>
      {steps.map((s, k) => (
        <span key={s} style={{ background: k < step ? "var(--step-done)" : k === step ? color : "var(--step-next)" }} />
      ))}
    </span>
  );
}

export function OverviewScreen() {
  const params = useSearchParams();
  const view = useMemo(() => parseOverviewView(params), [params]);
  // The selection changes the address without a navigation: the pane follows at once.
  const [picked, setPicked] = useState<{ from: string | null; ticket: string } | null>(null);
  const ticket = picked && picked.from === view.ticket ? picked.ticket : view.ticket;
  const select = useCallback(
    (id: string) => {
      setPicked({ from: view.ticket, ticket: id });
      window.history.replaceState(null, "", overviewHref({ ...view, ticket: id }));
    },
    [view],
  );
  return (
    <Overview
      view={{ ...view, ticket }}
      hrefFor={(patch) => overviewHref({ ...view, ticket, ...patch })}
      select={select}
    />
  );
}

/** The overview on the view it is given, the links that change it, and how to select a session. */
export function Overview({
  view,
  hrefFor,
  select,
}: {
  view: OverviewView;
  hrefFor: (patch: Partial<OverviewView>) => string;
  select: (id: string) => void;
}) {
  const { t } = useShell();
  const { overview, failed } = useFleet();
  const all = useOverviewItems();
  const projects = overview.projects;
  const project = projects.some((p) => p.slug === view.project) ? view.project : null;
  const items = useMemo(() => (project ? all.filter((i) => i.project === project) : all), [all, project]);
  const groups = useMemo(() => groupItems(items, view.group, projects), [items, view.group, projects]);
  const head = overviewHeadline(all, projects.length);
  const summaries = useMemo(() => projectSummaries(projects, all), [projects, all]);
  const names = useMemo(() => new Map(projects.map((p) => [p.slug, p.name])), [projects]);
  const unread = projects.filter((p) => p.error || p.reading);
  const preview = view.view === "preview";
  const selected = preview ? (items.find((i) => i.id === view.ticket) ?? groups[0]?.items[0] ?? null) : null;

  return (
    <div className="ov">
      <HeaderActions>
        <nav className="ov-views" aria-label={t.overview.views.label}>
          {(["list", "preview"] as const).map((v) => (
            <Link
              key={v}
              href={hrefFor({ view: v })}
              scroll={false}
              prefetch={false}
              className="ov-view"
              aria-current={view.view === v ? "true" : undefined}
            >
              {t.overview.views[v]}
            </Link>
          ))}
        </nav>
      </HeaderActions>
      {overview.live.state === "unreachable" && !failed && (
        <Alert tone="warn" title={t.live.unreachable}>
          {t.unreachableBanner(overview.live.error)}
        </Alert>
      )}
      {overview.live.state === "off" && <Notice>{t.offBanner}</Notice>}
      {unread.map((p) =>
        p.error ? (
          <Alert key={p.slug} title={t.projectError(p.name)}>
            {p.error}
          </Alert>
        ) : (
          <Notice key={p.slug}>{t.readingProject(p.name)}</Notice>
        ),
      )}
      <div className="ov-head">
        <p className="ov-headline">{t.overview.headline(head.blocked, head.you)}</p>
        {projects.map(
          (p) =>
            p.main?.redSince && (
              <p key={p.slug} className="ov-subline" style={{ color: "var(--red)" }}>
                {p.name}: {t.overview.mainHealth(p.main)}
              </p>
            ),
        )}
        <p className="ov-subline">
          {t.overview.subline({
            live: head.live,
            projects: head.projects,
            running: head.running,
            ready: head.ready,
            merged: head.merged,
          })}
        </p>
      </div>
      {projects.length === 0 ? (
        <div className="ov-empty">
          <p>{t.noProjects}</p>
          <p className="faint">{t.noProjectsHint}</p>
        </div>
      ) : (
        <>
          <ul className="ov-projects">
            {summaries.map((s) => (
              <li key={s.project.slug}>
                <ProjectCard summary={s} />
              </li>
            ))}
          </ul>
          <div className="ov-bar">
            <nav className="ov-chips" aria-label={t.overview.filterLabel}>
              <Chip href={hrefFor({ project: null })} on={project === null} label={t.overview.all} count={all.length} />
              {projects.map((p) => (
                <Chip
                  key={p.slug}
                  href={hrefFor({ project: p.slug })}
                  on={project === p.slug}
                  label={p.name}
                  count={all.filter((i) => i.project === p.slug).length}
                />
              ))}
            </nav>
            <span className="spacer" />
            <span className="ov-groupby" id="ov-groupby">
              {t.overview.groupBy}
            </span>
            <nav className="ov-chips" aria-labelledby="ov-groupby">
              <Chip href={hrefFor({ group: "state" })} on={view.group === "state"} label={t.overview.byState} />
              <Chip href={hrefFor({ group: "project" })} on={view.group === "project"} label={t.overview.byProject} />
            </nav>
          </div>
          {groups.length === 0 ? (
            <div className="ov-empty is-dashed">
              {project ? (
                <>
                  {t.overview.noMatch}{" "}
                  <Link href={hrefFor({ project: null })} scroll={false} prefetch={false}>
                    {t.overview.clear}
                  </Link>
                </>
              ) : (
                t.overview.nothingRunning
              )}
            </div>
          ) : preview ? (
            <div className="ov-split">
              <List
                groups={groups}
                names={names}
                compact
                selected={selected}
                select={select}
                long={items.length > LONG_LIST}
              />
              <aside className="ov-pane" aria-label={selected ? selected.id : t.overview.views.preview}>
                <Pane item={selected} names={names} />
              </aside>
            </div>
          ) : (
            <List groups={groups} names={names} long={items.length > LONG_LIST} />
          )}
        </>
      )}
    </div>
  );
}

function Pane({ item, names }: { item: OverviewItem | null; names: Map<string, string> }) {
  const Preview = useLazy(loadPreview);
  if (!item || !Preview) return null;
  return (
    <Preview key={`${item.project}/${item.id}`} item={item} projectName={names.get(item.project) ?? item.project} />
  );
}

function Chip({ href, on, label, count }: { href: string; on: boolean; label: string; count?: number }) {
  return (
    <Link href={href} scroll={false} prefetch={false} className="ov-chip" aria-current={on ? "true" : undefined}>
      {label}
      {count !== undefined && <span className="ov-chip-n">{count}</span>}
    </Link>
  );
}

/** One project: its progress, what is blocked, what waits for the owner, what runs, its coordinator. */
function ProjectCard({ summary: s }: { summary: ReturnType<typeof projectSummaries>[number] }) {
  const { t } = useShell();
  const now = useNow();
  const p: ProjectOverview = s.project;
  const c = t.overview.card;
  const progress = p.progress;
  const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const idle = p.coordinator.seenAt ? t.duration(Math.max(0, now - Date.parse(p.coordinator.seenAt))) : "";
  const coordinator =
    s.coordinator === "active"
      ? t.overview.coordinator.active
      : s.coordinator === "idle"
        ? t.overview.coordinator.idle(idle)
        : t.overview.coordinator.unknown;
  return (
    <Link href={paths.project(p.slug)} prefetch={false} className="ov-project">
      <span className="ov-project-head">
        <span className="ov-project-name">{p.name}</span>
        <span className="spacer" />
        {progress && (
          <span className="ov-project-n" title={c.progress(progress.done, progress.total)}>
            {progress.done} / {progress.total}
          </span>
        )}
      </span>
      <span className="ov-project-bar" aria-hidden>
        <span style={{ width: `${pct}%` }} />
      </span>
      {p.main?.redSince && (
        <span className="ov-project-facts" style={{ color: "var(--red)" }}>
          {t.overview.mainHealth(p.main)}
        </span>
      )}
      <span className="ov-project-facts">
        <span style={{ color: s.blocked ? "var(--red)" : "var(--text-3)" }}>{c.blocked(s.blocked)}</span>
        <span style={{ color: s.you ? "var(--amber)" : "var(--text-3)" }}>{c.you(s.you)}</span>
        <span>{c.running(s.running)}</span>
        <span className="ov-project-coord" style={{ color: COORDINATOR_COLOR[s.coordinator] }}>
          <span className="ov-diamond" aria-hidden />
          <Steady
            widest={[
              t.overview.coordinator.active,
              t.overview.coordinator.unknown,
              ...LONGEST_TIMES.map((n) => t.overview.coordinator.idle(t.duration(n))),
            ]}
          >
            {coordinator}
          </Steady>
        </span>
      </span>
    </Link>
  );
}

/**
 * The list: its groups, each a sticky header over its rows. `boxed` is a
 * project's page (THE-1021): one project's sessions in a frame, without the
 * project column or the groups' hints.
 */
export function List({
  groups,
  names,
  compact = false,
  boxed = false,
  selected = null,
  select,
  long,
}: {
  groups: ItemGroup[];
  names: Map<string, string>;
  compact?: boolean;
  boxed?: boolean;
  selected?: OverviewItem | null;
  select?: (id: string) => void;
  long: boolean;
}) {
  const { t } = useShell();
  const now = useNow();
  return (
    <div className={["ov-list", long && "is-long", boxed && "is-boxed"].filter(Boolean).join(" ")}>
      {groups.map((g) => {
        const color = g.group ? GROUP_COLOR[g.group] : COORDINATOR_COLOR[g.project?.coordinator.state ?? "unknown"];
        const label = g.group ? t.overview.groups[g.group] : (g.project?.name ?? g.key);
        const hint = g.group ? t.overview.groupHints[g.group] : projectHint(t, g.project, now);
        return (
          <section key={g.key} className="ov-group" aria-labelledby={`ov-g-${g.key}`}>
            <h2 className="ov-group-h" id={`ov-g-${g.key}`}>
              <span className="ov-dot" style={{ background: color }} aria-hidden />
              <span className="ov-group-name">{label}</span>
              <span className="ov-group-n">{g.items.length}</span>
              {!compact && !boxed && hint && <span className="ov-group-hint">{hint}</span>}
            </h2>
            {g.items.map((i) => (
              <Row
                key={`${i.project}/${i.id}`}
                item={i}
                projectName={names.get(i.project) ?? i.project}
                compact={compact}
                boxed={boxed}
                selected={selected === i}
                select={select}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function projectHint(t: Strings, p: ProjectOverview | null, now: number) {
  if (!p) return "";
  const c = p.coordinator;
  if (c.state === "active") return t.overview.coordinatorHint.active;
  if (c.state === "idle")
    return t.overview.coordinatorHint.idle(t.duration(c.seenAt ? Math.max(0, now - Date.parse(c.seenAt)) : 0));
  return t.overview.coordinatorHint.unknown;
}

/** On a desk the pane shows a row; on a phone, where it is hidden, the row opens its page. */
const paneShown = () => {
  const pane = document.querySelector<HTMLElement>(".ov-pane");
  return !!pane && pane.offsetParent !== null;
};

function Row({
  item: i,
  projectName,
  compact,
  boxed,
  selected,
  select,
}: {
  item: OverviewItem;
  projectName: string;
  compact: boolean;
  boxed: boolean;
  selected: boolean;
  select?: (id: string) => void;
}) {
  const { t } = useShell();
  const now = useNow();
  const color = itemColor(i);
  const href = itemHref(i);
  const external = !href.startsWith("/");
  const onClick =
    compact && select
      ? (e: MouseEvent) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || !paneShown()) return;
          e.preventDefault();
          select(i.id);
        }
      : undefined;
  const reason = reasonText(t, i.reason, now);
  const quiet = i.group === "running" || i.group === "merged";
  const last = (
    <span className="ov-last">
      <span className="sr-only">{i.group === "merged" ? t.overview.groups.merged : t.overview.lastReport} </span>
      <RelativeTime at={i.last} format="duration" />
    </span>
  );
  return (
    <Link
      href={href}
      prefetch={false}
      data-row
      className={compact ? "ov-row is-compact" : "ov-row"}
      aria-current={selected ? "true" : undefined}
      style={selected ? { boxShadow: `inset 2px 0 0 ${color}` } : undefined}
      onClick={onClick}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      <span className="ov-dot" style={{ background: color }} aria-hidden />
      <span className="ov-id">{i.id}</span>
      {compact ? (
        <span className="ov-title">
          {i.title}
          <span className="sr-only"> · {reason}</span>
        </span>
      ) : (
        <>
          <span className="ov-main">
            <span className="ov-title">{i.title}</span>
            <span className="ov-reason" style={{ color: quiet ? "var(--text-2)" : color }}>
              {reason}
            </span>
          </span>
          {!boxed && <span className="ov-proj">{projectName}</span>}
          <StepBar step={i.step} color={color} />
        </>
      )}
      {last}
    </Link>
  );
}
