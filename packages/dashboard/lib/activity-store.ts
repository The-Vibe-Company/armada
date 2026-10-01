// What happened since the owner last looked (THE-894), read from the app's
// database: the Activity feed (every fleet event, newest first, one query
// over the events, the inbox and its answers, the validations and their
// decisions, the launches and their revokes, and the coordinator's starts
// and stops read from its inbox reads) and what the overview's "since you
// were away" sums up. Postgres only; each source is read by project and time
// through its own index, and the filters go into each source so a page is
// always full.
import {
  AWAY_MINUTES,
  type CatchupRecords,
  type FeedActorKind,
  type FeedCursor,
  type FeedEntry,
  type FeedKind,
  type FeedWho,
  REQUEST_KINDS,
  type ValidationKind,
} from "@armada/core/read";
import { isoAt, type Queryable, type Row, text } from "./db";

export interface FeedQuery {
  /** The projects the viewer may see; the feed reads only these. */
  projects: string[];
  /** Where the previous page ended; null for the newest. */
  before: FeedCursor | null;
  ticket: string | null;
  kinds: FeedKind[] | null;
  who: FeedWho | null;
  limit: number;
  now: Date;
}

/** How long the coordinator may go without reading its inbox before it counts as stopped, as its presence counts it. */
const TURN = `interval '${AWAY_MINUTES} minutes'`;
/** How long the coordinator's inbox reads are kept (`recordCoordinatorSeen`): the oldest one is no start. */
const READS_KEPT = "interval '7 days'";

const WORKER_FEED_KINDS = "('claim', 'report', 'release', 'merge')";
const REQUESTS = `(${[...REQUEST_KINDS, "request"].map((k) => `'${k}'`).join(", ")})`;

/**
 * One source of the feed: the kinds and actors it can give (a filter that
 * rules them out skips it), and its rows' columns over `$1`, the projects.
 */
interface Branch {
  kinds: FeedKind[];
  actors: FeedActorKind[];
  sql: string;
}

const COLUMNS = "key, project, ticket, kind, at, actor_kind, actor, body, phase, detail, ref";

const BRANCHES: Branch[] = [
  {
    kinds: ["claim", "report", "release", "merge"],
    actors: ["agent", "coordinator"],
    sql: `SELECT 'e:' || id AS key, project, ticket, kind, created_at AS at,
            CASE WHEN kind = 'merge' THEN 'coordinator' ELSE 'agent' END AS actor_kind, NULL::text AS actor,
            message AS body, phase, NULL::text AS detail, NULL::bigint AS ref
          FROM events WHERE project = ANY($1) AND kind IN ${WORKER_FEED_KINDS}`,
  },
  {
    kinds: ["question", "plan", "hand-back", "answer", "request"],
    actors: ["agent", "coordinator", "person"],
    sql: `SELECT 'i:' || id AS key, project, ticket,
            CASE WHEN kind IN ('question', 'plan', 'hand-back') THEN kind WHEN kind = 'note' THEN 'answer' ELSE 'request' END AS kind,
            created_at AS at,
            CASE WHEN kind IN ('question', 'plan', 'hand-back') THEN 'agent' WHEN kind = 'note' THEN 'coordinator' ELSE 'person' END
              AS actor_kind,
            CASE WHEN kind IN ${REQUESTS} THEN author END AS actor,
            body, NULL::text AS phase, CASE WHEN kind IN ${REQUESTS} OR kind = 'note' THEN kind END AS detail,
            NULL::bigint AS ref
          FROM inbox_items WHERE project = ANY($1) AND kind IN ('question', 'plan', 'hand-back', 'note', ${REQUESTS.slice(1, -1)})`,
  },
  {
    // A worker's question or plan, answered: the coordinator's answer.
    kinds: ["answer"],
    actors: ["coordinator"],
    sql: `SELECT 'a:' || id AS key, project, ticket, 'answer' AS kind, resolved_at AS at,
            'coordinator' AS actor_kind, NULL::text AS actor, resolution AS body, NULL::text AS phase, kind AS detail,
            NULL::bigint AS ref
          FROM inbox_items WHERE project = ANY($1) AND kind IN ('question', 'plan') AND resolved_at IS NOT NULL`,
  },
  {
    // Work a worker shows the owner; a merge or a question the coordinator puts to them.
    kinds: ["validation"],
    actors: ["agent", "coordinator"],
    sql: `SELECT 'v:' || id AS key, project, ticket, 'validation' AS kind, created_at AS at,
            CASE WHEN kind = 'validation' THEN 'agent' ELSE 'coordinator' END AS actor_kind, NULL::text AS actor,
            what AS body, NULL::text AS phase, kind AS detail, id AS ref
          FROM validations WHERE project = ANY($1)`,
  },
  {
    kinds: ["decision"],
    actors: ["person"],
    sql: `SELECT 'd:' || id AS key, project, ticket, 'decision' AS kind, decided_at AS at,
            'person' AS actor_kind, decided_by AS actor, COALESCE(answer, note) AS body, NULL::text AS phase,
            outcome AS detail, id AS ref
          FROM validations WHERE project = ANY($1) AND decided_at IS NOT NULL AND outcome <> 'superseded'`,
  },
  {
    kinds: ["launch"],
    actors: ["person"],
    sql: `SELECT 'l:' || "id" AS key, "project" AS project, "ticket" AS ticket, 'launch' AS kind, "createdAt" AS at,
            'person' AS actor_kind, "launchedByLabel" AS actor, NULL::text AS body, NULL::text AS phase,
            NULL::text AS detail, NULL::bigint AS ref
          FROM "armada_worker" WHERE "project" = ANY($1)`,
  },
  {
    kinds: ["revoke"],
    actors: ["person"],
    sql: `SELECT 'r:' || "id" AS key, "project" AS project, "ticket" AS ticket, 'revoke' AS kind, "endedAt" AS at,
            'person' AS actor_kind, "endedByLabel" AS actor, NULL::text AS body, NULL::text AS phase,
            NULL::text AS detail, NULL::bigint AS ref
          FROM "armada_worker" WHERE "project" = ANY($1) AND "endReason" = 'revoked' AND "endedAt" IS NOT NULL`,
  },
];

