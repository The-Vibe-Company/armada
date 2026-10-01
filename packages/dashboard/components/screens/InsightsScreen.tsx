// /insights (THE-893): how fast the fleet ships and where tickets wait, over
// 7, 30 or 90 days, for every project or one (both in the address). Rendered
// on the server from Postgres (`loadInsights`), on the page kit: the figures,
// the tickets shipped, claim to merge, where time goes, where tickets wait,
// the waits on people, quality, and the profiles and harnesses compared.
// Every number links to the tickets behind it (`?show=`), every chart has its
// table.
import type { FleetInsights, InsightComparison, InsightTicket, LabelPhase } from "@armada/core/read";
import Link from "next/link";
import type { InsightsReading } from "@/lib/fleet-data";
import { HARNESS_NAME, type Harness } from "@/lib/fleet-view";
import type { Strings } from "@/lib/i18n";
import {
  type Behind,
  behindOf,
  INSIGHT_RANGES,
  type InsightsQuery,
  insightKey,
  insightsHref,
  shippedBars,
  showOf,
  ticketHref,
  ticketsBehind,
} from "@/lib/insights-view";
import { Bars, ChartTable, Meter, Sparkline } from "../insights/Charts";
import {
  Card,
  CardGrid,
  CardHead,
  CardMeta,
  Notice,
  Page,
  Row,
  RowIcon,
  RowId,
  RowSide,
  RowText,
  RowTime,
  Section,
  SectionBody,
  Toolbar,
} from "../page";
import { Dot, EmptyState, ProjectChip, Tabs, Tag } from "../ui";

interface Ctx {
  t: Strings;
  r: InsightsReading;
  q: InsightsQuery;
  /** The page's address with `show` set: the tickets behind a number. */
  open: (b: Behind) => string;
}

export function InsightsScreen({
  t,
  reading: r,
  query: q,
}: {
  t: Strings;
  reading: InsightsReading;
  query: InsightsQuery;
}) {
  const i = r.insights;
  const ctx: Ctx = { t, r, q, open: (b) => `${insightsHref({ ...q, show: showOf(b) })}#behind` };
  const behind = behindOf(q.show);
  const shown = (r.project ? r.projects.filter((p) => p.slug === r.project) : r.projects).length;

  return (
    <Page
      toolbar={
        <Toolbar>
          <Tabs
            label={t.insights.rangeLabel}
            value={q.range}
            items={INSIGHT_RANGES.map((range) => ({
              key: range,
              label: t.insights.ranges[range],
              href: insightsHref({ ...q, range, show: null }),
            }))}
          />
          {r.projects.length > 1 && (
            <Tabs
              label={t.insights.projectLabel}
              value={q.project ?? "all"}
              items={[
                { key: "all", label: t.insights.allProjects, href: insightsHref({ ...q, project: null, show: null }) },
                ...r.projects.map((p) => ({
                  key: p.slug,
                  label: p.name,
                  href: insightsHref({ ...q, project: p.slug, show: null }),
                })),
              ]}
            />
          )}
        </Toolbar>
      }
    >
      {!r.live && <Notice tone="warn">{t.insights.unreachable}</Notice>}
      <Figures ctx={ctx} />
      {behind && <BehindSection ctx={ctx} behind={behind} />}
      {shown === 0 ? (
        <EmptyState title={t.noProjects} hint={t.noProjectsHint} />
      ) : (
        <>
          <Shipped ctx={ctx} />
          <CycleTime ctx={ctx} />
          <WhereTimeGoes ctx={ctx} />
          <WhereTicketsWait ctx={ctx} />
          <People ctx={ctx} />
          <Quality ctx={ctx} />
          <Compared ctx={ctx} kind="profile" list={i.profiles} />
          <Compared ctx={ctx} kind="harness" list={i.harnesses} />
        </>
      )}
    </Page>
  );
}

const isHarness = (key: string): key is Harness => key in HARNESS_NAME;
const dash = (t: Strings, ms: number | null) => (ms === null ? t.insights.none : t.duration(ms));
const percent = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const rate = (v: number | null) => (v === null ? "—" : v.toFixed(2));

/** "Thu 5 Mar", in the viewer's language, the day as UTC counts it. */
function dayLabel(t: Strings, day: string): string {
  return new Intl.DateTimeFormat(t.overview.locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));
}

