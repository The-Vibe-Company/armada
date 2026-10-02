// /activity (THE-894): every event of the fleet, newest first, grouped by
// day in the viewer's time zone, with a divider at their last visit.
// Rendered on the server from Postgres (`loadActivity`), on the page kit:
// the filters are a GET form, so every view is an address; each row opens
// the ticket's agent, the validation or the project, and reads as one
// sentence (what, by whom, when). Long pages stay cheap: rows off screen are
// not laid out (`content-visibility`, as THE-892's lists).
import type { FeedEntry } from "@armada/core/read";
import { FEED_KINDS } from "@armada/core/read";
import Link from "next/link";
import {
  activityHref,
  clockIn,
  entryColor,
  entryHref,
  entryWhat,
  entryWho,
  type FeedDay,
  feedDays,
  filtered,
} from "@/lib/activity-view";
import type { ActivityQuery, ActivityReading } from "@/lib/fleet-data";
import type { Strings } from "@/lib/i18n";
import { excerpt } from "@/lib/overview-view";
import { SaveView } from "../FilterBar";
import { LiveMark } from "../mark";
import {
  Alert,
  Button,
  Form,
  Input,
  Page,
  Row,
  RowIcon,
  RowId,
  RowSide,
  RowText,
  RowTime,
  Section,
  SectionBody,
  Select,
  StatusHeader,
  Toolbar,
} from "../page";
import { Dot, EmptyState, ProjectChip } from "../ui";

interface Ctx {
  t: Strings;
  r: ActivityReading;
  zone: string;
  /** More than one project is shown: each row names its own. */
  many: boolean;
}

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
  /** The viewer's last visit, where the "new" divider goes; null when unknown. */
  since: string | null;
}) {
  const ctx: Ctx = { t, r, zone, many: q.project === null && r.projects.length > 1 };
  const { days, divider } = feedDays(t, r.entries, { zone, now, since });
  let dividerShown = false;
  const fresh = days.reduce((n, d) => n + d.fresh.length, 0);
  return (
    <Page
      status={
        <StatusHeader
          lead={
            divider === null && fresh === 0 ? t.activity.leadAll : fresh ? t.activity.lead(fresh) : t.activity.leadNone
          }
          line={t.activity.line}
        />
      }
      toolbar={
        <Toolbar end={<SaveView list="activity" query={activityHref({ ...q, before: null }).split("?")[1] ?? ""} />}>
          {<Filters t={t} r={r} q={q} />}
        </Toolbar>
      }
    >
      {!r.live && <Alert tone="warn" title={t.activity.unreachable} />}
      {r.live && r.entries.length === 0 && (
        <EmptyState title={filtered(q) || q.before ? t.activity.emptyFiltered : t.activity.empty} />
      )}
      {days.map((d) => {
        // The divider goes once, before the first entry older than the visit.
        const here = divider !== null && !dividerShown && d.seen.length > 0;
        if (here) dividerShown = true;
        return <Day key={d.day} ctx={ctx} day={d} divider={here ? divider : null} />;
      })}
      {(r.next || q.before) && (
        <SectionBody className="act-pages">
          {q.before && (
            <Link href={activityHref({ ...q, before: null })} prefetch={false} className="act-page">
              {t.activity.newest}
            </Link>
          )}
          {r.next && (
            <Link href={activityHref({ ...q, before: r.next })} prefetch={false} rel="next" className="act-page">
              {t.activity.older} →
            </Link>
          )}
        </SectionBody>
      )}
    </Page>
  );
}

