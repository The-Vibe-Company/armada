"use client";

// The overview's live timeline (THE-868, the mockup's "Flotte en direct"):
// per project, its coordinator's row (harness, active or idle and since when,
// a line while it watches its inbox), then a row per session in flight (its
// phases from its claim, the moment its pull request opened, its reports and
// its silences). It opens on the last 3 hours, now on the right, and scrolls
// back to 24 (THE-880): trackpad, shift and wheel, or a drag; the names and
// the "ago" column stay put. Each row is one SVG in percent of the 24 h track,
// drawn from what core gives it (`FleetTimeline`, from /api/fleet/timeline,
// read while the section is on screen and the overview changed): no rule is
// decided here. Rows redraw every `STEP_MS` and on a new history only. The
// drawing is for the eye; "Show as table" gives the same sessions, phases and
// times as a table, for a screen reader or a keyboard (THE-891). Night watch
// (THE-899) draws each session as a flight path: its earlier phases a thin
// trail, its current phase a lit bar, the agent itself a ship at "now",
// silences hatched in amber, under a glowing now line.
import type { CoordinatorTrack, FleetRow, FleetTimeline, ProjectOverview, SessionTimeline } from "@armada/core/read";
import Link from "next/link";
import { type CSSProperties, memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentState, HARNESS_NAME, HARNESSES, type Harness, harnessCounts, harnessOf, paths } from "@/lib/fleet-view";
import type { Language, Strings } from "@/lib/i18n";
import { coordinatorHarness } from "@/lib/project-view";
import { Button, LONG_LIST, Row, Section, SectionBody } from "../page";
import { rowProgress } from "../screens/AgentRow";
import { useFleet, useNow, useShell } from "../shell/context";
import { stateLabel } from "../shell/labels";
import { harnessColor, ProjectChip, StatusDot, Tabs, toneColor } from "../ui";
import { hourMarks, PHASE_COLOR, type Scale, STEP_MS, scaleOf, segmentBox, spanBox, ZOOM } from "./scale";

/** What a hovered mark says: its lines, the first in its color. */
interface Tip {
  lines: string[];
  color?: string;
}

type Clock = (at: number | string) => string;

/**
 * A mark's tip, kept on the element: one listener on the timeline shows it,
 * whatever the number of marks. Its times are the viewer's clock, which the
 * server does not know: none before the timeline is drawn in the browser.
 */
const tipOf = (clock: Clock | null, make: (clock: Clock) => Tip) => {
  if (!clock) return {};
  const tip = make(clock);
  return { "data-tip": tip.lines.join("\n"), "data-tip-color": tip.color };
};

/** Where a session's marks sit, in px from the top of its 46 px track. */
const MID = 23;

const clockOf = (lang: Language): Clock => {
  const format = new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", { hour: "2-digit", minute: "2-digit" });
  return (at: number | string) => format.format(typeof at === "string" ? Date.parse(at) : at);
};

const coordinatorName = (h: ProjectOverview["coordinator"]["harness"]) => {
  const harness = coordinatorHarness(h);
  return harness ? HARNESS_NAME[harness] : null;
};

const pc = (n: number) => `${n.toFixed(3)}%`;

/**
 * The timeline of the projects shown: every one, or the one the overview is
 * filtered on. `compact` caps its height under the overview's list (THE-916):
 * its rows scroll inside.
 */
