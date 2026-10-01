// The Insights page's charts (THE-893): small, honest SVG, no chart library,
// rendered on the server. Each is drawn for the eye only (`aria-hidden`, its
// marks out of the tab order): its caption says its numbers, and its table
// (`ChartTable`) is the same data for a screen reader and the keyboard.
// Bars and lines keep their pixel width at any size (`non-scaling-stroke`),
// so one viewBox fits every width without stretching a mark.
import type { ReactNode } from "react";

const W = 600;
const H = 100;

export interface Bar {
  key: string;
  value: number;
  /** What the bar says on hover: "Thu 5 Mar: 3 merged". */
  label: string;
  /** The tickets behind it. */
  href: string;
}

/** One bar per day or week, from the baseline, the peak labelled. */
export function Bars({ bars, caption }: { bars: Bar[]; caption: ReactNode }) {
  const peak = Math.max(1, ...bars.map((b) => b.value));
  const slot = W / Math.max(1, bars.length);
  // In pixels (the stroke does not scale): thin marks, a gap between bars at any width the page takes.
  const stroke = bars.length <= 8 ? 16 : bars.length <= 16 ? 12 : 8;
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
        <line className="ins-axis" x1={0} x2={W} y1={H} y2={H} vectorEffect="non-scaling-stroke" />
        {bars.map((b, k) => {
          const x = slot * k + slot / 2;
          return (
            <a key={b.key} href={b.href} tabIndex={-1} className="ins-bar-link">
              <title>{b.label}</title>
              <rect x={slot * k} y={0} width={slot} height={H} fill="transparent" />
              <line
                className={b.value ? "ins-bar" : "ins-bar is-zero"}
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

/** A line through the values that have one (a gap where a day has none), each point a dot. */
export function Sparkline({ values, caption }: { values: (number | null)[]; caption: ReactNode }) {
  const known = values.filter((v): v is number => v !== null);
  const peak = Math.max(1, ...known);
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
        <line className="ins-axis" x1={0} x2={W} y1={H} y2={H} vectorEffect="non-scaling-stroke" />
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
