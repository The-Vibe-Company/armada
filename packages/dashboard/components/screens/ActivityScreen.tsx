// /activity (THE-894, THE-1021 on design/dashboard-v7): every event of the
// fleet, newest first. Its chips (everything, blocks, for you, merges,
// reports) are its address; each row reads time, kind (one word in its
// color), ticket, what happened and project, and opens the ticket's agent,
// the validation or the project. A line marks the viewer's last visit, the
// rows before it quieter; a day other than today gets its own line. Rendered
// on the server from Postgres (`loadActivity`); long pages stay cheap (rows
// off screen are not laid out, `content-visibility`).
import type { FeedEntry } from "@armada/core/read";
import Link from "next/link";
import { Fragment } from "react";
import {
  ACTIVITY_SHOWS,
  activityHref,
  clockIn,
  entryHref,
  entryKind,
  entryWhat,
  feedDays,
  KIND_COLOR,
} from "@/lib/activity-view";
import type { ActivityQuery, ActivityReading } from "@/lib/fleet-data";
import type { Strings } from "@/lib/i18n";
import { excerpt } from "@/lib/overview-view";
import { Alert } from "../page";

export function ActivityScreen({
  t,
  reading: r,
  query: q,
  zone,
  now,
  since,
}: {
  t: Strings;
  reading: ActivityReading;
  query: ActivityQuery;
  zone: string;
  now: Date;
  /** The viewer's last visit, where its line goes; null when unknown. */
  since: string | null;
}) {
  const a = t.activity;
  const { days, divider } = feedDays(t, r.entries, { zone, now, since });
  const names = new Map(r.projects.map((p) => [p.slug, p.name]));
  // A day's line only when the page holds another day than today.
  const dated = days.some((d) => d.label !== a.today);
  let lined = false;
  return (
    <div className="pg act">
      <div className="pg-head">
        <p className="pg-title">{a.title}</p>
        <p className="pg-sub">{a.line}</p>
      </div>
      <nav className="ov-chips" aria-label={a.chipsLabel}>
        {ACTIVITY_SHOWS.map((k) => (
          <Link
            key={k}
            href={activityHref({ show: k })}
            prefetch={false}
            className="ov-chip"
            aria-current={q.show === k ? "true" : undefined}
          >
            {a.chips[k]}
          </Link>
        ))}
      </nav>
      {!r.live && <Alert tone="warn" title={a.unreachable} />}
      {r.live && r.entries.length === 0 ? (
        <p className="pg-none">{q.show === "all" && !q.before ? a.empty : a.emptyShown}</p>
      ) : (
        <ol className={r.entries.length > 40 ? "act-list is-long" : "act-list"}>
          {days.map((d) => {
            // The visit's line goes once, before the first entry older than the visit.
            const here = divider !== null && !lined && d.seen.length > 0;
            if (here) lined = true;
            return (
              <Fragment key={d.day}>
                {dated && <li className="act-day">{d.label}</li>}
                {d.fresh.map((e) => (
                  <Entry key={e.key} t={t} e={e} r={r} zone={zone} names={names} />
                ))}
                {here && divider && (
                  <li className="act-visit">
                    <span>{a.lastVisit(clockIn(divider, zone, t.overview.locale))}</span>
                  </li>
                )}
                {d.seen.map((e) => (
                  <Entry key={e.key} t={t} e={e} r={r} zone={zone} names={names} seen={divider !== null} />
                ))}
              </Fragment>
            );
          })}
        </ol>
      )}
      {(r.next || q.before) && (
        <p className="act-pages">
          {q.before && (
            <Link href={activityHref({ show: q.show })} prefetch={false}>
              {a.newest}
            </Link>
          )}
          {r.next && (
            <Link href={activityHref({ show: q.show, before: r.next })} prefetch={false} rel="next">
              {a.older}
            </Link>
          )}
        </p>
      )}
    </div>
  );
}

function Entry({
  t,
  e,
  r,
  zone,
  names,
  seen = false,
}: {
  t: Strings;
  e: FeedEntry;
  r: ActivityReading;
  zone: string;
  names: Map<string, string>;
  seen?: boolean;
}) {
  const kind = entryKind(e);
  const color = KIND_COLOR[kind];
  const title = e.ticket ? r.titles[`${e.project}/${e.ticket}`] : undefined;
  const what = e.text
    ? excerpt(e.text.split("\n")[0] ?? "", 200)
    : [entryWhat(t, e), title].filter(Boolean).join(" · ");
  const full = new Intl.DateTimeFormat(t.overview.locale, {
    timeZone: zone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date(e.at));
  return (
    <li>
      <Link href={entryHref(e)} prefetch={false} data-row className={seen ? "act-row is-seen" : "act-row"}>
        <time dateTime={e.at} title={full}>
          {clockIn(e.at, zone, t.overview.locale)}
        </time>
        <span className="act-kind" style={{ color }}>
          <span className="act-dot" style={{ background: color }} aria-hidden />
          {t.activity.kinds[kind]}
        </span>
        <span className="act-ticket">{e.ticket ?? ""}</span>
        <span className="act-text">{what}</span>
        <span className="act-project">{names.get(e.project) ?? e.project}</span>
      </Link>
    </li>
  );
}
