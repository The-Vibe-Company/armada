import {
  GoldenError,
  type GoldenRecord,
  type GoldenStore,
  mapSandboxRow,
  parseGoldenConfig,
  type SandboxRecord,
  type SandboxRow,
  type SandboxStatus,
  type SandboxStore,
  type Sql,
  statusReasonOf,
  type Visibility,
} from "@armada/core";
import type { Caller } from "./caller.ts";

/** A sandbox with what the caller needs to know about its golden. */
export interface SandboxView extends SandboxRecord {
  golden: string;
  visibility: Visibility;
}

export interface ServerSandboxStore extends SandboxStore {
  /** Null when it does not exist or the caller may not see it: the two are not told apart. */
  get(id: string): Promise<SandboxView | null>;
  /** Newest first. */
  list(filter: { statuses?: readonly SandboxStatus[]; limit: number }): Promise<SandboxView[]>;
}

/**
 * What one caller may read and change. The server's database connection is privileged, so row level
 * security does not apply to it: every query here carries the same rule itself. The caller's orgs only,
 * and a private golden and its sandboxes only for the owner, admins included.
 */
export interface ScopedData {
  goldens: GoldenStore;
  sandboxes: ServerSandboxStore;
}

export type DataSource = (caller: Caller) => ScopedData;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GOLDEN_COLUMNS = `g.id, g.org_id, g.name, g.visibility::text as visibility, g.owner_id,
  g.boat_snapshot_id, g.boat_sandbox_id, g.config, g.created_at`;
const SANDBOX_COLUMNS = `s.id, s.boat_id, s.golden_id, s.org_id, s.owner_id, s.harness::text as harness,
  s.status::text as status, s.conversation_ids, s.created_at, s.stopped_at, s.deleted_at, s.status_reason,
  g.name as golden, g.visibility::text as visibility`;
/** `$1` is the caller's orgs and `$2` the caller. */
const GOLDEN_VISIBLE = `g.org_id = any($1::uuid[]) and (g.visibility = 'org' or g.owner_id = $2::uuid)`;
const SANDBOX_VISIBLE = `s.org_id = g.org_id and ${GOLDEN_VISIBLE}`;

interface GoldenRow {
  id: string;
  org_id: string;
  name: string;
  visibility: string;
  owner_id: string;
  boat_snapshot_id: string | null;
  boat_sandbox_id: string | null;
  config: unknown;
  created_at: string | Date;
}

type SandboxViewRow = SandboxRow & { golden: string; visibility: string };

export class DataError extends Error {
  override readonly name = "DataError";
}

