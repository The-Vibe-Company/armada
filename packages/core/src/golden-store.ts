import type { Visibility } from "./contract.ts";
import type { GoldenOperation } from "./golden.ts";
import { assertGoldenMutation, type GoldenActor, type GoldenRecord, type GoldenStore } from "./golden.ts";
import type { GoldenBuildWarning } from "./golden-build-warning.ts";
import { type GoldenConfig, GoldenError, parseGoldenConfig } from "./golden-config.ts";
import type { HelperReceipt } from "./helper.ts";
import { parseMachineSizePolicy } from "./machine-size.ts";
import { isSandboxProvider, type ModalBinding } from "./sandbox-provider.ts";

/** The slice of a database client the golden store needs. Postgres `$1` parameters. */
export interface Sql {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Separate autocommit pool: must not wait for a connection held by transaction(). */
  autonomousQuery?<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs all queries on one transaction/connection. Callback errors are rejected only after
   * rollback acknowledgement; COMMIT/connection errors after a successful callback are ambiguous. */
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
  helper_receipt?: HelperReceipt | null;
  build_warnings?: GoldenBuildWarning[];
  size_policy?: unknown;
  created_at: string | Date;
}

/** The columns {@link mapGoldenRow} reads, as a PostgREST `select=`. */
export const GOLDEN_SELECT =
  "id,org_id,name,visibility,owner_id,provider,provider_sandbox_id,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config,size_policy,build_warnings,helper_receipt,created_at";

const COLUMNS = `id, org_id, name, visibility::text as visibility, owner_id, provider::text as provider,
  provider_sandbox_id, provider_snapshot_id, modal_workspace, modal_environment, modal_app_id, config, size_policy, build_warnings, helper_receipt, created_at`;

/**
 * Goldens through SQL. The connection's role is the caller: row level security hides
 * a private golden from everyone but its owner, and refuses an org write from a member.
 */