export function LiveTimeline({ project = null, compact = false }: { project?: string | null; compact?: boolean }) {
  // A showcase (the landing's replica, THE-887) gives the history; the shell's reads it from the server.
  const { overview, timeline: given } = useFleet();
  const { t, lang } = useShell();
  const now = useNow();
  const [harness, setHarness] = useState<Harness | "all">("all");
  const [table, setTable] = useState(false);
  const [tip, setTip] = useState<(Tip & { x: number; y: number; left: boolean }) | null>(null);
  // Hour marks and tips follow the viewer's clock, which the server does not know: drawn once in the browser.
  const [mounted, setMounted] = useState(false);
  // A transition: the rows redraw in slices an input can cut (THE-892).
  useEffect(() => startTransition(() => setMounted(true)), []);
  const [box, setBox] = useState<HTMLDivElement | null>(null);

  // The scale moves by steps of the clock, not every second: the rows redraw only then.
  const end = Math.floor(now / STEP_MS) * STEP_MS;
  const scale = useMemo(() => scaleOf(end), [end]);
  const marks = useMemo(() => (mounted ? hourMarks(scale) : []), [mounted, scale]);
  const { ref: scroller, atNow, toNow } = useTimeScroll();
  const read = useTimelineHistory(given ? null : box, overview.generatedAt);
  const history = useMemo(() => (given ? historyOf(given) : read), [given, read]);
  const clock = useMemo(() => (mounted ? clockOf(lang) : null), [mounted, lang]);

  useEffect(() => {
    const el = box;
    if (!el) return;
    const move = (e: PointerEvent) => {
      const mark = e.target instanceof Element ? e.target.closest<SVGElement | HTMLElement>("[data-tip]") : null;
      const b = el.getBoundingClientRect();
      const lines = mark?.dataset.tip;
      setTip(
        lines
          ? {
              lines: lines.split("\n"),
              color: mark.dataset.tipColor,
              x: e.clientX - b.left,
              y: e.clientY - b.top,
              // Near the right edge the tip opens to the left of the pointer.
              left: b.right - e.clientX < 360,
            }
          : null,
      );
    };
    const leave = () => setTip(null);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, [box]);

  const projects = overview.projects.filter((p) => !project || p.slug === project);
  const all = overview.rows.filter((r) => !project || r.project === project);
  const counts = harnessCounts(all);
  const rows = all.filter((r) => harness === "all" || harnessOf(r.runtime) === harness);
  if (projects.length === 0) return null;

  return (
    <Section
      label={t.timeline.title}
      count={rows.length}
      side={
        <>
          <Tabs
            size="sm"
            label={t.shell.harnessHeading}
            value={harness}
            onChange={setHarness}
            items={[
              { key: "all", label: t.shell.all, count: all.length, dot: "var(--text-3)" },
              ...HARNESSES.map((h) => ({
                key: h,
                label: HARNESS_NAME[h],
                count: counts[h],
                dot: harnessColor(h),
              })),
            ]}
          />
          <Button type="button" onClick={() => setTable(!table)} aria-controls="tl-view">
            {table ? t.a11y.showChart : t.a11y.showTable}
          </Button>
          <Button
            type="button"
            onClick={toNow}
            disabled={atNow || table}
            title={t.timeline.backToNow}
            aria-label={t.timeline.backToNow}
          >
            {t.timeline.now}
            <svg className="tl-now-icon" width="12" height="12" viewBox="0 0 16 16" aria-hidden>
              <path
                d="M3 8h9M8.5 4.5L12 8l-3.5 3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Button>
        </>
      }
    >
      <div className={compact ? "tl is-compact" : "tl"} ref={setBox} id="tl-view">
        {table && (
          <TimelineTable projects={projects} rows={rows} history={history} t={t} clock={clock} end={scale.end} />
        )}
        <Hatch />
        {/* Right to left, so the browser opens it on now before any script runs; every row inside reads left to right. */}
        <section
          className="tl-scroll"
          ref={scroller}
          dir="rtl"
          style={{ "--tl-zoom": ZOOM } as CSSProperties}
          hidden={table}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroller the arrow keys move must take the focus.
          tabIndex={0}
          aria-label={t.a11y.timelineScroll}
        >
          <div className={rows.length > LONG_LIST ? "tl-rows is-long" : "tl-rows"} dir="ltr">
            <Row className="tl-head">
              <span className="tl-label faint">{t.timeline.session}</span>
              <span className="tl-track tl-scale">
                {marks.map((m) => (
                  <span key={m} className="tl-hour" style={{ left: pc(scale.x(m)) }}>
                    {clock?.(m)}
                  </span>
                ))}
                <span className="tl-now">{t.timeline.now}</span>
              </span>
              <span className="tl-side" />
            </Row>
            {projects.map((p) => {
              const own = rows.filter((r) => r.project === p.slug);
              return (
                <div key={p.slug} className="tl-group">
                  <Row className="tl-group-h">
                    <span className="tl-label">
                      <ProjectChip slug={p.slug} name={p.name} />
                      <span className="ui-count">{own.length}</span>
                    </span>
                  </Row>
                  <CoordinatorRow
                    project={p}
                    track={history.coordinators.get(p.slug) ?? null}
                    scale={scale}
                    marks={marks}
                    t={t}
                    clock={clock}
                    now={now}
                  />
                  {own.map((r) => (
                    <SessionRow
                      key={r.id}
                      row={r}
                      tl={history.rows.get(`${r.project}/${r.id}`) ?? null}
                      scale={scale}
                      marks={marks}
                      t={t}
                      clock={clock}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </section>
        <SectionBody className={table ? "tl-legend is-hidden" : "tl-legend"}>
          <span>
            <i className="tl-swatch is-past" />
            {t.timeline.legend.past}
          </span>
          <span>
            <i className="tl-swatch is-current" />
            {t.timeline.legend.current}
          </span>
          <span>
            <svg className="tl-swatch" width="10" height="10" viewBox="0 0 12 12" aria-hidden>
              <path d="M11.5 6L1 11V1Z" fill="var(--frontier)" />
            </svg>
            {t.timeline.legend.ship}
          </span>
          <span>
            <i className="tl-swatch is-pr" />
            {t.timeline.legend.pr}
          </span>
          <span>
            <i className="tl-swatch is-report" />
            {t.timeline.legend.report}
          </span>
          <span>
            <i className="tl-swatch is-silence" />
            {t.timeline.legend.silence}
          </span>
          <span>
            <i className="tl-swatch is-inbox" />
            {t.timeline.legend.inbox}
          </span>
          <span>
            <i className="tl-swatch is-idle" />
            {t.timeline.legend.idle}
          </span>
        </SectionBody>
        {tip && (
          <div className={tip.left ? "tl-tip is-left" : "tl-tip"} style={{ left: tip.x, top: tip.y }} role="tooltip">
            <span className="tl-tip-title" style={{ color: tip.color }}>
              {tip.lines[0]}
            </span>
            {tip.lines.slice(1).map((line) => (
              <span key={line}>{line}</span>
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}

/**
 * The timeline as a table: per project, each session shown, its status, its
 * phases from its claim with when each began and how long it lasted, and its
 * last report. Its times are the viewer's clock, like the drawing's tips.
 */
function TimelineTable({
  projects,
  rows,
  history,
  t,
  clock,
  end,
}: {
  projects: ProjectOverview[];
  rows: FleetRow[];
  history: History;
  t: Strings;
  clock: Clock | null;
  end: number;
}) {
  const x = t.a11y.table;
  const shown = projects.flatMap((p) => rows.filter((r) => r.project === p.slug).map((r) => ({ p, r })));
  if (shown.length === 0)
    return (
      <SectionBody>
        <p>{x.none}</p>
      </SectionBody>
    );
  return (
    <div className="tl-table-wrap">
      <table className="tl-table">
        <caption className="sr-only">{x.caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="tl-cell is-head">
              {x.project}
            </th>
            <th scope="col" className="tl-cell is-head">
              {x.session}
            </th>
            <th scope="col" className="tl-cell is-head">
              {x.status}
            </th>
            <th scope="col" className="tl-cell is-head">
              {x.phases}
            </th>
            <th scope="col" className="tl-cell is-head">
              {x.lastReport}
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map(({ p, r }) => {
            const phases = history.rows.get(`${r.project}/${r.id}`)?.phases ?? [];
            return (
              <tr key={`${r.project}/${r.id}`}>
                <td className="tl-cell">{p.name}</td>
                <th scope="row" className="tl-cell is-row">
                  <Link href={paths.agent(r.id)} prefetch className="tl-table-link">
                    <span className="mono">{r.id}</span> {r.title}
                  </Link>
                </th>
                <td className="tl-cell">{stateLabel(t, agentState(r), r.phase)}</td>
                <td className="tl-cell">
                  {phases.length === 0 || !clock ? (
                    t.shell.phases[r.phase]
                  ) : (
                    <ol className="tl-table-phases">
                      {phases.map((s) => (
                        <li key={`${s.phase}-${s.from}`}>
                          {x.phaseAt(
                            t.shell.phases[s.phase],
                            clock(s.from),
                            t.duration((s.to === null ? end : Date.parse(s.to)) - Date.parse(s.from)),
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </td>
                <td className="tl-cell">{r.lastReport ? t.ago(Math.max(0, end - Date.parse(r.lastReport))) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The hues a current phase is lit in, by the token its phase's color names. */
const LIT = {
  "var(--frontier)": "flight",
  "var(--accent)": "yours",
  "var(--critical)": "fail",
  "var(--done)": "done",
  "var(--text-3)": "rest",
} as const;
const litOf = (color: string) => `url(#tl-lit-${LIT[color as keyof typeof LIT] ?? "flight"})`;

/** The silences' hatching and the current phase's light, defined once for every row. */
function Hatch() {
  return (
    <svg className="tl-defs" width="0" height="0" aria-hidden>
      <defs>
        <pattern id="tl-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="2" height="6" fill="rgba(255, 181, 71, 0.5)" />
        </pattern>
        {Object.entries(LIT).map(([color, key]) => (
          <linearGradient key={key} id={`tl-lit-${key}`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" style={{ stopColor: color, stopOpacity: 0.18 }} />
            <stop offset="1" style={{ stopColor: color, stopOpacity: 0.55 }} />
          </linearGradient>
        ))}
      </defs>
    </svg>
  );
}

/** The faint hour lines behind a row's marks. */
function Grid({ marks, scale }: { marks: number[]; scale: Scale }) {
  return (
    <>
      {marks.map((m) => (
        <rect key={m} className="tl-grid" x={pc(scale.x(m))} y="0" width="1" height="100%" />
      ))}
      <rect className="tl-nowline" x="100%" y="0" width="1" height="100%" transform="translate(-1 0)" />
    </>
  );
}

interface RowProps {
  scale: Scale;
  marks: number[];
  t: Strings;
  clock: Clock | null;
}

/** Until its history arrives, a row draws its labels and an empty track. */
const NO_HISTORY: SessionTimeline = { startedAt: "", phases: [], reports: [], silences: [], prOpenedAt: null };
const NO_TRACK: CoordinatorTrack = { reads: [], idle: [] };

const SessionRow = memo(function SessionRow({
  row: r,
  tl: history,
  scale,
  marks,
  t,
  clock,
}: RowProps & { row: FleetRow; tl: SessionTimeline | null }) {
  const state = agentState(r);
  const label = stateLabel(t, state, r.phase);
  const color = toneColor(state.status);
  const tl = history ?? NO_HISTORY;
  const last = tl.phases.length - 1;
  const { pr } = r;
  const opened = tl.prOpenedAt;
  const lastReport = r.lastReport ? scale.end - Date.parse(r.lastReport) : null;
  return (
    <Row href={paths.agent(r.id)} className="tl-row">
      <span className="tl-label">
        <StatusDot status={state.status} progress={rowProgress(r)} label={label} />
        <span className="tl-label-text">
          <span className="ui-row-title">{r.title}</span>
          <span className="tl-label-line">
            <span className="mono">{r.id}</span> · <span style={{ color }}>{label}</span>
          </span>
        </span>
      </span>
      <span className="tl-track">
        <svg className="tl-svg" width="100%" height="46" aria-hidden>
          <Grid marks={marks} scale={scale} />
          {tl.phases.map((s, k) => {
            const b = segmentBox(s, scale);
            if (!b) return null;
            const current = k === last;
            const end = s.to === null ? scale.end : Date.parse(s.to);
            const tip = tipOf(clock, (c) => ({
              lines: [
                t.shell.phases[s.phase],
                t.timeline.from(c(s.from), t.duration(end - Date.parse(s.from))),
                ...(s.summary ? [s.summary] : []),
              ],
              color: PHASE_COLOR[s.phase],
            }));
            // The earlier phases are the path flown, a thin trail; the current one is lit, up to the ship.
            return current ? (
              <rect
                key={`${s.phase}-${s.from}`}
                className="tl-phase is-current"
                x={pc(b.x)}
                y={MID - 4}
                width={pc(b.width)}
                height={8}
                rx={4}
                fill={litOf(PHASE_COLOR[s.phase])}
                {...tip}
              />
            ) : (
              <rect
                key={`${s.phase}-${s.from}`}
                className="tl-phase"
                x={pc(b.x)}
                y={MID - 1}
                width={pc(b.width)}
                height={2}
                rx={1}
                fill={PHASE_COLOR[s.phase]}
                {...tip}
              />
            );
          })}
          {tl.silences.map((s) => {
            const to = s.to === null ? scale.end : Date.parse(s.to);
            const b = spanBox(s.from, to, scale);
            if (!b) return null;
            const tip = tipOf(clock, () => ({
              lines: [t.timeline.silence(t.duration(to - Date.parse(s.from)))],
              color: "var(--active)",
            }));
            return (
              <rect
                key={`${s.from}-${s.to}`}
                className="tl-silence"
                x={pc(b.x)}
                y={MID - 4}
                width={pc(b.width)}
                height="8"
                rx="4"
                fill="url(#tl-hatch)"
                {...tip}
              />
            );
          })}
          {(tl.heartbeats ?? []).map((at, index, beats) => {
            const next = beats[index + 1];
            const from = Math.max(scale.start, Date.parse(at));
            const to = Math.min(scale.end, next ? Date.parse(next) : scale.end);
            if (
              to < scale.start ||
              from > scale.end ||
              to <= from ||
              tl.silences.some((gap) => Date.parse(gap.from) <= from && (gap.to === null || Date.parse(gap.to) >= to))
            )
              return null;
            return (
              <line
                key={`heartbeat-${at}`}
                x1={pc(scale.x(from))}
                x2={pc(scale.x(to))}
                y1={MID + 10}
                y2={MID + 10}
                stroke={color}
                strokeWidth="2"
                strokeLinecap="round"
              />
            );
          })}
          {tl.reports.map((at) =>
            Date.parse(at) < scale.start ? null : (
              <circle
                key={at}
                className="tl-report"
                cx={pc(scale.x(at))}
                cy={MID}
                r="2"
                {...tipOf(clock, (c) => ({ lines: [t.timeline.report(c(at))] }))}
              />
            ),
          )}
          {pr && opened && Date.parse(opened) >= scale.start && (
            <svg x={pc(scale.x(opened))} y={MID} overflow="visible" aria-hidden>
              <path
                className="tl-pr"
                d="M0 -4.5L4.5 0L0 4.5L-4.5 0Z"
                {...tipOf(clock, (c) => ({ lines: [t.timeline.prOpened(pr.number, c(opened))] }))}
              />
            </svg>
          )}
          {/* The agent itself: a ship at now, in its state's color; dimmed while silent. */}
          <svg x="100%" y={MID} overflow="visible" aria-hidden>
            <path
              className={r.silent ? "tl-ship is-silent" : "tl-ship"}
              d="M5 0L-6.5 5.5V-5.5Z"
              fill={color}
              style={{ ["--c" as string]: color }}
            />
          </svg>
        </svg>
      </span>
      <span className="tl-side" style={{ color: r.silent ? "var(--active)" : undefined }}>
        {lastReport === null ? "—" : t.duration(Math.max(0, lastReport))}
      </span>
    </Row>
  );
});

/** A coordinator's row: a faint line while it runs, a steady line while it watches its inbox, dashed while idle. */
function CoordinatorRow({
  project: p,
  track,
  scale,
  marks,
  t,
  clock,
  now,
}: RowProps & { project: ProjectOverview; track: CoordinatorTrack | null; now: number }) {
  const c = p.coordinator;
  const inbox = track ?? NO_TRACK;
  const color = c.state === "active" ? "var(--done)" : c.state === "idle" ? "var(--active)" : "var(--text-3)";
  const seen = c.seenAt ? Date.parse(c.seenAt) : null;
  const started = c.startedAt ? Date.parse(c.startedAt) : seen;
  const ms = seen === null ? 0 : Math.max(0, now - seen);
  const run = started !== null && seen !== null ? spanBox(started, c.state === "active" ? null : seen, scale) : null;
  const watch = c.state === "active" ? "var(--done)" : "var(--text-2)";
  return (
    <Row href={paths.project(p.slug)} className="tl-row is-coordinator">
      <span className="tl-label">
        <span className={`sc-coord-mark is-${c.state}`} style={{ color }} aria-hidden />
        <span className="tl-label-text">
          <span className="tl-coord">
            {t.timeline.coordinator(c.harness === "terminal" ? "Terminal" : coordinatorName(c.harness))}
          </span>
        </span>
      </span>
      <span className="tl-track is-short">
        <svg className="tl-svg" width="100%" height="38" aria-hidden>
          <Grid marks={marks} scale={scale} />
          {run && (
            <rect className="tl-coord-line" x={pc(run.x)} y="18.5" width={pc(run.width)} height="1" fill={watch} />
          )}
          {inbox.idle.map((g) => {
            const b = spanBox(g.from, g.to, scale);
            if (!b) return null;
            return (
              <line
                key={g.from}
                className="tl-coord-idle"
                x1={pc(b.x)}
                x2={pc(b.x + b.width)}
                y1="19"
                y2="19"
                stroke="var(--active)"
                strokeWidth="2"
                strokeDasharray="4 4"
                {...tipOf(clock, (k) => ({
                  lines: [
                    t.timeline.idle(t.duration(Date.parse(g.to) - Date.parse(g.from))),
                    `${k(g.from)} → ${k(g.to)}`,
                  ],
                  color: "var(--active)",
                }))}
              />
            );
          })}
          {c.state === "idle" && seen !== null && (
            <line
              className="tl-coord-idle"
              x1={pc(scale.x(seen))}
              x2="100%"
              y1="19"
              y2="19"
              stroke="var(--active)"
              strokeWidth="2"
              strokeDasharray="4 4"
            />
          )}
          {inbox.reads.map((r) => {
            if (Date.parse(r.to) < scale.start) return null;
            const x = scale.x(r.from);
            const tip = tipOf(clock, (k) => ({
              lines: [
                r.count === 1 ? t.timeline.inboxRead(k(r.from)) : t.timeline.inboxWatch(r.count, k(r.from), k(r.to)),
              ],
              color: watch,
            }));
            // A lone read is a tick; reads closer than a minute are one steady line.
            return r.count === 1 ? (
              <rect
                key={r.from}
                className="tl-read"
                x={pc(x)}
                y="15"
                width="2"
                height="8"
                rx="1"
                fill={watch}
                {...tip}
              />
            ) : (
              <line
                key={r.from}
                className="tl-watch"
                x1={pc(x)}
                x2={pc(scale.x(r.to))}
                y1="19"
                y2="19"
                stroke={watch}
                strokeWidth="2"
                strokeLinecap="round"
                {...tip}
              />
            );
          })}
        </svg>
      </span>
      <span className="tl-side" style={{ color }}>
        {c.state === "active"
          ? t.shell.coordinatorActive(t.ago(ms))
          : c.state === "idle"
            ? t.shell.coordinatorIdle(t.duration(ms))
            : t.shell.coordinatorUnknown}
      </span>
    </Row>
  );
}

/** The timeline's history, keyed `project/ticket` for rows and by project for coordinators. */
interface History {
  rows: Map<string, SessionTimeline>;
  coordinators: Map<string, CoordinatorTrack>;
}

const historyOf = (t: FleetTimeline): History => ({
  rows: new Map(t.rows.map((r) => [`${r.project}/${r.id}`, r.timeline])),
  coordinators: new Map(t.coordinators.map((c) => [c.project, c.inboxTrack])),
});

/**
 * Reads the timeline's history while the section is on screen, again each
 * time the overview changes (a report, an inbox read), with its ETag: the
 * server answers 304 while nothing moved. Off screen, or without an element
 * (a history given to the timeline), nothing is read.
 */
function useTimelineHistory(el: HTMLElement | null, overviewAt: string): History {
  const [history, setHistory] = useState<History>(() => historyOf({ rows: [], coordinators: [] }));
  const [visible, setVisible] = useState(false);
  const tag = useRef<string | null>(null);

  useEffect(() => {
    if (!el) return;
    const seen = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), { rootMargin: "200px" });
    seen.observe(el);
    return () => seen.disconnect();
  }, [el]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new overview is the signal to read the history again
  useEffect(() => {
    if (!visible) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/fleet/timeline", {
          cache: "no-store",
          headers: tag.current ? { "If-None-Match": tag.current } : {},
        });
        if (!live || res.status === 304 || !res.ok) return;
        const next = (await res.json()) as FleetTimeline;
        if (!live) return;
        tag.current = res.headers.get("etag");
        startTransition(() => setHistory(historyOf(next)));
      } catch {
        // The overview's poll says when the dashboard is offline; the rows keep the history they had.
      }
    })();
    return () => {
      live = false;
    };
  }, [visible, overviewAt]);

  return history;
}

/** A drag this far is a scroll, not a click on a row. */
const DRAG_PX = 4;

/**
 * The timeline's horizontal scroll: a mouse drag scrolls it (a touch screen
 * and a trackpad already do), a drag never opens the row it started on, and
 * `toNow` brings the view back to now. The scroller runs right to left, so
 * now is at scrollLeft 0 and stays there as the track grows.
 */
function useTimeScroll() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [atNow, setAtNow] = useState(true);
  const drag = useRef<{ x: number; left: number; id: number; moved: boolean } | null>(null);
  const swallow = useRef(false);

  useEffect(() => {
    if (!el) return;
    const scroll = () => setAtNow(el.scrollLeft >= -2);
    const down = (e: PointerEvent) => {
      swallow.current = false;
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      drag.current = { x: e.clientX, left: el.scrollLeft, id: e.pointerId, moved: false };
    };
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x;
      if (!d.moved && Math.abs(dx) < DRAG_PX) return;
      if (!d.moved) {
        d.moved = true;
        el.setPointerCapture(e.pointerId);
        el.classList.add("is-dragging");
      }
      el.scrollLeft = d.left - dx;
    };
    const up = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      drag.current = null;
      if (!d.moved) return;
      el.classList.remove("is-dragging");
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      // The click that may follow this release, in the same turn of the event loop, opens nothing.
      swallow.current = true;
      setTimeout(() => {
        swallow.current = false;
      }, 0);
    };
    // Rows are links: the browser's own link drag would cancel the scroll.
    const nativeDrag = (e: DragEvent) => e.preventDefault();
    // The click that ends a drag opens nothing.
    const click = (e: MouseEvent) => {
      if (!swallow.current) return;
      swallow.current = false;
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener("scroll", scroll, { passive: true });
    el.addEventListener("dragstart", nativeDrag);
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("click", click, true);
    return () => {
      el.removeEventListener("scroll", scroll);
      el.removeEventListener("dragstart", nativeDrag);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("click", click, true);
    };
  }, [el]);

  const toNow = useCallback(() => {
    if (!el) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: 0, behavior: still ? "auto" : "smooth" });
  }, [el]);

  return { ref: setEl, atNow, toNow };
}
