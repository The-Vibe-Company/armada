import {
  GoldenError,
  type GoldenRow,
  type GoldenStore,
  type ModalBinding,
  mapGoldenRow,
  mapSandboxRow,
  type SandboxRecord,
  type SandboxRow,
  type SandboxStatus,
  type SandboxStore,
  type Sql,
  statusReasonOf,
  type Visibility,
} from "@armada/core";
import { assertGoldenBackendBinding } from "@armada/core/server";
import type { Caller } from "./caller.ts";

/** A sandbox with what the caller needs to know about its golden. */
export interface SandboxView extends SandboxRecord {
  golden: string;
  visibility: Visibility;
  /** The golden's pinned Modal App, on a Modal sandbox. Routing reaches the sandbox through it. */
  modal: ModalBinding | null;
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
  setGoldenVisibility?(id: string, visibility: Visibility): Promise<void>;
}

export type DataSource = (caller: Caller) => ScopedData;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GOLDEN_COLUMNS = `g.id, g.org_id, g.name, g.visibility::text as visibility, g.owner_id,
  g.provider::text as provider, g.provider_sandbox_id, g.provider_snapshot_id, g.modal_workspace,
  g.modal_environment, g.modal_app_id, g.config, g.created_at`;
const SANDBOX_COLUMNS = `s.id, s.provider::text as provider, s.provider_sandbox_id, s.golden_id, s.org_id, s.owner_id, s.harness::text as harness,
  s.status::text as status, s.conversation_ids, s.created_at, s.stopped_at, s.deleted_at, s.status_reason,
  s.model, s.reasoning_effort, g.name as golden, g.visibility::text as visibility, g.modal_workspace,
  g.modal_environment, g.modal_app_id`;
/** `$1` is the caller's orgs and `$2` the caller. */
const GOLDEN_VISIBLE = `g.org_id = any($1::uuid[]) and (g.visibility = 'org' or g.owner_id = $2::uuid)`;
const SANDBOX_VISIBLE = `s.org_id = g.org_id and ${GOLDEN_VISIBLE}`;

type SandboxViewRow = SandboxRow & {
  golden: string;
  visibility: string;
  modal_workspace?: string | null;
  modal_environment?: string | null;
  modal_app_id?: string | null;
};

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

    const writeGolden = async (id: string, column: "provider_sandbox_id" | "provider_snapshot_id", value: string) => {
      const admins = caller.orgs.filter((org) => org.role === "admin").map((org) => org.orgId);
      const result = await sql.query<{ id: string }>(
        `update public.goldens set ${column} = $1 where id = $2::uuid and org_id = any($3::uuid[])
         and ((visibility = 'private' and owner_id = $4::uuid) or (visibility = 'org' and org_id = any($5::uuid[]))) returning id`,
        [value, id, orgIds, caller.userId, admins],
      );
      if (!result.rows.length) throw new GoldenError("forbidden", "You cannot change this golden.");
    };
    const goldens: GoldenStore = {
      assertBackendBinding: (golden, provider) => assertGoldenBackendBinding(sql, golden, provider),
      async list(orgId) {
        ownOrg(orgId);
        const result = await sql.query<GoldenRow>(
          `select ${GOLDEN_COLUMNS} from public.goldens g where ${GOLDEN_VISIBLE} and g.org_id = $3::uuid
           order by g.name, g.visibility`,
          [...scope, orgId],
        );
        return result.rows.map(mapGoldenRow);
      },
      async findByName(orgId, name) {
        ownOrg(orgId);
        const result = await sql.query<GoldenRow>(
          `select ${GOLDEN_COLUMNS} from public.goldens g where ${GOLDEN_VISIBLE} and g.org_id = $3::uuid
             and g.name = $4 order by g.visibility`,
          [...scope, orgId, name],
        );
        return result.rows.map(mapGoldenRow);
      },
      insert: readOnly,
      setConfig: readOnly,
      setSandbox: (id, value) => writeGolden(id, "provider_sandbox_id", value),
      setSnapshot: (id, value) => writeGolden(id, "provider_snapshot_id", value),
    };

    const sandboxes: ServerSandboxStore = {
      async insert(input) {
        if (!orgIds.includes(input.orgId) || input.ownerId !== caller.userId) {
          throw new DataError("A sandbox is recorded for its caller only.");
        }
        const result = await sql.query<SandboxViewRow>(
          `with visible as (select g.id from public.goldens g where ${GOLDEN_VISIBLE} and g.id = $3 and g.org_id = $8::uuid)
           insert into public.sandboxes (id, provider_sandbox_id, golden_id, org_id, owner_id, harness, status, model,
             reasoning_effort, provider)
           select $4::uuid, $5::text, visible.id, $8::uuid, $2::uuid, $6::public.harness, $7::public.sandbox_status,
             $9::text, $10::text, $11::public.sandbox_provider from visible
           returning id, provider::text as provider, provider_sandbox_id, golden_id, org_id, owner_id, harness::text as harness, status::text as status,
             conversation_ids, created_at, stopped_at, deleted_at, status_reason, model, reasoning_effort`,
          [
            ...scope,
            input.goldenId,
            input.id,
            input.providerSandboxId,
            input.harness,
            input.status,
            input.orgId,
            input.model,
            input.reasoningEffort,
            input.provider,
          ],
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

    return {
      goldens,
      sandboxes,
      async setGoldenVisibility(id, visibility) {
        const visible = await sql.query<{ id: string }>(
          `select g.id from public.goldens g where ${GOLDEN_VISIBLE} and g.id = $3::uuid`,
          [...scope, id],
        );
        if (!visible.rows.length) throw new GoldenError("not_found", "No such golden.");
        if (!sql.transaction)
          throw new GoldenError("conflict", "Visibility requires a transactional database connection.");
        await sql.transaction(async (tx) => {
          await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [caller.userId]);
          await tx.query("select public.set_golden_visibility($1::uuid, $2::public.visibility)", [id, visibility]);
        });
      },
    };
  };
}

function mapView(row: SandboxViewRow): SandboxView {
  return {
    ...mapSandboxRow(row),
    golden: row.golden,
    visibility: visibility(row.visibility),
    modal:
      row.provider === "modal" && row.modal_workspace && row.modal_environment && row.modal_app_id
        ? { workspace: row.modal_workspace, environment: row.modal_environment, appId: row.modal_app_id }
        : null,
  };
}

function visibility(value: string): Visibility {
  if (value !== "org" && value !== "private") throw new DataError("A golden row has an unknown visibility.");
  return value;
}
