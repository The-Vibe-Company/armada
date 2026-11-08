import {
  type GoldenConfig,
  GoldenError,
  type GoldenRow,
  type GoldenStore,
  type NewGolden,
  parseGoldenConfig,
  type Visibility,
} from "@armada/core";
import { SQL } from "bun";

/** A parameterized query. Postgres `$1` placeholders; the database driver binds them. */
export interface Queryable {
  query<T extends Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

const COLUMNS = `id, org_id, name, visibility::text as visibility, owner_id, boat_snapshot_id, config, created_at`;

interface SqlGolden extends Record<string, unknown> {
  id: string;
  org_id: string;
  name: string;
  visibility: string;
  owner_id: string;
  boat_snapshot_id: string | null;
  config: unknown;
  created_at: string | Date;
}

function iso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new GoldenError("invalid_config", "golden row has no created_at");
  return date.toISOString();
}

function visibilityOf(value: string): Visibility {
  if (value !== "org" && value !== "private") throw new GoldenError("invalid_config", "golden visibility is invalid");
  return value;
}

function rowOf(row: SqlGolden): GoldenRow {
  const configValue = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    visibility: visibilityOf(row.visibility),
    ownerId: row.owner_id,
    boatSnapshotId: row.boat_snapshot_id,
    config: parseGoldenConfig(configValue),
    createdAt: iso(row.created_at),
  };
}

function unique(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("duplicate key") ||
    message.includes("goldens_org_name_key") ||
    message.includes("goldens_private_name_key")
  );
}

/**
 * Goldens in Postgres. The connection is trusted (service role sees every row); callers filter with
 * `isGoldenVisible`. Updates name only the snapshot id or the config, never org, visibility or owner.
 */
export function goldenStore(db: Queryable): GoldenStore {
  return {
    async listOrg(orgId) {
      const result = await db.query<SqlGolden>(`select ${COLUMNS} from public.goldens where org_id = $1`, [orgId]);
      return result.rows.map(rowOf);
    },
    async insert(row: NewGolden) {
      try {
        const result = await db.query<SqlGolden>(
          `insert into public.goldens (id, org_id, name, visibility, owner_id, config)
           values ($1, $2, $3, $4::public.visibility, $5, $6::jsonb)
           returning ${COLUMNS}`,
          [row.id, row.orgId, row.name, row.visibility, row.ownerId, JSON.stringify(row.config)],
        );
        const stored = result.rows[0];
        if (!stored) throw new GoldenError("command_failed", "golden insert returned no row");
        return rowOf(stored);
      } catch (error) {
        if (error instanceof GoldenError) throw error;
        if (unique(error)) throw new GoldenError("exists", `golden '${row.name}' already exists`);
        throw error;
      }
    },
    async updateConfig(id: string, config: GoldenConfig) {
      const result = await db.query<{ id: string }>(
        `update public.goldens set config = $2::jsonb where id = $1 returning id`,
        [id, JSON.stringify(config)],
      );
      if (!result.rows[0]) throw new GoldenError("not_found", "golden no longer exists");
    },
    async setSnapshot(id, boatSnapshotId) {
      const result = await db.query<{ id: string }>(
        `update public.goldens set boat_snapshot_id = $2 where id = $1 returning id`,
        [id, boatSnapshotId],
      );
      if (!result.rows[0]) throw new GoldenError("not_found", "golden no longer exists");
    },
  };
}

/** Opens the golden store on `ARMADA_DATABASE_URL`. The URL is a secret and is never logged. */
export function goldenStoreFromDatabaseUrl(url: string): GoldenStore {
  const sql = new SQL(url);
  return goldenStore({
    async query<T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []) {
      const rows = await sql.unsafe<T[]>(text, [...params]);
      return { rows };
    },
  });
}
