// The Insights page's charts (THE-893): small, honest SVG, no chart library,
// rendered on the server. Each is drawn for the eye only (`aria-hidden`, its
// marks out of the tab order): its caption says its numbers, and its table
// (`ChartTable`) is the same data for a screen reader and the keyboard.
// Bars and lines keep their pixel width at any size (`non-scaling-stroke`),
// so one viewBox fits every width without stretching a mark. Night watch
// (THE-899): the period before as ghost bars behind this one's, today in
// lime, the median inside its band up to the p90, recessive grid lines.
import type { ReactNode } from "react";

const W = 600;
const H = 100;

export interface Bar {
  key: string;
  value: number;
  /** The period before's at the same place: a ghost behind the bar. */
  previous?: number;
  /** What the bar says on hover: "Thu 5 Mar: 3 merged". */
  label: string;
  /** The tickets behind it. */
  href: string;
}

/** One bar per day or week, from the baseline, the period before as a ghost behind it, the last one (today) lit. */
export function Bars({ bars, caption }: { bars: Bar[]; caption: ReactNode }) {
  const peak = Math.max(1, ...bars.map((b) => Math.max(b.value, b.previous ?? 0)));
  const slot = W / Math.max(1, bars.length);
  // In pixels (the stroke does not scale): thin marks, a gap between bars at any width the page takes.
  const stroke = bars.length <= 8 ? 18 : bars.length <= 16 ? 14 : 10;
  const top = (v: number) => H - (v / peak) * (H - 4);
  return (
    <figure className="ins-figure">
      <svg
        className="ins-chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} className="ins-grid" x1={0} x2={W} y1={H * g} y2={H * g} vectorEffect="non-scaling-stroke" />
        ))}
        <line className="ins-axis" x1={0} x2={W} y1={H} y2={H} vectorEffect="non-scaling-stroke" />
        {bars.map((b, k) => {
          const x = slot * k + slot / 2;
          const last = k === bars.length - 1;
          return (
            <a key={b.key} href={b.href} tabIndex={-1} className="ins-bar-link">
              <title>{b.label}</title>
              <rect x={slot * k} y={0} width={slot} height={H} fill="transparent" />
              {b.previous ? (
                <line
                  className="ins-ghost"
                  x1={x}
                  x2={x}
                  y1={H}
                  y2={top(b.previous)}
                  strokeWidth={stroke + 6}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
              <line
                className={b.value ? (last ? "ins-bar is-today" : "ins-bar") : "ins-bar is-zero"}
                x1={x}
                x2={x}
                y1={H}
                y2={b.value ? top(b.value) : H - 2}
                strokeWidth={stroke}
                vectorEffect="non-scaling-stroke"
              />
            </a>
          );
        })}
      </svg>
      <figcaption className="ins-caption">{caption}</figcaption>
    </figure>
  );
}

/**
 * A line through the values that have one (a gap where a day has none), each
 * point a dot; with `band`, an area from the line up to it (the p90).
 */
export function Sparkline({
  values,
  band,
  caption,
}: {
  values: (number | null)[];
  band?: (number | null)[];
  caption: ReactNode;
}) {
  const known = values.filter((v): v is number => v !== null);
  const peak = Math.max(1, ...known, ...(band ?? []).filter((v): v is number => v !== null));
  const step = values.length > 1 ? W / (values.length - 1) : 0;
  const point = (v: number, k: number) => `${values.length > 1 ? k * step : W / 2},${H - 4 - (v / peak) * (H - 8)}`;
  const runs: string[][] = [];
  for (const [k, v] of values.entries()) {
    if (v === null) runs.push([]);
    else if (runs.length) runs.at(-1)?.push(point(v, k));
    else runs.push([point(v, k)]);
  }
  return (
    <figure className="ins-figure">
      <svg
        className="ins-chart is-line"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} className="ins-grid" x1={0} x2={W} y1={H * g} y2={H * g} vectorEffect="non-scaling-stroke" />
        ))}
        <line className="ins-axis" x1={0} x2={W} y1={H} y2={H} vectorEffect="non-scaling-stroke" />
        {band && <Band values={values} band={band} point={point} />}
        {runs
          .filter((r) => r.length > 1)
          .map((r) => (
            <polyline key={r[0]} className="ins-line" points={r.join(" ")} vectorEffect="non-scaling-stroke" />
          ))}
        {values.map((v, k) => {
          if (v === null) return null;
          const [x, y] = point(v, k).split(",");
          // A zero-length line with round caps: a dot that stays round at any width.
          // biome-ignore lint/suspicious/noArrayIndexKey: one point per day, in order.
          return <line key={k} className="ins-dot" x1={x} x2={x} y1={y} y2={y} vectorEffect="non-scaling-stroke" />;
        })}
      </svg>
      <figcaption className="ins-caption">{caption}</figcaption>
    </figure>
  );
}

/** The area between a line and its band, over the days that have both: the p50 to p90 spread. */
function Band({
  values,
  band,
  point,
}: {
  values: (number | null)[];
  band: (number | null)[];
  point: (v: number, k: number) => string;
}) {
  const spans: { low: string[]; high: string[] }[] = [];
  let open: { low: string[]; high: string[] } | null = null;
  for (const [k, v] of values.entries()) {
    const top = band[k];
    if (v === null || top === null || top === undefined) {
      open = null;
      continue;
    }
    if (!open) {
      open = { low: [], high: [] };
      spans.push(open);
    }
    open.low.push(point(v, k));
    open.high.push(point(top, k));
  }
  return (
    <>
      {spans
        .filter((s) => s.low.length > 1)
        .map((s) => (
          <polygon key={s.low[0]} className="ins-band" points={[...s.low, ...s.high.reverse()].join(" ")} />
        ))}
    </>
  );
}

/** Where time goes, in one bar: a segment per part, as wide as its share. */
export function StackBar({ parts }: { parts: { key: string; value: number; color: string; label: string }[] }) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  if (total <= 0) return null;
  return (
    <span className="ins-stack" aria-hidden="true">
      {parts.map((p) => (
        <i key={p.key} title={p.label} style={{ flexGrow: p.value, background: p.color }} />
      ))}
    </span>
  );
}

/** A swatch of a chart's key. */
export function Swatch({ className }: { className: string }) {
  return <i className={`ins-swatch ${className}`} aria-hidden="true" />;
}

/** A row's bar: `value` out of `max`. */
export function Meter({ value, max, tone }: { value: number; max: number; tone?: string }) {
  const w = max > 0 ? Math.max(value > 0 ? 1.5 : 0, (value / max) * 100) : 0;
  return (
    <svg className="ins-meter" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <rect className="ins-meter-track" x={0} y={0} width={100} height={6} />
      <rect x={0} y={0} width={w} height={6} style={tone ? { fill: tone } : undefined} className="ins-meter-fill" />
    </svg>
  );
}

/** A chart's numbers as a table, folded under it: the accessible equivalent, and the links to each one's tickets. */
export function ChartTable({
  summary,
  head,
  rows,
}: {
  summary: string;
  head: string[];
  rows: { key: string; cells: ReactNode[] }[];
}) {
  return (
    <details className="ins-table">
      <summary>{summary}</summary>
      <table>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              {r.cells.map((c, k) =>
                k === 0 ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the columns are fixed.
                  <th key={k} scope="row">
                    {c}
                  </th>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the columns are fixed.
                  <td key={k}>{c}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