/**
 * The coordinator of one project (`$p`) starting and stopping, from its inbox
 * reads: a read with none in the `AWAY_MINUTES` before it starts a turn, one
 * with none in the `AWAY_MINUTES` after it ends one. Read only over the span
 * the page covers, from `from` (null: as far as reads are kept) to past the
 * cursor: a read cut off at either end has none within `AWAY_MINUTES` on that
 * side, which is a turn either way.
 */
function coordinatorTurns(p: string, now: string, from: string): string {
  return `SELECT 'c:' || r.id || ':' || t.turn AS key, r.project, NULL::text AS ticket, 'coordinator' AS kind,
            r.created_at AS at, 'coordinator' AS actor_kind, NULL::text AS actor, NULL::text AS body,
            NULL::text AS phase, t.turn AS detail, NULL::bigint AS ref
          FROM (
            SELECT id, project, created_at,
              lead(created_at) OVER w AS older, lag(created_at) OVER w AS newer
            FROM events
            WHERE project = ${p} AND project = ANY($1) AND kind = 'inbox'
              AND ($2::timestamptz IS NULL OR created_at <= $2::timestamptz + ${TURN} * 2)
              AND (${from}::timestamptz IS NULL OR created_at >= ${from}::timestamptz - ${TURN} * 2)
            WINDOW w AS (ORDER BY created_at DESC, id DESC)
          ) r
          CROSS JOIN LATERAL (VALUES
            ('stop', (r.newer IS NULL AND ${now}::timestamptz - r.created_at > ${TURN}) OR r.newer - r.created_at > ${TURN}),
            ('start', (r.older IS NULL AND r.created_at > ${now}::timestamptz - ${READS_KEPT} + ${TURN})
                      OR r.created_at - r.older > ${TURN})
          ) AS t(turn, happened)
          WHERE t.happened AND (${from}::timestamptz IS NULL OR r.created_at >= ${from}::timestamptz)`;
}

const entryOf = (r: Row): FeedEntry => ({
  key: String(r.key),
  project: String(r.project),
  ticket: text(r.ticket) || null,
  kind: String(r.kind) as FeedKind,
  at: isoAt(r.at),
  actor: { kind: String(r.actor_kind) as FeedActorKind, name: text(r.actor) },
  text: text(r.body)?.trim() || null,
  phase: text(r.phase),
  detail: text(r.detail),
  ref: r.ref == null ? null : Number(r.ref),
});

const newestFirst = (a: FeedEntry, b: FeedEntry) =>
  a.at === b.at ? (a.key < b.key ? 1 : a.key > b.key ? -1 : 0) : a.at < b.at ? 1 : -1;