/** The four headline figures, each a card that opens its tickets. */
function Figures({ ctx }: { ctx: Ctx }) {
  const { t, r, q, open } = ctx;
  const i = r.insights;
  const days = i.days.length;
  const change = i.merged.previous > 0 ? (i.merged.count - i.merged.previous) / i.merged.previous : null;
  return (
    <Section label={t.insights.period(days)}>
      <CardGrid>
        <Card href={open({ kind: "merged" })}>
          <CardHead label={t.insights.figures.merged} />
          <span className="ins-stat">{i.merged.count}</span>
          <CardMeta>{t.insights.trend(change, q.range)}</CardMeta>
        </Card>
        <Card href={open({ kind: "cycle" })}>
          <CardHead label={t.insights.figures.cycle} />
          <span className="ins-stat">{dash(t, i.cycle.p50)}</span>
          <CardMeta>
            {i.cycle.p90 !== null && `${t.insights.p90(t.duration(i.cycle.p90))} · `}
            {t.insights.previousMedian(i.cycle.previousP50 === null ? null : t.duration(i.cycle.previousP50))}
          </CardMeta>
        </Card>
        <Card href={open({ kind: "first-pass" })}>
          <CardHead label={t.insights.figures.firstPass} />
          <span className="ins-stat">{percent(i.firstPass.rate)}</span>
          <CardMeta>{t.insights.firstPassLine(i.firstPass.green, i.firstPass.handedBack)}</CardMeta>
        </Card>
        <Card href={open({ kind: "silences" })}>
          <CardHead label={t.insights.figures.silences} />
          <span className="ins-stat">{rate(i.silences.perWorkerHour)}</span>
          <CardMeta>{t.insights.silencesLine(i.silences.count, Math.round(i.silences.workerHours))}</CardMeta>
        </Card>
      </CardGrid>
    </Section>
  );
}

/** What a ticket's value says in a list: a duration, a number of heads, or nothing. */
function ticketValue(t: Strings, b: Behind, v: InsightTicket): string | null {
  if (v.value === null) return null;
  if (b.kind === "first-pass") return t.insights.heads(v.value);
  if (b.kind === "redone") return t.insights.newHeads(v.value);
  return t.duration(v.value);
}

function behindTitle(t: Strings, b: Behind): string {
  const s = t.insights.behind;
  switch (b.kind) {
    case "day":
      return s.day(dayLabel(t, b.day));
    case "week":
      return s.week(dayLabel(t, b.day));
    case "phase":
      return s.phase(t.insights.phases[b.phase]);
    case "waits":
      return s[b.who];
    case "profile":
      return s.profile(b.key === "none" ? t.insights.noProfile : b.key);
    case "harness":
      return s.harness(isHarness(b.key) ? HARNESS_NAME[b.key] : b.key);
    default:
      return s[b.kind];
  }
}

/** The tickets behind the number the address names, each opening its agent's page or its Linear issue. */
function BehindSection({ ctx, behind }: { ctx: Ctx; behind: Behind }) {
  const { t, r, q } = ctx;
  const list = ticketsBehind(r.insights, behind);
  return (
    <Section
      id="behind"
      label={behindTitle(t, behind)}
      count={list.length}
      side={
        <Link href={insightsHref({ ...q, show: null })} replace scroll={false} className="sc-figure is-link">
          {t.insights.close}
        </Link>
      }
    >
      {list.length === 0 ? (
        <SectionBody>
          <p>{t.insights.noTickets}</p>
        </SectionBody>
      ) : (
        list.map((v) => (
          <TicketRow key={`${v.project}/${v.ticket}/${v.at}`} ctx={ctx} project={v.project} ticket={v.ticket}>
            <RowTime>{ticketValue(t, behind, v) ?? dayLabel(t, v.at.slice(0, 10))}</RowTime>
          </TicketRow>
        ))
      )}
    </Section>
  );
}

function TicketRow({
  ctx,
  project,
  ticket,
  line,
  children,
}: {
  ctx: Ctx;
  project: string;
  ticket: string;
  line?: string;
  children: React.ReactNode;
}) {
  const { r } = ctx;
  const facts = r.tickets[insightKey(project, ticket)];
  const name = r.projects.find((p) => p.slug === project)?.name ?? project;
  return (
    <Row href={ticketHref(r, project, ticket) ?? undefined}>
      <RowIcon>
        <ProjectChip slug={project} name={name} bare />
      </RowIcon>
      <RowId>{ticket}</RowId>
      <RowText title={facts?.title ?? ticket} line={line ?? name} />
      {children}
    </Row>
  );
}