/** Project, ticket, kind and who, in the address: a plain GET form, which works before any script. */
function Filters({ t, r, q }: { t: Strings; r: ActivityReading; q: ActivityQuery }) {
  const who =
    q.who === null ? "" : q.who.kind === "coordinator" ? "coordinator" : q.who.kind === "agent" ? "agents" : q.who.name;
  const people = q.who?.kind === "person" && !r.people.includes(q.who.name) ? [...r.people, q.who.name] : r.people;
  return (
    <Form method="get" action="/activity" role="search" aria-label={t.activity.filters} className="act-filters">
      {r.projects.length > 1 && (
        <>
          <label className="sr-only" htmlFor="act-project">
            {t.activity.project}
          </label>
          <Select id="act-project" name="project" defaultValue={q.project ?? ""}>
            <option value="">{t.activity.allProjects}</option>
            {r.projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </Select>
        </>
      )}
      <label className="sr-only" htmlFor="act-ticket">
        {t.activity.ticket}
      </label>
      <Input
        id="act-ticket"
        name="ticket"
        defaultValue={q.ticket ?? ""}
        placeholder={t.activity.ticketHint}
        autoComplete="off"
        spellCheck={false}
        className="act-ticket"
      />
      <label className="sr-only" htmlFor="act-kind">
        {t.activity.kind}
      </label>
      <Select id="act-kind" name="kind" defaultValue={q.kind ?? ""}>
        <option value="">{t.activity.allKinds}</option>
        {FEED_KINDS.map((k) => (
          <option key={k} value={k}>
            {t.activity.kinds[k]}
          </option>
        ))}
      </Select>
      <label className="sr-only" htmlFor="act-who">
        {t.activity.who}
      </label>
      <Select id="act-who" name="who" defaultValue={who}>
        <option value="">{t.activity.anyone}</option>
        <option value="coordinator">{t.activity.coordinator}</option>
        <option value="agents">{t.activity.agents}</option>
        {people.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </Select>
      <Button>{t.activity.apply}</Button>
      {filtered(q) && (
        <Link href="/activity" prefetch={false} className="act-clear">
          {t.activity.clear}
        </Link>
      )}
    </Form>
  );
}

function Day({ ctx, day, divider }: { ctx: Ctx; day: FeedDay; divider: string | null }) {
  const { t, zone } = ctx;
  const clock = divider ? clockIn(divider, zone, t.overview.locale) : null;
  return (
    <Section label={day.label} count={t.activity.shown(day.fresh.length + day.seen.length)}>
      {day.fresh.length > 0 && <Entries ctx={ctx} entries={day.fresh} />}
      {clock && (
        <h3 className="act-new">
          <span className="act-new-pill">
            <LiveMark size={12} />
            {t.activity.newSince(clock)}
          </span>
        </h3>
      )}
      {day.seen.length > 0 && <Entries ctx={ctx} entries={day.seen} />}
    </Section>
  );
}

function Entries({ ctx, entries }: { ctx: Ctx; entries: FeedEntry[] }) {
  return (
    <ol className="act-list">
      {entries.map((e) => (
        <li key={e.key}>
          <Entry ctx={ctx} e={e} />
        </li>
      ))}
    </ol>
  );
}

function Entry({ ctx, e }: { ctx: Ctx; e: FeedEntry }) {
  const { t, r, zone, many } = ctx;
  const title = e.ticket ? r.titles[`${e.project}/${e.ticket}`] : undefined;
  const what = entryWhat(t, e);
  const full = new Intl.DateTimeFormat(t.overview.locale, {
    timeZone: zone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date(e.at));
  return (
    <Row href={entryHref(e)} prefetch={false} className="act-row">
      <RowIcon>
        <Dot color={entryColor(e.kind)} />
      </RowIcon>
      <RowId>{e.ticket ?? <ProjectChip slug={e.project} bare />}</RowId>
      <RowText
        title={
          <>
            {what}
            {title && <span className="act-subject"> · {title}</span>}
          </>
        }
        line={e.text ? excerpt(e.text, 160) : undefined}
      />
      {many && (
        <RowSide roomy>
          <ProjectChip slug={e.project} name={r.projects.find((p) => p.slug === e.project)?.name ?? e.project} />
        </RowSide>
      )}
      <RowSide width={150}>
        <span className="act-who">{entryWho(t, e)}</span>
      </RowSide>
      <RowTime>
        <time dateTime={e.at} title={full}>
          {clockIn(e.at, zone, t.overview.locale)}
        </time>
      </RowTime>
    </Row>
  );
}