/**
 * One page of the feed, newest first: at most `limit` entries after the
 * cursor, each source filtered and limited on its own, then merged. The
 * coordinator's starts and stops are read second, over the span the other
 * sources' page covers: a week of inbox reads is never walked for one page.
 * Ties in time order by key, in bytes (`COLLATE "C"`), as the cursor compares them.
 */
export async function feedPage(db: Queryable, q: FeedQuery): Promise<FeedEntry[]> {
  if (q.projects.length === 0 || q.limit <= 0) return [];
  const params: unknown[] = [
    q.projects,
    q.before?.at ?? null,
    q.before?.key ?? null,
    q.ticket,
    q.kinds,
    q.who?.kind ?? null,
    q.who?.kind === "person" ? q.who.name : null,
    q.limit,
  ];
  const wanted = (b: Pick<Branch, "kinds" | "actors">) =>
    (!q.kinds || b.kinds.some((k) => q.kinds?.includes(k))) && (!q.who || b.actors.includes(q.who.kind));
  const filter = `
    WHERE ($2::timestamptz IS NULL OR at < $2::timestamptz OR (at = $2::timestamptz AND key COLLATE "C" < $3::text))
      AND ($4::text IS NULL OR ticket = $4::text)
      AND ($5::text[] IS NULL OR kind = ANY($5::text[]))
      AND ($6::text IS NULL OR actor_kind = $6::text)
      AND ($7::text IS NULL OR actor = $7::text)
    ORDER BY at DESC, key COLLATE "C" DESC LIMIT $8`;
  const read = async (sources: string[], values: unknown[]): Promise<FeedEntry[]> => {
    if (sources.length === 0) return [];
    const sql = `SELECT ${COLUMNS} FROM (${sources
      .map((s) => `(SELECT ${COLUMNS} FROM (${s}) f ${filter})`)
      .join(" UNION ALL ")}) page ORDER BY at DESC, key COLLATE "C" DESC LIMIT $8`;
    return (await db.query(sql, values)).rows.map(entryOf);
  };
  const entries = await read(
    BRANCHES.filter(wanted).map((b) => b.sql),
    params,
  );
  if (q.ticket || !wanted({ kinds: ["coordinator"], actors: ["coordinator"] })) return entries;
  // A full page covers its span; a short one reaches back as far as the reads are kept.
  const values = [...params, q.now, entries.length >= q.limit ? (entries.at(-1)?.at ?? null) : null];
  const turns = await read(
    q.projects.map((project) => coordinatorTurns(`$${values.push(project)}`, "$9", "$10")),
    values,
  );
  return [...entries, ...turns].sort(newestFirst).slice(0, q.limit);
}

/** The people the feed's "who" filter offers: who asked, decided, launched or revoked in the last 90 days. */
export async function feedPeople(db: Queryable, projects: string[], now: Date): Promise<string[]> {
  if (projects.length === 0) return [];
  const since = new Date(now.getTime() - 90 * 24 * 3_600_000);
  const rs = await db.query(
    `SELECT DISTINCT name FROM (
       SELECT author AS name FROM inbox_items WHERE project = ANY($1) AND created_at >= $2 AND kind IN ${REQUESTS}
       UNION SELECT decided_by FROM validations WHERE project = ANY($1) AND decided_at >= $2
       UNION SELECT "launchedByLabel" FROM "armada_worker" WHERE "project" = ANY($1) AND "createdAt" >= $2
       UNION SELECT "endedByLabel" FROM "armada_worker"
         WHERE "project" = ANY($1) AND "endReason" = 'revoked' AND "endedAt" >= $2
     ) people WHERE name IS NOT NULL AND name <> '' ORDER BY name LIMIT 50`,
    [projects, since],
  );
  return rs.rows.map((r) => String(r.name));
}

const HELD_KINDS = "('claim', 'report', 'heartbeat', 'release', 'merge')";

/**
 * What one project recorded while the viewer was away (from `since` to
 * `until`), for the overview's summary: its merges, claims and reports that
 * entered `blocked`; the silences of its held tickets that ended after `since`
 * (a gap between two events, heartbeats included, longer than
 * `silentAfterMinutes`, not after a release or merge), each with the phase
 * the ticket was in, read from each ticket's last event before `since` so a
 * gap crossing it is whole, and those going on now; and the validations
 * waiting for the owner.
 */