export function createSqlData(sql: Sql): DataSource {
  return (caller) => {
    const orgIds = caller.orgs.map((org) => org.orgId);
    const scope = [orgIds, caller.userId];
    const ownOrg = (orgId: string) => {
      if (!orgIds.includes(orgId)) throw new GoldenError("not_found", "No such golden.");
    };
    const readOnly = (): never => {
      throw new GoldenError("forbidden", "Goldens are created and snapshotted with the armada CLI.");
    };

    const goldens: GoldenStore = {
      async list(orgId) {
        ownOrg(orgId);
        const result = await sql.query<GoldenRow>(
          `select ${GOLDEN_COLUMNS} from public.goldens g where ${GOLDEN_VISIBLE} and g.org_id = $3::uuid
           order by g.name, g.visibility`,
          [...scope, orgId],
        );
        return result.rows.map(mapGolden);
      },
      async findByName(orgId, name) {
        ownOrg(orgId);
        const result = await sql.query<GoldenRow>(
          `select ${GOLDEN_COLUMNS} from public.goldens g where ${GOLDEN_VISIBLE} and g.org_id = $3::uuid
             and g.name = $4 order by g.visibility`,
          [...scope, orgId, name],
        );
        return result.rows.map(mapGolden);
      },
      insert: readOnly,
      setConfig: readOnly,
      setSandbox: readOnly,
      setSnapshot: readOnly,
    };

    const sandboxes: ServerSandboxStore = {
      async insert(input) {
        if (!orgIds.includes(input.orgId) || input.ownerId !== caller.userId) {
          throw new DataError("A sandbox is recorded for its caller only.");
        }
        const result = await sql.query<SandboxViewRow>(
          `with visible as (select g.id from public.goldens g where ${GOLDEN_VISIBLE} and g.id = $3 and g.org_id = $8::uuid)
           insert into public.sandboxes (id, boat_id, golden_id, org_id, owner_id, harness, status)
           select $4::uuid, $5::text, visible.id, $8::uuid, $2::uuid, $6::public.harness, $7::public.sandbox_status from visible
           returning id, boat_id, golden_id, org_id, owner_id, harness::text as harness, status::text as status,
             conversation_ids, created_at, stopped_at, deleted_at, status_reason`,
          [...scope, input.goldenId, input.id, input.boatId, input.harness, input.status, input.orgId],
        );
        const row = result.rows[0];
        if (!row) throw new DataError("The sandbox could not be recorded.");
        return mapSandboxRow(row);
      },
      async update(id, patch) {
        const sets: string[] = [];
        const params: unknown[] = [...scope, id];
        const set = (column: string, value: unknown, cast: string) => {
          params.push(value);
          sets.push(`${column} = $${params.length}${cast}`);
        };
        if (patch.status !== undefined) set("status", patch.status, "::public.sandbox_status");
        if (patch.conversationIds !== undefined) set("conversation_ids", patch.conversationIds, "::text[]");
        if (patch.stoppedAt !== undefined) set("stopped_at", patch.stoppedAt, "::timestamptz");
        if (patch.deletedAt !== undefined) set("deleted_at", patch.deletedAt, "::timestamptz");
        const reason = statusReasonOf(patch);
        if (reason !== undefined) set("status_reason", reason, "::text");
        if (sets.length === 0) return;
        const result = await sql.query<{ id: string }>(
          `update public.sandboxes s set ${sets.join(", ")} from public.goldens g
           where s.id = $3 and g.id = s.golden_id and ${SANDBOX_VISIBLE} returning s.id`,
          params,
        );
        if (!result.rows[0]) throw new DataError("The sandbox could not be updated.");
      },
      async listBefore(cutoff) {
        const result = await sql.query<SandboxViewRow>(
          `select ${SANDBOX_COLUMNS} from public.sandboxes s join public.goldens g on g.id = s.golden_id
           where ${SANDBOX_VISIBLE} and s.created_at < $3::timestamptz and s.status <> 'deleted'
           order by s.created_at`,
          [...scope, cutoff],
        );
        return result.rows.map(mapView);
      },
      async get(id) {
        if (!UUID.test(id)) return null;
        const result = await sql.query<SandboxViewRow>(
          `select ${SANDBOX_COLUMNS} from public.sandboxes s join public.goldens g on g.id = s.golden_id
           where ${SANDBOX_VISIBLE} and s.id = $3`,
          [...scope, id],
        );
        const row = result.rows[0];
        return row ? mapView(row) : null;
      },
      async list(filter) {
        const statuses = filter.statuses && filter.statuses.length > 0 ? [...filter.statuses] : null;
        const result = await sql.query<SandboxViewRow>(
          `select ${SANDBOX_COLUMNS} from public.sandboxes s join public.goldens g on g.id = s.golden_id
           where ${SANDBOX_VISIBLE} and ($3::text[] is null or s.status::text = any($3::text[]))
           order by s.created_at desc, s.id
           limit $4`,
          [...scope, statuses, filter.limit],
        );
        return result.rows.map(mapView);
      },
    };

    return { goldens, sandboxes };
  };
}

function mapView(row: SandboxViewRow): SandboxView {
  return { ...mapSandboxRow(row), golden: row.golden, visibility: visibility(row.visibility) };
}

function mapGolden(row: GoldenRow): GoldenRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    visibility: visibility(row.visibility),
    ownerId: row.owner_id,
    boatSnapshotId: row.boat_snapshot_id,
    boatSandboxId: row.boat_sandbox_id,
    config: parseGoldenConfig(row.config),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function visibility(value: string): Visibility {
  if (value !== "org" && value !== "private") throw new DataError("A golden row has an unknown visibility.");
  return value;
}
