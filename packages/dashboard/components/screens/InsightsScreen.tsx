// /insights (THE-893, THE-1021 on design/dashboard-v7): how the fleet shipped
// over the last seven days, every project. Four numbers (tickets merged and
// the change from the week before, the median cycle from claim to merge, the
// median wait for the owner's decision, the first-pass green rate), the
// merges of each day, then the same per project. Rendered on the server from
// core's `buildInsights` (lib/fleet-data.ts `loadInsights`, Postgres only).
import type { FleetInsights } from "@armada/core/read";
import type { InsightsReading } from "@/lib/fleet-data";
import type { Strings } from "@/lib/i18n";
import { blockedMs, mergeBars, percent } from "@/lib/insights-view";
import { Alert } from "../page";

/** The bars' tallest height, in pixels. */
const BAR = 120;

export function InsightsScreen({ t, reading: r }: { t: Strings; reading: InsightsReading }) {
  const s = t.insights;
  const i = r.insights;
  const d = (ms: number | null) => (ms === null ? s.none : t.duration(ms));
  const rate = (x: number | null) => {
    const p = percent(x);
    return p === null ? s.none : `${p} %`;
  };
  const kpis = [
    {
      label: s.merged,
      value: String(i.merged.count),
      note: s.mergedNote(i.merged.previous ? i.merged.count - i.merged.previous : null),
    },
    { label: s.cycle, value: d(i.cycle.p50), note: s.cycleNote },
    { label: s.wait, value: d(i.waits.owner.p50), note: s.waitNote },
    { label: s.firstPass, value: rate(i.firstPass.rate), note: s.firstPassNote(i.firstPass.handedBack) },
  ];
  const bars = mergeBars(i);
  const peak = Math.max(1, ...bars.map((b) => b.count));
  const weekday = new Intl.DateTimeFormat(t.overview.locale, { weekday: "short", timeZone: "UTC" });
  const dayOf = (day: string) => weekday.format(new Date(`${day}T12:00:00Z`));
  return (
    <div className="pg ins">
      <div className="pg-head">
        <p className="pg-title">{s.title}</p>
        <p className="pg-sub">{s.line}</p>
      </div>
      {!r.live && <Alert tone="warn" title={s.unreachable} />}
      <dl className="ins-kpis">
        {kpis.map((k) => (
          <div key={k.label}>
            <dt>{k.label}</dt>
            <dd className="ins-value">{k.value}</dd>
            <dd className="ins-note">{k.note}</dd>
          </div>
        ))}
      </dl>
      <section className="ins-block" aria-labelledby="ins-days">
        <h2 className="ins-h" id="ins-days">
          {s.perDay}
        </h2>
        <ol className="ins-bars" aria-label={s.perDayChart(i.merged.count, peak)}>
          {bars.map((b, k) => (
            <li key={b.day} aria-label={s.bar(dayOf(b.day), b.count)}>
              <span className="ins-col" aria-hidden>
                <span className="ins-bar-n">{b.count}</span>
                <span
                  className={k === bars.length - 1 ? "ins-bar is-today" : "ins-bar"}
                  style={{ height: `${Math.round((b.count / peak) * BAR)}px` }}
                />
              </span>
              <span className="ins-bar-day" aria-hidden>
                {dayOf(b.day)}
              </span>
            </li>
          ))}
        </ol>
      </section>
      <section className="ins-block" aria-labelledby="ins-projects">
        <h2 className="ins-h" id="ins-projects">
          {s.byProject}
        </h2>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a table that scrolls sideways on a phone takes the keyboard (axe: scrollable-region-focusable) */}
        <div className="ins-scroll" tabIndex={0}>
          <table className="ins-table">
            <thead>
              <tr>
                <th scope="col">{s.columns.project}</th>
                <th scope="col">{s.columns.merged}</th>
                <th scope="col">{s.columns.cycle}</th>
                <th scope="col">{s.columns.blocked}</th>
                <th scope="col">{s.columns.firstPass}</th>
              </tr>
            </thead>
            <tbody>
              {r.byProject.map((p) => (
                <ProjectRow key={p.slug} name={p.name} i={p.insights} t={t} d={d} rate={rate} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ProjectRow({
  name,
  i,
  t,
  d,
  rate,
}: {
  name: string;
  i: FleetInsights;
  t: Strings;
  d: (ms: number | null) => string;
  rate: (x: number | null) => string;
}) {
  const blocked = blockedMs(i);
  return (
    <tr>
      <th scope="row">{name}</th>
      <td>{i.merged.count}</td>
      <td>{d(i.cycle.p50)}</td>
      <td>{blocked ? t.insights.total(blocked) : t.insights.none}</td>
      <td>{rate(i.firstPass.rate)}</td>
    </tr>
  );
}
