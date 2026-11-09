import type { Visibility } from "./contract.ts";
import type { GoldenRecord, GoldenStore } from "./golden.ts";
import { type GoldenConfig, GoldenError, parseGoldenConfig } from "./golden-config.ts";
import { isSandboxProvider, type ModalBinding } from "./sandbox-provider.ts";

/** The slice of a database client the golden store needs. Postgres `$1` parameters. */
export interface Sql {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs all queries issued through the callback on one transaction/connection. */
  transaction?<T>(work: (sql: Sql) => Promise<T>): Promise<T>;
}

/** A golden row as SQL and PostgREST return it. Shared by every reader of `public.goldens`. */
export interface GoldenRow {
  id: string;
  org_id: string;
  name: string;
  visibility: string;
  owner_id: string;
  provider: string;
  provider_sandbox_id: string | null;
  provider_snapshot_id: string | null;
  modal_workspace: string | null;
  modal_environment: string | null;
  modal_app_id: string | null;
  config: unknown;
  created_at: string | Date;
}

/** The columns {@link mapGoldenRow} reads, as a PostgREST `select=`. */
export const GOLDEN_SELECT =
  "id,org_id,name,visibility,owner_id,provider,provider_sandbox_id,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config,created_at";

const COLUMNS = `id, org_id, name, visibility::text as visibility, owner_id, provider::text as provider,
  provider_sandbox_id, provider_snapshot_id, modal_workspace, modal_environment, modal_app_id, config, created_at`;

/**
 * Goldens through SQL. The connection's role is the caller: row level security hides
 * a private golden from everyone but its owner, and refuses an org write from a member.
 */
export function createSqlGoldenStore(sql: Sql): GoldenStore {
  return {
    async list(orgId: string): Promise<GoldenRecord[]> {
      const result = await sql.query<GoldenRow>(
        `select ${COLUMNS} from public.goldens where org_id = $1 order by name asc, provider asc, visibility asc`,
        [orgId],
      );
      return result.rows.map(mapGoldenRow);
    },

    async findByName(orgId: string, name: string): Promise<GoldenRecord[]> {
      const result = await sql.query<GoldenRow>(
        `select ${COLUMNS} from public.goldens where org_id = $1 and name = $2 order by provider asc, visibility asc`,
        [orgId, name],
      );
      return result.rows.map(mapGoldenRow);
    },

    async insert(input): Promise<GoldenRecord> {
      try {
        const result = await sql.query<GoldenRow>(
          `insert into public.goldens (org_id, name, visibility, owner_id, provider, modal_workspace,
             modal_environment, modal_app_id, config)
           values ($1, $2, $3::public.visibility, $4, $5::public.sandbox_provider, $6, $7, $8, $9::jsonb)
           returning ${COLUMNS}`,
          [
            input.orgId,
            input.name,
            input.visibility,
            input.ownerId,
            input.provider,
            input.modal?.workspace ?? null,
            input.modal?.environment ?? null,
            input.modal?.appId ?? null,
            JSON.stringify(input.config),
          ],
        );
        const row = result.rows[0];
        if (!row) throw new GoldenError("forbidden", "The golden could not be created.");
        return mapGoldenRow(row);
      } catch (error) {
        throw mapWriteError(error);
      }
    },

    async setConfig(id: string, config: GoldenConfig): Promise<void> {
      await write(
        sql,
        `update public.goldens set config = $2::jsonb where id = $1 and (provider = 'boat' or provider_sandbox_id is null) returning id`,
        [id, JSON.stringify(config)],
      );
    },

    async setSandbox(id: string, boatSandboxId: string): Promise<void> {
      await write(
        sql,
        `update public.goldens set provider_sandbox_id = $2, boat_sandbox_id = case when provider = 'boat' then $2 else null end where id = $1 and (provider = 'boat' or provider_sandbox_id is null) returning id`,
        [id, boatSandboxId],
      );
    },

    // Write compatibility pairs explicitly: correctness must not depend on a repair trigger.
    // Modal's Boat aliases remain null.
    async setSnapshot(id: string, providerSnapshotId: string): Promise<void> {
      await write(
        sql,
        `update public.goldens set provider_snapshot_id = $2, boat_snapshot_id = case when provider = 'boat' then $2 else null end where id = $1 returning id`,
        [id, providerSnapshotId],
      );
    },
  };
}

async function write(sql: Sql, text: string, params: unknown[]): Promise<void> {
  try {
    const result = await sql.query<{ id: string }>(text, params);
    if (!result.rows[0]) throw new GoldenError("forbidden", "The golden could not be updated.");
  } catch (error) {
    throw mapWriteError(error);
  }
}

function mapWriteError(error: unknown): unknown {
  if (error instanceof GoldenError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("row-level security") || message.includes("42501")) {
    return new GoldenError("forbidden", "You cannot change this golden.", { cause: error });
  }
  if (message.includes("goldens_org_name_key") || message.includes("goldens_private_name_key")) {
    return new GoldenError("conflict", "A golden with this name already exists.", { cause: error });
  }
  if (message.includes("must not contain secrets")) {
    return new GoldenError("invalid_config", "Golden config must not contain secrets.", { cause: error });
  }
  return error;
}

/** A golden row as a record. The Modal binding is present exactly on a Modal golden. */
export function mapGoldenRow(row: GoldenRow): GoldenRecord {
  const visibility = row.visibility;
  if (visibility !== "org" && visibility !== "private") throw new Error("Golden row visibility is invalid.");
  const provider = row.provider;
  if (!isSandboxProvider(provider)) throw new Error("Golden row provider is invalid.");
  const config = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    visibility: visibility as Visibility,
    ownerId: row.owner_id,
    provider,
    providerSandboxId: row.provider_sandbox_id,
    providerSnapshotId: row.provider_snapshot_id,
    modal: modalBinding(provider, row),
    config: parseGoldenConfig(config),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function modalBinding(provider: string, row: GoldenRow): ModalBinding | null {
  if (provider !== "modal") return null;
  if (!row.modal_workspace || !row.modal_environment || !row.modal_app_id) {
    throw new Error("Modal golden row has no pinned binding.");
  }
  return { workspace: row.modal_workspace, environment: row.modal_environment, appId: row.modal_app_id };
}
