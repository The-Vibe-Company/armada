// Each person's visits to the dashboard (THE-894), per organization: when
// they were last seen, where the visit going on started (their previous
// visit's last moment, when they were away more than `AWAY_MINUTES`), the
// summary they dismissed, and their notification settings. The shell records
// a visit on load, when the tab comes back and every few minutes while it is
// shown (`/api/fleet/visit`); the overview's "since you were away" and the
// Activity page's "new" divider read it. Under the shared-password gate,
// which has no people, the viewer is a cookie's random id.
import { AWAY_MINUTES, type Visit } from "@armada/core/read";
import { iso, type Queryable, type Row } from "./db";
import { NOTIFY_OFF, type NotifySettings, notifyOf } from "./notify";

/** Whose visits: a signed-in person in one organization, or a browser under the password gate (organization ''). */
export interface ViewerKey {
  viewer: string;
  organization: string;
}

export interface ViewerVisit extends Visit {
  notify: NotifySettings;
}

const visitOf = (r: Row | undefined): ViewerVisit => ({
  seenAt: iso(r?.seen_at),
  since: iso(r?.since),
  backAt: iso(r?.back_at),
  dismissedSince: iso(r?.dismissed_since),
  notify: notifyOf(typeof r?.notify === "string" ? JSON.parse(r.notify) : (r?.notify ?? null)) ?? NOTIFY_OFF,
});

/**
 * Records that the viewer is here at `now`. Back after more than
 * `AWAY_MINUTES`, a new visit starts from when they were last seen; the
 * first visit has no start. One statement, so two tabs agree.
 */
export async function recordVisit(db: Queryable, k: ViewerKey, now: Date): Promise<ViewerVisit> {
  const rs = await db.query(
    `INSERT INTO fleet_viewers (viewer, organization, seen_at, back_at) VALUES ($1, $2, $3, $3)
     ON CONFLICT (viewer, organization) DO UPDATE SET
       since = CASE WHEN excluded.seen_at - fleet_viewers.seen_at > $4::int * interval '1 minute'
                    THEN fleet_viewers.seen_at ELSE fleet_viewers.since END,
       back_at = CASE WHEN excluded.seen_at - fleet_viewers.seen_at > $4::int * interval '1 minute'
                      THEN excluded.seen_at ELSE fleet_viewers.back_at END,
       seen_at = GREATEST(fleet_viewers.seen_at, excluded.seen_at)
     RETURNING seen_at, since, back_at, dismissed_since, notify`,
    [k.viewer, k.organization, now, AWAY_MINUTES],
  );
  return visitOf(rs.rows[0]);
}

/** The viewer's visits as recorded, without recording one; a viewer never seen has none. */
export async function readVisit(db: Queryable, k: ViewerKey): Promise<ViewerVisit> {
  const rs = await db.query(
    "SELECT seen_at, since, back_at, dismissed_since, notify FROM fleet_viewers WHERE viewer = $1 AND organization = $2",
    [k.viewer, k.organization],
  );
  return visitOf(rs.rows[0]);
}

/** Hides the summary of the visit that started at `since`; a newer visit shows its own. */
export async function dismissSummary(db: Queryable, k: ViewerKey, since: Date): Promise<boolean> {
  const rs = await db.query(
    "UPDATE fleet_viewers SET dismissed_since = since WHERE viewer = $1 AND organization = $2 AND since = $3",
    [k.viewer, k.organization, since],
  );
  return rs.rowCount > 0;
}

export async function saveNotify(db: Queryable, k: ViewerKey, notify: NotifySettings, now: Date): Promise<void> {
  await db.query(
    `INSERT INTO fleet_viewers (viewer, organization, seen_at, notify) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (viewer, organization) DO UPDATE SET notify = excluded.notify`,
    [k.viewer, k.organization, now, JSON.stringify(notify)],
  );
}
