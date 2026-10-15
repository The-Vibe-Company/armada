// GET /api/stats: how many accounts the dashboard has and how many used it
// lately, for a dashboard of the operator's. Read-only. The route checks its
// own bearer (STATS_TOKEN) before opening accounts or the database, behind
// both gates; without STATS_TOKEN it refuses every request.
//
// Users are Better Auth's `user` rows with a confirmed address (an email
// sign-up that was never confirmed cannot sign in), new ones by creation time. Active ones are
// people the shell's visit beacon saw (`fleet_viewers`, THE-894: the last time
// each was seen per organization, so a person seen within a window has a visit
// in it); a terminal's use of the CLI is not counted. A number the dashboard
// cannot know is null: all of them while it has no accounts.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Queryable } from "./db";

export const STATS_VARIABLE = "STATS_TOKEN";

export interface Stats {
  total_users: number | null;
  new_users_1d: number | null;
  new_users_7d: number | null;
  active_users_1d: number | null;
  active_users_7d: number | null;
}

const UNKNOWN: Stats = {
  total_users: null,
  new_users_1d: null,
  new_users_7d: null,
  active_users_1d: null,
  active_users_7d: null,
};

const DAY = 24 * 3600 * 1000;

/** The numbers at `now`, in one read-only statement. */
export async function readStats(db: Queryable, now: Date): Promise<Stats> {
  const day = new Date(now.getTime() - DAY);
  const week = new Date(now.getTime() - 7 * DAY);
  const rs = await db.query(
    `SELECT
       (SELECT count(*) FROM "user" WHERE "emailVerified") AS total,
       (SELECT count(*) FROM "user" WHERE "emailVerified" AND "createdAt" >= $1) AS new_1d,
       (SELECT count(*) FROM "user" WHERE "emailVerified" AND "createdAt" >= $2) AS new_7d,
       (SELECT count(DISTINCT u."id") FROM fleet_viewers v JOIN "user" u ON v.viewer = 'user:' || u."id"
         WHERE u."emailVerified" AND v.seen_at >= $1) AS active_1d,
       (SELECT count(DISTINCT u."id") FROM fleet_viewers v JOIN "user" u ON v.viewer = 'user:' || u."id"
         WHERE u."emailVerified" AND v.seen_at >= $2) AS active_7d`,
    [day, week],
  );
  const row = rs.rows[0] ?? {};
  return {
    total_users: Number(row.total),
    new_users_1d: Number(row.new_1d),
    new_users_7d: Number(row.new_7d),
    active_users_1d: Number(row.active_1d),
    active_users_7d: Number(row.active_7d),
  };
}

const NO_STORE = { "cache-control": "no-store" };

/** Compared as digests: equal lengths, so neither the token nor its length shows in the time taken. */
const digest = (v: string) => createHash("sha256").update(v).digest();

export async function statsRoute(
  request: Request,
  deps: {
    token: string | undefined;
    /** The accounts' database; null while the dashboard has no accounts. */
    accounts: () => Promise<{ client: Queryable } | null>;
    now?: () => Date;
  },
): Promise<Response> {
  const actual = digest(request.headers.get("authorization") ?? "");
  const expected = digest(`Bearer ${deps.token ?? ""}`);
  if (!deps.token?.trim() || !timingSafeEqual(actual, expected))
    return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  try {
    const a = await deps.accounts();
    if (!a) return Response.json(UNKNOWN, { headers: NO_STORE });
    return Response.json(await readStats(a.client, (deps.now ?? (() => new Date()))()), { headers: NO_STORE });
  } catch (err) {
    // The detail stays in the server log.
    console.error(`armada dashboard: stats unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return Response.json({ error: "stats unavailable" }, { status: 503, headers: NO_STORE });
  }
}