function Shipped({ ctx }: { ctx: Ctx }) {
  const { t, r, open } = ctx;
  const i = r.insights;
  const bars = shippedBars(i);
  const weekly = bars[0]?.kind === "week";
  const label = (b: (typeof bars)[number]) =>
    b.kind === "week" ? t.insights.weekOf(dayLabel(t, b.key)) : dayLabel(t, b.key);
  return (
    <Section label={t.insights.shipped} side={t.insights.shippedSide(i.merged.count, weekly)}>
      <SectionBody className="ins-body">
        <Bars
          bars={bars.map((b) => ({
            key: b.key,
            value: b.count,
            label: t.insights.bar(label(b), b.count),
            href: open({ kind: b.kind, day: b.key }),
          }))}
          caption={
            <>
              <span>{label(bars[0] ?? { key: i.days[0]?.day ?? "", kind: "day", count: 0 })}</span>
              <span>{t.insights.shippedChart(i.merged.count, Math.max(0, ...bars.map((b) => b.count)), weekly)}</span>
              <span>{bars.length ? label(bars[bars.length - 1] as (typeof bars)[number]) : ""}</span>
            </>
          }
        />
        <ChartTable
          summary={t.insights.table}
          head={[weekly ? t.insights.columns.week : t.insights.columns.day, t.insights.columns.merged]}
          rows={bars.map((b) => ({
            key: b.key,
            cells: [
              b.kind === "week" ? dayLabel(t, b.key) : dayLabel(t, b.key),
              <Link key="n" href={open({ kind: b.kind, day: b.key })}>
                {b.count}
              </Link>,
            ],
          }))}
        />
      </SectionBody>
    </Section>
  );
}

function CycleTime({ ctx }: { ctx: Ctx }) {
  const { t, r, open } = ctx;
  const c = r.insights.cycle;
  const days = r.insights.days;
  return (
    <Section
      label={t.insights.cycle}
      count={c.count}
      side={
        <Link href={open({ kind: "cycle" })} className="sc-figure is-link">
          {t.insights.cycleSide(dash(t, c.p50), dash(t, c.p90), c.count)}
        </Link>
      }
    >
      {c.count === 0 ? (
        <SectionBody>
          <p>{t.insights.empty}</p>
        </SectionBody>
      ) : (
        <SectionBody className="ins-body">
          <Sparkline values={c.daily} caption={<span>{t.insights.cycleChart(days.length, dash(t, c.p50))}</span>} />
          <ChartTable
            summary={t.insights.table}
            head={[t.insights.columns.day, t.insights.columns.median]}
            rows={days.flatMap((d, k) => {
              const v = c.daily[k];
              return v === null || v === undefined
                ? []
                : [
                    {
                      key: d.day,
                      cells: [
                        dayLabel(t, d.day),
                        <Link key="v" href={open({ kind: "day", day: d.day })}>
                          {t.duration(v)}
                        </Link>,
                      ],
                    },
                  ];
            })}
          />
        </SectionBody>
      )}
    </Section>
  );
}

const WAITING: readonly LabelPhase[] = ["awaiting-approval", "blocked", "ready-to-merge", "awaiting-validation"];

function WhereTimeGoes({ ctx }: { ctx: Ctx }) {
  const { t, r, open } = ctx;
  const phases = r.insights.phases.filter((p) => p.totalMs > 0);
  const max = Math.max(0, ...phases.map((p) => p.totalMs));
  return (
    <Section label={t.insights.where} side={t.insights.whereSide}>
      {phases.length === 0 ? (
        <SectionBody>
          <p>{t.insights.empty}</p>
        </SectionBody>
      ) : (
        phases.map((p) => (
          <Row key={p.phase} href={open({ kind: "phase", phase: p.phase })}>
            <RowIcon>
              <Dot color={WAITING.includes(p.phase) ? "var(--active)" : "var(--frontier)"} />
            </RowIcon>
            <RowText
              title={t.insights.phases[p.phase]}
              line={t.insights.phaseLine(dash(t, p.medianMs), p.tickets.length)}
            />
            <RowSide width={180}>
              <Meter value={p.totalMs} max={max} tone={WAITING.includes(p.phase) ? "var(--active)" : undefined} />
            </RowSide>
            <RowTime>{t.insights.total(p.totalMs)}</RowTime>
          </Row>
        ))
      )}
    </Section>
  );
}

