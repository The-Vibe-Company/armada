"use client";

// The overview's live timeline (THE-868, the mockup's "Flotte en direct"):
// per project, its coordinator's row (harness, active or idle and since when,
// a tick per inbox read), then a row per session in flight (its phases, the
// moment its pull request opened, its reports and its silences) over the last
// 2, 4 or 8 hours. Each row is one SVG in percent of its width, drawn from
// what core gives it (`FleetRow.timeline`, `coordinator.inboxReads`): no rule
// is decided here. Rows redraw every `STEP_MS` and on a new overview only.
import type { FleetRow, ProjectOverview } from "@armada/core/read";
import { memo, useEffect, useMemo, useState } from "react";
import { agentState, HARNESS_NAME, HARNESSES, type Harness, harnessCounts, harnessOf, paths } from "@/lib/fleet-view";
import type { Language, Strings } from "@/lib/i18n";
import { Row, RowSide, Section, SectionBody } from "../page";
import { rowProgress } from "../screens/AgentRow";
import { useFleet, useNow, useShell } from "../shell/context";
import { stateLabel } from "../shell/labels";
import { harnessColor, ProjectChip, StatusDot, Tabs, toneColor } from "../ui";
import {
  DEFAULT_SPAN,
  hourMarks,
  PHASE_COLOR,
  type Scale,
  SPANS,
  type Span,
  STEP_MS,
  scaleOf,
  segmentBox,
} from "./scale";

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

const pc = (n: number) => `${n.toFixed(3)}%`;

/** The timeline of the projects shown: every one, or the one the overview is filtered on. */
export function LiveTimeline({ project }: { project: string | null }) {
  const { overview } = useFleet();
  const { t, lang } = useShell();
  const now = useNow();
  const [span, setSpan] = useState<Span>(DEFAULT_SPAN);
  const [harness, setHarness] = useState<Harness | "all">("all");
  const [tip, setTip] = useState<(Tip & { x: number; y: number; left: boolean }) | null>(null);
  // Hour marks and tips follow the viewer's clock, which the server does not know: drawn once in the browser.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [box, setBox] = useState<HTMLDivElement | null>(null);

  // The scale moves by steps of the clock, not every second: the rows redraw only then.
  const end = Math.floor(now / STEP_MS) * STEP_MS;
  const scale = useMemo(() => scaleOf(end, span), [end, span]);
  const marks = useMemo(() => (mounted ? hourMarks(scale, span) : []), [mounted, scale, span]);
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
          <Tabs
            size="sm"
            label={t.timeline.span}
            value={String(span)}
            onChange={(v) => setSpan(Number(v) as Span)}
            items={SPANS.map((h) => ({ key: String(h), label: t.timeline.hours(h) }))}
          />
        </>
      }
    >
      <div className="tl" ref={setBox}>
        <Hatch />
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
          <RowSide roomy width={120}>
            <span />
          </RowSide>
        </Row>
        {projects.map((p) => {
          const own = rows.filter((r) => r.project === p.slug);
          return (
            <div key={p.slug} className="tl-group">
              <Row className="tl-group-h">
                <ProjectChip slug={p.slug} name={p.name} />
                <span className="ui-count">{own.length}</span>
              </Row>
              <CoordinatorRow project={p} scale={scale} marks={marks} t={t} clock={clock} now={now} />
              {own.map((r) => (
                <SessionRow key={r.id} row={r} scale={scale} marks={marks} t={t} clock={clock} />
              ))}
            </div>
          );
        })}
        <SectionBody className="tl-legend">
          <span>
            <i className="tl-swatch is-past" />
            {t.timeline.legend.past}
          </span>
          <span>
            <i className="tl-swatch is-current" />
            {t.timeline.legend.current}
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