export async function catchupRecords(
  db: Queryable,
  project: string,
  window: { since: Date; until: Date },
  silentAfterMinutes: number,
  now: Date,
): Promise<CatchupRecords> {
  const { since, until } = window;
  const lastBefore = (more: string) => `(SELECT id, ticket, kind, phase, created_at FROM events
       WHERE project = $1 AND ticket = h.ticket AND kind IN ${HELD_KINDS} AND created_at < $2 ${more}
       ORDER BY created_at DESC, id DESC LIMIT 1)`;
  const [moments, gaps, silent, waiting] = await Promise.all([
    db.query(
      `SELECT ticket, kind, created_at FROM events
       WHERE project = $1 AND kind IN ${WORKER_FEED_KINDS} AND created_at >= $2 AND created_at <= $3
         AND (kind IN ('merge', 'claim') OR (kind = 'report' AND phase = 'blocked'))
       ORDER BY created_at`,
      [project, since, until],
    ),
    db.query(
      `WITH recent AS (
         SELECT id, ticket, kind, phase, created_at FROM events
         WHERE project = $1 AND ticket <> '' AND kind IN ${HELD_KINDS} AND created_at >= $2 AND created_at <= $3
       ), earlier AS (
         -- Each ticket's last event before the window, and the last that named a phase.
         SELECT e.* FROM (SELECT DISTINCT ticket FROM recent) h
         CROSS JOIN LATERAL (${lastBefore("")} UNION ${lastBefore("AND phase IS NOT NULL")}) e
       ), counted AS (
         SELECT *, count(phase) OVER (PARTITION BY ticket ORDER BY created_at, id) AS phased
         FROM (SELECT * FROM recent UNION SELECT * FROM earlier) t
       ), phased AS (
         -- The phase each event leaves the ticket in: the last one reported.
         SELECT *, max(phase) OVER (PARTITION BY ticket, phased) AS current FROM counted
       ), walked AS (
         SELECT ticket, created_at, lag(created_at) OVER w AS previous, lag(kind) OVER w AS previous_kind,
           lag(current) OVER w AS during
         FROM phased WINDOW w AS (PARTITION BY ticket ORDER BY created_at, id)
       )
       SELECT ticket, previous, created_at, during FROM walked
       WHERE created_at >= $2 AND previous_kind NOT IN ('release', 'merge')
         AND created_at - previous > $4::float8 * interval '1 minute'`,
      [project, since, until, silentAfterMinutes],
    ),
    db.query(
      `SELECT DISTINCT s.ticket, last.at, phase.phase FROM fleet_sessions s
       CROSS JOIN LATERAL (
         SELECT created_at AS at, kind FROM events e
         WHERE e.project = s.project AND e.ticket = s.ticket AND e.kind IN ${HELD_KINDS}
         ORDER BY created_at DESC, id DESC LIMIT 1
       ) last
       LEFT JOIN LATERAL (
         SELECT e.phase FROM events e
         WHERE e.project = s.project AND e.ticket = s.ticket AND e.kind IN ${HELD_KINDS} AND e.phase IS NOT NULL
         ORDER BY created_at DESC, id DESC LIMIT 1
       ) phase ON true
       WHERE s.project = $1 AND s.released_at IS NULL AND last.kind NOT IN ('release', 'merge')
         AND last.at < $2::timestamptz - $3::float8 * interval '1 minute'`,
      [project, now, silentAfterMinutes],
    ),
    db.query("SELECT id, ticket, kind FROM validations WHERE project = $1 AND decided_at IS NULL ORDER BY id", [
      project,
    ]),
  ]);
  const of = (kind: string) =>
    moments.rows.filter((r) => r.kind === kind).map((r) => ({ ticket: String(r.ticket), at: isoAt(r.created_at) }));
  return {
    project,
    silentAfterMinutes,
    merged: of("merge"),
    claimed: of("claim"),
    blocked: of("report"),
    gaps: [
      ...gaps.rows.map((r) => ({
        ticket: String(r.ticket),
        from: isoAt(r.previous),
        to: isoAt(r.created_at),
        phase: text(r.during),
      })),
      ...silent.rows.map((r) => ({ ticket: String(r.ticket), from: isoAt(r.at), to: null, phase: text(r.phase) })),
    ],
    waiting: waiting.rows.map((r) => ({
      id: Number(r.id),
      ticket: String(r.ticket),
      kind: String(r.kind) as ValidationKind,
    })),
  };
}
