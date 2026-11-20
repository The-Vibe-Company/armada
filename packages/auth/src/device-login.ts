import { randomHex, sha256Hex } from "./codec.ts";

interface DeviceSql {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction?<T>(work: (sql: DeviceSql) => Promise<T>): Promise<T>;
}

type Poll =
  | { status: "expired_token" | "access_denied" }
  | { status: "authorization_pending" | "slow_down"; interval: number }
  | { status: "approved"; userId: string };

const requests = "armada_auth.oauth_device_requests";

export function createDeviceLoginStore(db: DeviceSql) {
  const transaction = db.transaction?.bind(db);
  if (!transaction) throw new Error("Device login requires database transactions.");

  return {
    async start(hostname: string) {
      const id = crypto.randomUUID();
      const deviceCode = randomHex(32);
      const userCode = randomHex(4).toUpperCase();
      const hash = await sha256Hex(deviceCode);
      return transaction(async (sql) => {
        await sql.query("select pg_advisory_xact_lock(714350551)");
        await sql.query(`delete from ${requests} where expires_at <= clock_timestamp()`);
        const { rows } = await sql.query(
          `with stamp as (select clock_timestamp() as now)
           insert into ${requests} (id, device_hash, user_code, hostname, created_at, expires_at, next_poll_at)
           select $1, $2, $3, $4, now, now + interval '10 minutes', now + interval '5 seconds' from stamp
           where (select count(*) from ${requests} where created_at > stamp.now - interval '1 minute') < 120
           returning id`,
          [id, hash, userCode, hostname],
        );
        return rows.length ? { id, deviceCode, userCode, expiresIn: 600, interval: 5 } : null;
      });
    },

    async inspect(id: string) {
      const { rows } = await db.query<{ user_code: string; hostname: string }>(
        `select user_code, hostname from ${requests}
         where id = $1 and state = 'pending' and expires_at > clock_timestamp()`,
        [id],
      );
      const row = rows[0];
      return row ? { user_code: row.user_code, hostname: row.hostname } : null;
    },

    async decide(id: string, userCode: string, userId: string, approve: boolean) {
      const { rows } = await db.query(
        `update ${requests} set state = $4, user_id = $3
         where id = $1 and user_code = $2 and state = 'pending' and expires_at > clock_timestamp()
         returning id`,
        [id, userCode, userId, approve ? "approved" : "denied"],
      );
      return rows.length > 0;
    },

    async poll(deviceCode: string) {
      const hash = await sha256Hex(deviceCode);
      return transaction<Poll>(async (sql) => {
        const { rows } = await sql.query<{
          state: string;
          user_id: string;
          poll_interval: number;
          early: boolean;
        }>(
          `select state, user_id, poll_interval, next_poll_at > clock_timestamp() as early
           from ${requests} where device_hash = $1 and expires_at > clock_timestamp() for update`,
          [hash],
        );
        const row = rows[0];
        if (!row || row.state === "consumed") return { status: "expired_token" };
        if (row.state === "denied") return { status: "access_denied" };
        if (!row.early && row.state === "approved") {
          const consumed = await sql.query(
            `update ${requests} set state = 'consumed'
             where device_hash = $1 and expires_at > clock_timestamp() returning id`,
            [hash],
          );
          return consumed.rows.length ? { status: "approved", userId: row.user_id } : { status: "expired_token" };
        }
        const interval = row.early ? Math.min(row.poll_interval + 5, 600) : row.poll_interval;
        await sql.query(
          `update ${requests} set poll_interval = $2, next_poll_at = clock_timestamp() + $2::integer * interval '1 second'
           where device_hash = $1`,
          [hash, interval],
        );
        return { status: row.early ? "slow_down" : "authorization_pending", interval };
      });
    },
  };
}
