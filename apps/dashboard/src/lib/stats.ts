import { createHash, timingSafeEqual } from "node:crypto";
export interface Queryable {
  query(sql: string, params: Date[]): Promise<{ rows: Record<string, unknown>[] }>;
}

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
    `SELECT count(*) AS total,
       count(*) FILTER (WHERE created_at >= $1) AS new_1d,
       count(*) FILTER (WHERE created_at >= $2) AS new_7d,
       count(*) FILTER (WHERE last_sign_in_at >= $1) AS active_1d,
       count(*) FILTER (WHERE last_sign_in_at >= $2) AS active_7d
     FROM auth.users WHERE email_confirmed_at IS NOT NULL`,
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
    // Only diagnostic identifiers: driver messages and other fields may contain credentials.
    const error = err as { name?: unknown; code?: unknown } | null | undefined;
    console.error("armada dashboard: stats query failed", {
      name: typeof error?.name === "string" ? error.name : undefined,
      code: typeof error?.code === "string" ? error.code : undefined,
    });
    return Response.json({ error: "stats unavailable" }, { status: 503, headers: NO_STORE });
  }
}