/** The silences' hatching, defined once for every row. */
function Hatch() {
  return (
    <svg className="tl-defs" width="0" height="0" aria-hidden>
      <defs>
        <pattern id="tl-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="2" height="6" fill="rgba(255, 181, 71, 0.45)" />
        </pattern>
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

const SessionRow = memo(function SessionRow({ row: r, scale, marks, t, clock }: RowProps & { row: FleetRow }) {
  const state = agentState(r);
  const label = stateLabel(t, state, r.phase);
  const color = toneColor(state.status);
  const tl = r.timeline;
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
            return (
              <rect
                key={`${s.phase}-${s.from}`}
                className={current ? "tl-phase is-current" : "tl-phase"}
                x={pc(b.x)}
                y={current ? MID - 7 : MID - 4}
                width={pc(b.width)}
                height={current ? 14 : 8}
                rx={current ? 4 : 3}
                fill={PHASE_COLOR[s.phase]}
                {...tip}
              />
            );
          })}
          {tl.silences.map((s) => {
            const to = s.to === null ? scale.end : Date.parse(s.to);
            const x = scale.x(s.from);
            const w = scale.x(to) - x;
            if (w <= 0) return null;
            const tip = tipOf(clock, () => ({
              lines: [t.timeline.silence(t.duration(to - Date.parse(s.from)))],
              color: "var(--active)",
            }));
            return (
              <rect
                key={`${s.from}-${s.to}`}
                className="tl-silence"
                x={pc(x)}
                y={MID - 7}
                width={pc(w)}
                height="14"
                fill="url(#tl-hatch)"
                {...tip}
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
                r="3"
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
          <circle
            className={state.status === "running" ? "tl-cap is-live" : "tl-cap"}
            cx="100%"
            cy={MID}
            r="4"
            fill={color}
          />
        </svg>
      </span>
      <RowSide roomy width={120}>
        <span className="tl-side" style={{ color: r.silent ? "var(--active)" : undefined }}>
          {lastReport === null ? "—" : t.duration(Math.max(0, lastReport))}
        </span>
      </RowSide>
    </Row>
  );
});

/** A coordinator's row: a line while it works (dashed once idle), a tick per inbox read. */
function CoordinatorRow({
  project: p,
  scale,
  marks,
  t,
  clock,
  now,
}: RowProps & { project: ProjectOverview; now: number }) {
  const c = p.coordinator;
  const color = c.state === "active" ? "var(--done)" : c.state === "idle" ? "var(--active)" : "var(--text-3)";
  const seen = c.seenAt ? Date.parse(c.seenAt) : null;
  const started = c.startedAt ? Date.parse(c.startedAt) : seen;
  const ms = seen === null ? 0 : Math.max(0, now - seen);
  const reads = useMemo(() => c.inboxReads.filter((r) => Date.parse(r.at) >= scale.start), [c.inboxReads, scale]);
  return (
    <Row href={paths.project(p.slug)} className="tl-row is-coordinator">
      <span className="tl-label">
        <span className={`sc-coord-mark is-${c.state}`} style={{ color }} aria-hidden />
        <span className="tl-label-text">
          <span className="tl-coord">
            {t.timeline.coordinator(
              c.harness === "terminal" ? "Terminal" : c.harness ? HARNESS_NAME[harnessOf(c.harness)] : null,
            )}
          </span>
        </span>
      </span>
      <span className="tl-track is-short">
        <svg className="tl-svg" width="100%" height="38" aria-hidden>
          <Grid marks={marks} scale={scale} />
          {started !== null && seen !== null && (
            <rect
              className="tl-coord-line"
              x={pc(scale.x(started))}
              y="18"
              width={pc(Math.max(0, (c.state === "active" ? 100 : scale.x(seen)) - scale.x(started)))}
              height="2"
              fill={c.state === "active" ? "var(--done)" : "var(--text-3)"}
            />
          )}
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
          {reads.map((r) => (
            <rect
              key={r.id}
              className="tl-read"
              x={pc(scale.x(r.at))}
              y="15"
              width="2"
              height="8"
              rx="1"
              fill={color}
              {...tipOf(clock, (c) => ({ lines: [t.timeline.inboxRead(c(r.at))], color }))}
            />
          ))}
        </svg>
      </span>
      <RowSide roomy width={120}>
        <span className="tl-side" style={{ color }}>
          {c.state === "active"
            ? t.shell.coordinatorActive(t.ago(ms))
            : c.state === "idle"
              ? t.shell.coordinatorIdle(t.duration(ms))
              : t.shell.coordinatorUnknown}
        </span>
      </RowSide>
    </Row>
  );
}