export function createSqlGoldenStore(sql: Sql): GoldenStore {
  return {
    reconcileOperations: (golden, actor) => reconcileGoldenOperations(sql, golden, actor),
    beginOperation: (id, expected) => beginGoldenOperation(sql, id, expected),
    assertMutation: (golden, actor) => assertSqlGoldenMutation(sql, golden, actor),
    async list(orgId: string): Promise<GoldenRecord[]> {
      const result = await sql.query<GoldenRow>(
        `select ${COLUMNS} from public.goldens where removed_at is null and org_id = $1 order by name asc, provider asc, visibility asc`,
        [orgId],
      );
      return result.rows.map(mapGoldenRow);
    },

    async findByName(orgId: string, name: string): Promise<GoldenRecord[]> {
      const result = await sql.query<GoldenRow>(
        `select ${COLUMNS} from public.goldens where removed_at is null and org_id = $1 and name = $2 order by provider asc, visibility asc`,
        [orgId, name],
      );
      return result.rows.map(mapGoldenRow);
    },

    // Bind serialized JSON as text before parsing it: Bun's jsonb parameter encoder otherwise
    // serializes an already-stringified value again, producing a JSON string instead of an object.
    async insert(input): Promise<GoldenRecord> {
      try {
        const result = await sql.query<GoldenRow>(
          `insert into public.goldens (org_id, name, visibility, owner_id, provider, modal_workspace,
             modal_environment, modal_app_id, config)
           values ($1, $2, $3::public.visibility, $4, $5::public.sandbox_provider, $6, $7, $8, $9::text::jsonb)
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
        `update public.goldens set config = $2::text::jsonb,
           size_policy = case when size_policy is null then null else
             jsonb_set(size_policy, '{repositories}', coalesce((
               select jsonb_object_agg(p.key,p.value) from jsonb_each(size_policy->'repositories') p
               where exists(select 1 from jsonb_array_elements(($2::text::jsonb)->'repos') r where r->>'dir'=p.key)
             ), '{}'::jsonb)) end where id = $1 and (provider = 'boat' or provider_sandbox_id is null) returning id`,
        [id, JSON.stringify(config)],
      );
    },

    async setSandbox(id: string, boatSandboxId: string): Promise<void> {
      await write(
        sql,
        `update public.goldens set provider_sandbox_id = $2, boat_sandbox_id = case when provider = 'boat' then $2 else null end where id = $1 and provider_sandbox_id is null returning id`,
        [id, boatSandboxId],
      );
    },

    async replaceSandbox(id, expectedSandbox, expectedSnapshot, replacement) {
      const result = await sql.query<{ id: string }>(
        `update public.goldens set provider_sandbox_id = $4, boat_sandbox_id = case when provider = 'boat' then $4 else null end where id = $1 and provider_sandbox_id is not distinct from $2 and provider_snapshot_id = $3 returning id`,
        [id, expectedSandbox, expectedSnapshot, replacement],
      );
      return result.rows.length === 1;
    },
    async compareAndSetSnapshot(id, expected, next, expectedSandbox) {
      const result = await sql.query<{ id: string }>(
        `update public.goldens set provider_snapshot_id=$3,provider_sandbox_id=null,boat_snapshot_id=null,boat_sandbox_id=null
         where id=$1 and provider='modal' and (
           (provider_snapshot_id is not distinct from $2 and provider_sandbox_id=$4)
           or (provider_snapshot_id=$3 and provider_sandbox_id is null)) returning id`,
        [id, expected, next, expectedSandbox],
      );
      return result.rows.length === 1;
    },

    async setSnapshot(id: string, providerSnapshotId: string): Promise<void> {
      await write(
        sql,
        `update public.goldens set provider_snapshot_id = $2, boat_snapshot_id = case when provider='boat' then $2 else null end where id = $1 returning id`,
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
  if (message === "golden config must be a JSON object") {
    return new GoldenError("invalid_config", "Golden config must be a JSON object.");
  }
  if (message.startsWith("golden config must not contain secrets")) {
    return new GoldenError("invalid_config", "Golden config must not contain secrets.");
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
    buildWarnings: row.build_warnings ?? [],
    helperReceipt: row.helper_receipt ?? null,
    sizePolicy:
      row.size_policy == null
        ? null
        : parseMachineSizePolicy(
            row.size_policy,
            parseGoldenConfig(config).repos.map((r) => r.dir),
          ),
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

/** Live membership/role proof, not mere org-golden visibility or a stale caller role. */
export async function assertSqlGoldenMutation(sql: Sql, golden: GoldenRecord, actor: GoldenActor): Promise<void> {
  const result = await sql.query<{ role: "admin" | "member" }>(
    `select m.role from public.members m join public.goldens g on g.org_id=m.org_id
     where g.id=$1 and g.org_id=$2 and m.user_id=$3 and g.owner_id=$4 and g.visibility=$5::public.visibility`,
    [golden.id, actor.orgId, actor.userId, golden.ownerId, golden.visibility],
  );
  const member = result.rows[0];
  if (!member) throw new GoldenError("forbidden", "Current golden mutation authority was revoked or changed.");
  assertGoldenMutation({ ...actor, role: member.role }, golden);
}

/** Admission and removal serialize on the golden row. Never expires on a wall-clock lease. */
export async function beginGoldenOperation(
  sql: Sql,
  id: string,
  expected: { snapshotId: string | null; sandboxId: string | null; kind?: "launch" | "connect" | "snapshot" },
): Promise<GoldenOperation> {
  try {
    const result = await sql.query<{ id: string }>(
      "insert into public.golden_operation_fences(golden_id,expected_snapshot_id,expected_sandbox_id,revision_known,operation_kind) values ($1,$2,$3,true,$4) returning id",
      [id, expected.snapshotId, expected.sandboxId, expected.kind ?? "unknown"],
    );
    const fence = result.rows[0];
    if (!fence) throw new GoldenError("conflict", "Golden operation could not be admitted.");
    const release: GoldenOperation = async () => {
      await sql.query("delete from public.golden_operation_fences where id=$1", [fence.id]);
    };
    release.retain = async (receipt) => {
      await sql.query("update public.golden_operation_fences set receipt=$2::text::jsonb where id=$1", [
        fence.id,
        JSON.stringify(receipt),
      ]);
    };
    return release;
  } catch {
    throw new GoldenError("conflict", "Golden operation could not be admitted.");
  }
}

/** Only a matching canonical readback resolves publication uncertainty; never a lease expiry. */
export async function reconcileGoldenOperations(sql: Sql, golden: GoldenRecord, actor: GoldenActor): Promise<void> {
  await assertSqlGoldenMutation(sql, golden, actor);
  await sql.query(
    `delete from public.golden_operation_fences f using public.goldens g
     where f.golden_id=g.id and g.id=$1 and g.org_id=$2 and g.removed_at is null
       and f.receipt->>'kind' in ('connect','snapshot')
       and f.receipt->>'snapshotId'=g.provider_snapshot_id
       and (f.receipt->>'sandboxId') is not distinct from g.provider_sandbox_id
       and exists(select 1 from public.members m where m.org_id=g.org_id and m.user_id=$3
         and ((g.visibility='private' and g.owner_id=$3) or (g.visibility='org' and m.role='admin')))`,
    [golden.id, actor.orgId, actor.userId],
  );
}