function WhereTicketsWait({ ctx }: { ctx: Ctx }) {
  const { t, r } = ctx;
  const waits = r.insights.biggestWaits;
  return (
    <Section label={t.insights.waits} count={waits.length} side={t.insights.waitsSide}>
      {waits.length === 0 ? (
        <SectionBody>
          <p>{t.insights.waitsEmpty}</p>
        </SectionBody>
      ) : (
        waits.map((w) => (
          <TicketRow
            key={`${w.project}/${w.ticket}/${w.from}`}
            ctx={ctx}
            project={w.project}
            ticket={w.ticket}
            line={`${t.insights.phases[w.phase]} · ${t.insights.since(dayLabel(t, w.from.slice(0, 10)))}`}
          >
            {w.to === null && (
              <RowSide roomy>
                <Tag>{t.insights.ongoing}</Tag>
              </RowSide>
            )}
            <RowTime color="var(--active)">{t.duration(w.ms)}</RowTime>
          </TicketRow>
        ))
      )}
    </Section>
  );
}

function People({ ctx }: { ctx: Ctx }) {
  const { t, r, open } = ctx;
  const { coordinator, owner } = r.insights.waits;
  const row = (who: "coordinator" | "owner", w: FleetInsights["waits"]["owner"]) => (
    <Row key={who} href={open({ kind: "waits", who })}>
      <RowIcon>
        <Dot color={who === "owner" ? "var(--accent)" : "var(--text-3)"} />
      </RowIcon>
      <RowText title={t.insights[who]} line={t.insights[`${who}Hint`]} />
      <RowSide>
        {w.count || w.open ? t.insights.waitLine(dash(t, w.p50), dash(t, w.p90), w.count, w.open) : t.insights.noWait}
      </RowSide>
    </Row>
  );
  return (
    <Section label={t.insights.people}>
      {row("coordinator", coordinator)}
      {row("owner", owner)}
    </Section>
  );
}

function Quality({ ctx }: { ctx: Ctx }) {
  const { t, r, open } = ctx;
  const { firstPass, silences } = r.insights;
  return (
    <Section label={t.insights.quality}>
      <Row href={open({ kind: "first-pass" })}>
        <RowIcon>
          <Dot color="var(--done)" />
        </RowIcon>
        <RowText title={t.insights.firstPass} line={t.insights.firstPassLine(firstPass.green, firstPass.handedBack)} />
        <RowSide width={120}>
          <Meter value={firstPass.green} max={firstPass.handedBack} tone="var(--done)" />
        </RowSide>
        <RowTime>{percent(firstPass.rate)}</RowTime>
      </Row>
      <Row href={open({ kind: "redone" })}>
        <RowIcon>
          <Dot color="var(--critical)" />
        </RowIcon>
        <RowText title={t.insights.redone} line={t.insights.redoneLine(firstPass.redone.length)} />
        <RowTime>{firstPass.redone.length}</RowTime>
      </Row>
      <Row href={open({ kind: "silences" })}>
        <RowIcon>
          <Dot color="var(--active)" />
        </RowIcon>
        <RowText
          title={t.insights.silences}
          line={t.insights.silencesLine(silences.count, Math.round(silences.workerHours))}
        />
        <RowTime>{rate(silences.perWorkerHour)}</RowTime>
      </Row>
    </Section>
  );
}

function Compared({ ctx, kind, list }: { ctx: Ctx; kind: "profile" | "harness"; list: InsightComparison[] }) {
  const { t, open } = ctx;
  if (!list.length) return null;
  const max = Math.max(0, ...list.map((c) => c.merged));
  const name = (key: string) =>
    kind === "harness" ? (isHarness(key) ? HARNESS_NAME[key] : key) : key === "none" ? t.insights.noProfile : key;
  return (
    <Section label={kind === "profile" ? t.insights.profiles : t.insights.harnesses} side={t.insights.compareSide}>
      {list.map((c) => (
        <Row key={c.key} href={open({ kind, key: c.key })}>
          <RowIcon>
            <Dot color={kind === "harness" && isHarness(c.key) ? `var(--h-${c.key})` : "var(--text-3)"} />
          </RowIcon>
          <RowText
            title={name(c.key)}
            line={t.insights.compareLine({
              cycle: dash(t, c.cycleP50),
              replans: c.replans.toFixed(1),
              heads: c.newHeads.toFixed(1),
              silences: rate(c.silencesPerWorkerHour),
            })}
          />
          <RowSide width={120} roomy>
            <Meter value={c.merged} max={max} />
          </RowSide>
          <RowTime>{t.insights.merged(c.merged)}</RowTime>
        </Row>
      ))}
    </Section>
  );
}
