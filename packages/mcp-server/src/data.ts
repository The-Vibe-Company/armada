import {
  createSqlSandboxStore,
  GoldenError,
  type GoldenRow,
  type GoldenStore,
  type Harness,
  type ModalBinding,
  mapGoldenRow,
  mapSandboxRow,
  type SandboxListMetadata,
  type SandboxRecord,
  type SandboxRow,
  type SandboxStatus,
  type SandboxStore,
  type SandboxUsage,
  type Sql,
  statusReasonOf,
  type TaskOutcome,
  type Visibility,
  withUsageTotals,
} from "@armada/core";
import type { Provider } from "@armada/core/server";
import { assertGoldenBackendBinding, assertSqlGoldenMutation } from "@armada/core/server";
import { beginGoldenOperation, reconcileGoldenOperations } from "../../core/src/golden-store.ts";
import type { Caller } from "./caller.ts";
import { createResourceStore, type ResourceStore } from "./resource-store.ts";
import { preserveBeforeStop, readWorkRecovery } from "./work-preservation.ts";

/** A sandbox with what the caller needs to know about its golden. */
export interface SandboxView extends SandboxRecord {
  golden: string;
  /** Provider management credentials follow the source golden, never independent sandbox access visibility. */
  sourceGoldenVisibility: Visibility;
  visibility: Visibility;
  /** The golden's pinned Modal App, on a Modal sandbox. Routing reaches the sandbox through it. */
  modal: ModalBinding | null;
}

export interface ServerSandboxStore extends SandboxStore {
  assertExtensionAllowed?(id: string): Promise<void>;
  assertDeletionAllowed?(id: string): Promise<void>;
  /** Admission-only read: ordinary exec stays concurrent, but cannot start during stop. */
  assertExecAllowed?(id: string): Promise<void>;
  recordUsage?(id: string, usage: Pick<SandboxUsage, "turnCount" | "turns">): Promise<void>;
  preserveWork?(id: string, provider: Provider, providerId: string): Promise<"pending" | void>;
  readWorkRecovery?(id: string, recoveryId?: string): Promise<string | null>;
  reportTaskOutcome?(id: string, promptId: string, outcome: TaskOutcome, expectedGeneration?: number): Promise<void>;
  /** Null when it does not exist or the caller may not see it: the two are not told apart. */
  get(id: string): Promise<SandboxView | null>;
  /** Newest first. */
  list(filter: {
    statuses?: readonly SandboxStatus[];
    harness?: Harness;
    goldenId?: string;
    ownerId?: string;
    limit: number;
    page?: number;
  }): Promise<{ rows: SandboxListMetadata[]; total: number }>;
}

/**
 * What one caller may read and change. The server's database connection is privileged, so row level
 * security does not apply to it: every query here carries the same rule itself. The caller's orgs only,
 * and private goldens only for their owner. Sandbox metadata is org-visible; interior is owner/admin.
 */
export interface ScopedData {
  resourceObservations?: ResourceStore;
  goldens: GoldenStore;
  sandboxes: ServerSandboxStore;
  removeGolden?(id: string): Promise<{ id: string; removedAt: string; artifacts: "retained" }>;
  setGoldenVisibility?(id: string, visibility: Visibility): Promise<void>;
}

export type DataSource = (caller: Caller) => ScopedData;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GOLDEN_COLUMNS = `g.id, g.org_id, g.name, g.visibility::text as visibility, g.owner_id,
  g.provider::text as provider, g.provider_sandbox_id, g.provider_snapshot_id, g.modal_workspace,
  g.modal_environment, g.modal_app_id, g.config, g.size_policy, g.build_warnings, g.helper_receipt, g.created_at`;
const SANDBOX_COLUMNS = `public.sandbox_usage(s) as usage, s.preservation_note, s.task_outcome, s.task_prompt_id, s.credential_id, s.credential_version, s.id, s.provider::text as provider, s.provider_sandbox_id, s.golden_id, s.org_id, s.owner_id, s.harness::text as harness,
  s.status::text as status, s.conversation_ids, s.created_at, s.stopped_at, s.deleted_at, s.status_reason,
  s.skills,s.expires_at,s.effective_ttl_seconds,s.requested_ttl_seconds,s.last_observed_at,s.lifecycle_error,s.lifecycle_generation,s.stop_requested_at,s.model, s.reasoning_effort, s.machine_size,s.resource_project, s.repository_dir, g.name as golden, s.visibility::text as visibility, s.access_owner_id,
  s.source_golden_visibility::text as source_golden_visibility, g.modal_workspace,
  g.modal_environment, g.modal_app_id`;
/** `$1` is the caller's orgs and `$2` the caller. */
const GOLDEN_VISIBLE = `g.org_id = any($1::uuid[]) and (g.visibility = 'org' or g.owner_id = $2::uuid)
  and exists(select 1 from public.members m where m.org_id=g.org_id and m.user_id=$2::uuid)`;
const SANDBOX_MEMBER = `not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)
  and s.org_id=any($1::uuid[]) and exists(select 1 from public.members m
  where m.org_id=s.org_id and m.user_id=$2::uuid)`;
const SANDBOX_VISIBLE = `${SANDBOX_MEMBER} and exists(select 1 from public.members m
  where m.org_id=s.org_id and m.user_id=$2::uuid and (s.owner_id=$2::uuid or m.role='admin'))`;
const SANDBOX_LIST_COLUMNS = `case when (s.owner_id=$2::uuid or exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$2::uuid and m.role='admin')) then public.sandbox_usage(s) else null end as usage, s.preservation_note as "preservationNote", nullif(s.provider_sandbox_id,'') as "providerSandboxId",
  case when s.provider='boat' then nullif(s.provider_sandbox_id,'') else null end as "boatId", s.id, s.org_id as "orgId", s.owner_id as "ownerId",
  s.provider::text as provider, s.harness::text as harness, s.model, s.reasoning_effort as "reasoningEffort",
  s.status::text as status, s.created_at as "createdAt", s.stopped_at as "stoppedAt", s.expires_at as "expiresAt",
  s.effective_ttl_seconds as "effectiveTtlSeconds",
  case when s.machine_size->>'effective' in ('small','medium','large','xlarge') then s.machine_size->>'effective' else null end as "machineSize",
  'Sandbox ' || s.id::text as "displayLabel",
  case when (s.owner_id=$2::uuid or exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$2::uuid and m.role='admin')) then s.task_outcome else null end as "taskOutcome",
  (s.owner_id=$2::uuid or exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$2::uuid and m.role='admin')) as "canOpen",
  (s.owner_id=$2::uuid or exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$2::uuid and m.role='admin')) as "canManage"`;

type SandboxViewRow = SandboxRow & {
  golden: string;
  visibility: string;
  source_golden_visibility: string;
  access_owner_id: string;
  modal_workspace?: string | null;
  modal_environment?: string | null;
  modal_app_id?: string | null;
};

export class DataError extends Error {
  override readonly name = "DataError";
  constructor(
    message: string,
    readonly code: "unavailable" | "sandbox_not_ready" = "unavailable",
  ) {
    super(message);
  }
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
      const alias = column === "provider_sandbox_id" ? "boat_sandbox_id" : "boat_snapshot_id";
      const firstMaster = column === "provider_sandbox_id" ? " and provider_sandbox_id is null" : "";
      const result = await sql.query<{ id: string }>(
        `update public.goldens set ${column} = $1, ${alias} = case when provider = 'boat' then $1 else null end
         where id = $2::uuid and org_id = any($3::uuid[])${firstMaster}
         and exists (select 1 from public.members m where m.org_id = goldens.org_id and m.user_id = $4::uuid
           and (goldens.visibility = 'private' or m.role = 'admin'))
         and ((visibility = 'private' and owner_id = $4::uuid) or (visibility = 'org' and org_id = any($5::uuid[]))) returning id`,
        [value, id, orgIds, caller.userId, admins],
      );
      if (!result.rows.length) throw new GoldenError("forbidden", "You cannot change this golden.");
    };
    const goldens: GoldenStore = {
      async setSizePolicy(golden, actor, policy) {
        if (actor.userId !== caller.userId) throw new GoldenError("forbidden", "Caller mismatch.");
        const result = await sql.query(
          `update public.goldens g set size_policy=$4::text::jsonb where ${GOLDEN_VISIBLE}
           and g.id=$3::uuid and g.removed_at is null
           and not exists(select 1 from jsonb_object_keys(($4::text::jsonb)->'repositories') k
             where not exists(select 1 from jsonb_array_elements(g.config->'repos') r where r->>'dir'=k))
           and exists(
             select 1 from public.members m where m.org_id=g.org_id and m.user_id=$2::uuid
             and ((g.visibility='private' and g.owner_id=$2::uuid) or (g.visibility='org' and m.role='admin')))
           returning g.id`,
          [...scope, golden.id, JSON.stringify(policy)],
        );
        if (!result.rows.length) throw new GoldenError("forbidden", "You cannot change this golden's size policy.");
      },
      reconcileOperations: (golden, actor) => reconcileGoldenOperations(sql, golden, actor),
      beginOperation: (id, expected) => beginGoldenOperation(sql, id, expected),
      assertBackendBinding: (golden, provider) => assertGoldenBackendBinding(sql, golden, provider),
      async assertMutation(golden, actor) {
        if (actor.userId !== caller.userId || !orgIds.includes(golden.orgId))
          throw new GoldenError("forbidden", "This caller cannot mutate the golden.");
        await assertSqlGoldenMutation(sql, golden, actor);
      },
      async list(orgId) {
        ownOrg(orgId);
        const result = await sql.query<GoldenRow>(
          `select ${GOLDEN_COLUMNS} from public.goldens g where ${GOLDEN_VISIBLE} and g.removed_at is null and g.org_id = $3::uuid
           order by g.name, g.visibility`,
          [...scope, orgId],
        );
        return result.rows.map(mapGoldenRow);
      },
      async findByName(orgId, name) {
        ownOrg(orgId);
        const result = await sql.query<GoldenRow>(
          `select ${GOLDEN_COLUMNS} from public.goldens g where ${GOLDEN_VISIBLE} and g.removed_at is null and g.org_id = $3::uuid
             and g.name = $4 order by g.visibility`,
          [...scope, orgId, name],
        );
        return result.rows.map(mapGoldenRow);
      },
      async compareAndSetSnapshot(id, expectedSnapshot, replacement, expectedSandbox) {
        const result = await sql.query(
          `update public.goldens g set provider_snapshot_id=$5,provider_sandbox_id=null
           where ${GOLDEN_VISIBLE} and g.id=$3 and g.provider='modal'
           and ((g.provider_snapshot_id is not distinct from $4 and g.provider_sandbox_id=$6)
             or (g.provider_snapshot_id=$5 and g.provider_sandbox_id is null))
           and exists(select 1 from public.members m where m.org_id=g.org_id and m.user_id=$2
             and ((g.visibility='private' and g.owner_id=$2) or (g.visibility='org' and m.role='admin')))
           returning g.id`,
          [...scope, id, expectedSnapshot, replacement, expectedSandbox],
        );
        return result.rows.length === 1;
      },
      insert: readOnly,
      setConfig: readOnly,
      setSandbox: (id, value) => writeGolden(id, "provider_sandbox_id", value),
      async replaceSandbox(id, expectedSandbox, expectedSnapshot, replacement) {
        const result = await sql.query<{ id: string }>(
          `update public.goldens g set provider_sandbox_id = $6, boat_sandbox_id = case when g.provider = 'boat' then $6 else null end
           where ${GOLDEN_VISIBLE} and g.id = $3::uuid and g.provider_sandbox_id is not distinct from $4 and g.provider_snapshot_id is not distinct from $5
             and exists (select 1 from public.members m where m.org_id = g.org_id and m.user_id = $2::uuid and (g.visibility = 'private' or m.role = 'admin'))
             and ((g.visibility = 'private' and g.owner_id = $2::uuid) or (g.visibility = 'org' and g.org_id = any($7::uuid[]))) returning g.id`,
          [
            ...scope,
            id,
            expectedSandbox,
            expectedSnapshot,
            replacement,
            caller.orgs.filter((o) => o.role === "admin").map((o) => o.orgId),
          ],
        );
        return result.rows.length === 1;
      },
      setSnapshot: (id, value) => writeGolden(id, "provider_snapshot_id", value),
      async recordSnapshot(id, expectedSandbox, snapshot) {
        const result = await sql.query<{ id: string }>(
          `update public.goldens g set provider_snapshot_id = $5, boat_snapshot_id = case when g.provider = 'boat' then $5 else null end where ${GOLDEN_VISIBLE}
           and g.id = $3::uuid and g.provider_sandbox_id is not distinct from $4
           and exists (select 1 from public.members m where m.org_id = g.org_id and m.user_id = $2::uuid and
             ((g.visibility = 'private' and g.owner_id = $2::uuid) or (g.visibility = 'org' and m.role = 'admin'))) returning g.id`,
          [...scope, id, expectedSandbox, snapshot],
        );
        return result.rows.length === 1;
      },
    };

    const sandboxes: ServerSandboxStore = {
      activityOwnership: true,
      async recordUsagePricingContext(id, context) {
        if (!(await sandboxes.get(id))) throw new DataError("No such sandbox.");
        await createSqlSandboxStore(sql, { turnModels: true }).recordUsagePricingContext!(id, context);
      },
      async recordTurnModel(id, promptId, requestedModel) {
        if (!(await sandboxes.get(id))) throw new DataError("No such sandbox.");
        await createSqlSandboxStore(sql, { turnModels: true }).recordTurnModel!(id, promptId, requestedModel);
      },
      async readTurnModel(id, promptId) {
        if (!(await sandboxes.get(id))) throw new DataError("No such sandbox.");
        return createSqlSandboxStore(sql, { turnModels: true }).readTurnModel!(id, promptId);
      },
      async recordTurnModelEvidence(id, promptId, evidence) {
        if (!(await sandboxes.get(id))) throw new DataError("No such sandbox.");
        await createSqlSandboxStore(sql, { turnModels: true }).recordTurnModelEvidence!(id, promptId, evidence);
      },
      async recordSkills(id, skills) {
        const result = await sql.query(
          "update public.sandboxes s set skills=$3::text::jsonb where s.id=$1::uuid and s.owner_id=$2::uuid returning id",
          [id, caller.userId, JSON.stringify(skills)],
        );
        if (result.rows.length !== 1) throw new DataError("Skill receipts could not be recorded.");
      },
      async insert(input) {
        if (!orgIds.includes(input.orgId) || input.ownerId !== caller.userId) {
          throw new DataError("A sandbox is recorded for its caller only.");
        }
        const result = await sql.query<SandboxViewRow>(
          `with visible as (select g.id,g.visibility from public.goldens g where ${GOLDEN_VISIBLE} and g.id = $3 and g.org_id = $8::uuid)
           insert into public.sandboxes (id, provider_sandbox_id, golden_id, org_id, owner_id, harness, status, model,
             reasoning_effort, provider, visibility, access_owner_id, repository_dir, requested_ttl_seconds, effective_ttl_seconds, expires_at, activity_lease_id, activity_until, credential_id, credential_version, machine_size, resource_project)
           select $4::uuid, $5::text, visible.id, $8::uuid, $2::uuid, $6::public.harness, $7::public.sandbox_status,
             $9::text, $10::text, $11::public.sandbox_provider,case when $21::text='private' then 'private'::public.visibility else visible.visibility end,$2::uuid,$12::text,$13::integer,$14::integer,coalesce($20::timestamptz,now()+$14 * interval '1 second'),$15::uuid,case when $15::uuid is not null then now()+interval '2 minutes' else null end,$16::uuid,$17::integer,$18::text::jsonb,$19::text::jsonb from visible
           returning credential_id, credential_version, id, provider::text as provider, provider_sandbox_id, golden_id, org_id, owner_id, harness::text as harness, status::text as status,
             conversation_ids, created_at, stopped_at, deleted_at, status_reason, model, reasoning_effort,machine_size,resource_project,repository_dir,expires_at,effective_ttl_seconds,requested_ttl_seconds,last_observed_at,lifecycle_error,lifecycle_generation,visibility::text as visibility,access_owner_id,source_golden_visibility::text as source_golden_visibility`,
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
            input.repositoryDir ?? null,
            input.requestedTtlSeconds ?? null,
            input.effectiveTtlSeconds ?? 14400,
            input.activityLeaseId ?? null,
            input.credentialId ?? null,
            input.credentialVersion ?? null,
            JSON.stringify(input.machineSize ?? null),
            JSON.stringify(input.resourceProject ?? null),
            input.expiresAt ?? null,
            input.visibility ?? null,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new DataError("The sandbox could not be recorded.");
        return mapSandboxRow(row);
      },
      async assertExtensionAllowed(id) {
        if (!UUID.test(id)) throw new GoldenError("not_found", "Sandbox not found.");
        const row = (
          await sql.query<{ allowed: boolean }>(
            `select exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$2::uuid
             and (s.owner_id=$2::uuid or m.role='admin')) as allowed
           from public.sandboxes s where ${SANDBOX_MEMBER} and s.id=$3::uuid`,
            [...scope, id],
          )
        ).rows[0];
        if (!row) throw new GoldenError("not_found", "Sandbox not found.");
        if (!row.allowed) throw new GoldenError("forbidden", "You are not allowed to extend this sandbox.");
      },
      async assertDeletionAllowed(id) {
        if (!UUID.test(id)) throw new GoldenError("not_found", "No such sandbox.");
        const row = (
          await sql.query<{ status: string; managed: boolean }>(
            `select s.status::text as status,
             (exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)
              or exists(select 1 from public.orchestrator_children c where c.sandbox_id=s.id)) as managed
           from public.sandboxes s where s.id=$3::uuid and s.org_id=any($1::uuid[])
           and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$2::uuid
             and (s.owner_id=$2::uuid or m.role='admin'))`,
            [...scope, id],
          )
        ).rows[0];
        if (!row) throw new GoldenError("not_found", "No such sandbox or deletion access denied.");
        if (row.managed)
          throw new GoldenError("conflict", "Managed orchestrator parents and children have their own lifecycle.");
        if (!["stopped", "failed", "deleted"].includes(row.status))
          throw new GoldenError("conflict", "Stop the sandbox before deleting it.");
      },
      async recordUsage(id, usage) {
        await sql.query(
          `update public.sandboxes s set usage_turns=(
            with snapshots as (
              select value, ordinality as ordinal
              from jsonb_array_elements(coalesce(s.usage_turns->'turns','[]'::jsonb) ||
                coalesce(($4::text::jsonb)->'turns','[]'::jsonb)) with ordinality
            ), merged as (
              select distinct on (value->>'promptId', value->>'model')
                value || jsonb_strip_nulls(jsonb_build_object(
                  'unavailableReason', first_value(value->'unavailableReason') over diagnostic,
                  'inputTokens', max((value->>'inputTokens')::bigint) over identity,
                  'outputTokens', max((value->>'outputTokens')::bigint) over identity,
                  'cachedTokens', max((value->>'cachedTokens')::bigint) over identity,
                  'cacheWriteTokens', max((value->>'cacheWriteTokens')::bigint) over identity,
                  'reasoningTokens', max((value->>'reasoningTokens')::bigint) over identity)) as value
              from snapshots
              window identity as (partition by value->>'promptId', value->>'model'),
                diagnostic as (partition by value->>'promptId', value->>'model' order by
                  case when jsonb_typeof(value->'unavailableReason')='object' then
                    case when value#>>'{unavailableReason,code}' in ('compute_inactive','reader_unavailable') then 1 else 0 end
                    else 2 end, ordinal desc)
              order by value->>'promptId', value->>'model', ordinal desc
            ), retained as (
              select case when m.value->>'inputTokens' is not null or m.value->>'outputTokens' is not null
                or m.value->>'cachedTokens' is not null or m.value->>'cacheWriteTokens' is not null
                or m.value->>'reasoningTokens' is not null then value - 'unavailableReason' else value end as value
              from merged m where m.value->>'model' is not null
                or m.value->>'inputTokens' is not null or m.value->>'outputTokens' is not null
                or m.value->>'cachedTokens' is not null or m.value->>'cacheWriteTokens' is not null
                or m.value->>'reasoningTokens' is not null
                or not exists (select 1 from merged known
                  where known.value->>'promptId'=m.value->>'promptId' and known.value->>'model' is not null
                    and (known.value->>'inputTokens' is not null or known.value->>'outputTokens' is not null
                      or known.value->>'cachedTokens' is not null or known.value->>'cacheWriteTokens' is not null
                      or known.value->>'reasoningTokens' is not null))
            )
            select jsonb_build_object(
              'turnCount', greatest((s.usage_turns->>'turnCount')::int,
                (($4::text::jsonb)->>'turnCount')::int,
                (select nullif(count(distinct value->>'promptId'),0)::int from retained)),
              'turns', coalesce((select jsonb_agg(value order by value->>'promptId', value->>'model') from retained),'[]'::jsonb))
          )
          where ${SANDBOX_VISIBLE} and s.id=$3::uuid
            -- Managed parents use their durable journal as the sole usage writer.
            and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)`,
          [...scope, id, JSON.stringify(usage)],
        );
      },
      async assertExecAllowed(id) {
        const row = (
          await sql.query<{ stop_requested_at: unknown; application_secret_tainted: boolean }>(
            `select s.stop_requested_at,s.application_secret_tainted from public.sandboxes s join public.goldens g on g.id=s.golden_id
           where ${SANDBOX_VISIBLE} and s.id=$3::uuid`,
            [...scope, id],
          )
        ).rows[0];
        if (!row) throw new DataError("No such sandbox.");
        // Refuse all exec, not a racy provider-state sample: Boat commands can
        // restore retained disks without invoking the prompt resume hooks.
        if (row.application_secret_tainted)
          throw new DataError(
            "Application-secret exposed sandboxes cannot execute commands or restore retained disks.",
          );
        if (row.stop_requested_at !== null)
          throw new DataError(
            "Sandbox is stopping; wait for stop or send explicit new work before exec.",
            "sandbox_not_ready",
          );
      },
      async preserveWork(id, provider, providerId) {
        if (!(await sandboxes.get(id))) throw new DataError("No such sandbox.");
        return preserveBeforeStop(sql, provider, id, providerId, "user_stop");
      },
      async readWorkRecovery(id, recoveryId) {
        if (!(await sandboxes.get(id))) throw new DataError("No such sandbox.");
        return readWorkRecovery(sql, id, recoveryId);
      },
      async update(id, patch) {
        const sets: string[] = [];
        const params: unknown[] = [...scope, id];
        const set = (column: string, value: unknown, cast: string) => {
          params.push(value);
          sets.push(`${column} = $${params.length}${cast}`);
        };
        if (patch.advanceGeneration && patch.activityToken) {
          set("activity_lease_id", patch.activityToken, "::uuid");
          sets.push("activity_until = now() + interval '2 minutes'");
        }
        if (patch.rearmDeadline) sets.push("expires_at = now() + s.effective_ttl_seconds * interval '1 second'");
        if (patch.stopRequested !== undefined) {
          // Retries of an in-flight stop share one epoch; send/resume clears it.
          sets.push(
            patch.stopRequested
              ? "stop_requested_at = coalesce(s.stop_requested_at, clock_timestamp())"
              : "stop_requested_at = null",
          );
          if (patch.stopRequested)
            sets.push(
              "reconcile_after = now()",
              "stop_generation = case when s.stop_requested_at is null then s.stop_generation + 1 else s.stop_generation end",
            );
        }
        if (patch.renewActivity) sets.push("activity_until = now() + interval '2 minutes'");
        if (patch.finishActivity && patch.expectedGeneration !== undefined && patch.activityToken)
          sets.push(
            "activity_lease_id = null",
            "activity_until = null",
            "lifecycle_generation = s.lifecycle_generation + 1",
          );
        if (patch.advanceGeneration && !patch.renewLifecycle)
          sets.push("lifecycle_generation = s.lifecycle_generation + 1");
        if (patch.renewLifecycle) {
          sets.push(
            "lifecycle_generation = s.lifecycle_generation + 1",
            "expires_at = now() + s.effective_ttl_seconds * interval '1 second'",
            "reconcile_after = now()",
            "lifecycle_error = null",
          );
        }
        if (patch.usageRuntimeUnknown) sets.push("usage_runtime_seconds = null", "usage_running_since = null");
        if (patch.clearTaskOutcome) sets.push("task_outcome = null", "task_prompt_id = null");
        if (patch.taskPromptId !== undefined) set("task_prompt_id", patch.taskPromptId, "::text");
        if (patch.status !== undefined) set("status", patch.status, "::public.sandbox_status");
        if (patch.conversationIds !== undefined) set("conversation_ids", patch.conversationIds, "::text[]");
        if (patch.stoppedAt !== undefined) set("stopped_at", patch.stoppedAt, "::timestamptz");
        if (patch.deletedAt !== undefined) set("deleted_at", patch.deletedAt, "::timestamptz");
        if (patch.status === "deleted") sets.push("preservation_note = null");
        if (patch.expiresAt !== undefined) set("expires_at", patch.expiresAt, "::timestamptz");
        if (patch.effectiveTtlSeconds !== undefined)
          set("effective_ttl_seconds", patch.effectiveTtlSeconds, "::integer");
        const reason = statusReasonOf(patch);
        if (reason !== undefined) set("status_reason", reason, "::text");
        if (sets.length === 0) return;
        let fence = "";
        // Only an explicit send/resume may cancel an in-flight stop. Other
        // workspace operations must not mutate data covered by its receipt.
        if (
          patch.advanceGeneration &&
          patch.activityToken &&
          patch.stopRequested === undefined &&
          !patch.deleteRequested
        )
          fence += " and s.stop_requested_at is null";
        if (patch.expectedGeneration !== undefined) {
          params.push(patch.expectedGeneration);
          fence += ` and s.lifecycle_generation = $${params.length}`;
        }
        if (patch.deleteRequested)
          fence += ` and s.status in ('stopped','failed')
            and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)
            and not exists(select 1 from public.orchestrator_children c where c.sandbox_id=s.id)`;
        const ownsActivity = !!patch.activityToken && (patch.finishActivity || patch.renewActivity);
        if (ownsActivity) {
          params.push(patch.activityToken);
          fence += ` and s.activity_lease_id = $${params.length}::uuid`;
        }
        const result = await sql.query<{ id: string }>(
          `${patch.status === "deleted" ? "with updated as (" : ""}update public.sandboxes s set ${sets.join(", ")} from public.goldens g
           where s.id = $3 and g.id = s.golden_id and ${SANDBOX_VISIBLE}
             and (${ownsActivity && patch.expectedGeneration !== undefined ? "true" : "(s.reconcile_lease_until is null or s.reconcile_lease_until < now()) and (s.activity_until is null or s.activity_until < now())"}) ${fence} returning s.id${patch.status === "deleted" ? "), purged as (delete from public.sandbox_work_recovery r using updated u where r.sandbox_id=u.id) select id from updated" : ""}`,
          params,
        );
        if (!result.rows[0])
          throw new DataError(
            "The sandbox is busy or its lifecycle changed; retry after refreshing status.",
            "sandbox_not_ready",
          );
      },
      async reportTaskOutcome(id, promptId, outcome, expectedGeneration) {
        const result = await sql.query(
          `update public.sandboxes s set task_outcome=$5::text::jsonb
           where ${SANDBOX_VISIBLE} and s.id=$3::uuid and s.task_prompt_id=$4::text
           and ($6::bigint is null or s.lifecycle_generation=$6::bigint)
           and (s.activity_until is null or s.activity_until < now())
           and s.status not in ('starting','running','deleted')
           returning s.id`,
          [...scope, id, promptId, JSON.stringify(outcome), expectedGeneration ?? null],
        );
        if (!result.rows.length) throw new DataError("The turn changed or this sandbox is not reportable.");
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
        const statuses = filter.statuses?.length ? [...filter.statuses] : null;
        const result = await sql.query<(SandboxListMetadata & { total: number }) | { id: null; total: number }>(
          `with matched as (
             select ${SANDBOX_LIST_COLUMNS} from public.sandboxes s
             where ${SANDBOX_MEMBER}
               and (($3::text[] is null and s.status <> 'deleted') or s.status::text = any($3::text[]))
               and ($4::text is null or s.harness::text = $4)
               and ($5::uuid is null or s.golden_id = $5 and exists(select 1 from public.goldens g where g.id=s.golden_id
                 and g.org_id=s.org_id and g.removed_at is null and (g.visibility='org' or g.owner_id=$2::uuid)))
               and ($6::uuid is null or s.owner_id = $6)
           ) select p.*, totals.total from (select count(*)::int as total from matched) totals
             left join (select * from matched order by "createdAt" desc, id limit $7 offset $8) p on true
             order by p."createdAt" desc, p.id`,
          [
            ...scope,
            statuses,
            filter.harness ?? null,
            filter.goldenId ?? null,
            filter.ownerId ?? null,
            filter.limit,
            ((filter.page ?? 1) - 1) * filter.limit,
          ],
        );
        const page = result.rows[0];
        if (!page) throw new DataError("The sandbox page could not be read.");
        return {
          rows: result.rows
            .filter((row): row is SandboxListMetadata & { total: number } => row.id !== null)
            .map(({ total: _total, ...row }) => ({
              ...row,
              usage: withUsageTotals(row.usage),
              createdAt: new Date(row.createdAt).toISOString(),
              stoppedAt: row.stoppedAt === null ? null : new Date(row.stoppedAt).toISOString(),
              expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt).toISOString(),
            })),
          total: page.total,
        };
      },
    };

    return {
      resourceObservations: createResourceStore(sql, caller),
      goldens,
      sandboxes,
      async removeGolden(id) {
        if (!UUID.test(id)) throw new GoldenError("not_found", "No such golden.");
        const visible = await sql.query<{ id: string }>(
          `select g.id from public.goldens g where ${GOLDEN_VISIBLE} and g.id=$3::uuid`,
          [...scope, id],
        );
        if (!visible.rows.length) throw new GoldenError("not_found", "No such golden.");
        if (!sql.transaction) throw new GoldenError("conflict", "Removal requires a transaction.");
        try {
          const removedAt = await sql.transaction(async (tx) => {
            await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [caller.userId]);
            const result = await tx.query<{ removed_at: string | Date }>(
              "select public.remove_golden($1::uuid) as removed_at",
              [id],
            );
            return result.rows[0]!.removed_at;
          });
          return { id, removedAt: new Date(removedAt).toISOString(), artifacts: "retained" };
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === "P0002") throw new GoldenError("not_found", "No such golden.");
          if (code === "42501") throw new GoldenError("forbidden", "Only an org admin can remove this golden.");
          throw new GoldenError("conflict", "Golden removal is blocked by unresolved operations.");
        }
      },
      async setGoldenVisibility(id, visibility) {
        const visible = await sql.query<{ id: string }>(
          `select g.id from public.goldens g where ${GOLDEN_VISIBLE} and g.id = $3::uuid`,
          [...scope, id],
        );
        if (!visible.rows.length) throw new GoldenError("not_found", "No such golden.");
        if (!sql.transaction)
          throw new GoldenError("conflict", "Visibility requires a transactional database connection.");
        try {
          await sql.transaction(async (tx) => {
            await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [caller.userId]);
            await tx.query("select public.set_golden_visibility($1::uuid, $2::public.visibility)", [id, visibility]);
          });
        } catch (error) {
          const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
          if (code === "P0002") throw new GoldenError("not_found", "No such golden.");
          if (code === "42501") throw new GoldenError("forbidden", "Only an org admin can share a golden.");
          if (code === "23514") throw new GoldenError("conflict", "Other members still have sandboxes of this golden.");
          throw error;
        }
      },
    };
  };
}

function mapView(row: SandboxViewRow): SandboxView {
  return {
    ...mapSandboxRow(row),
    golden: row.golden,
    visibility: visibility(row.visibility),
    sourceGoldenVisibility: visibility(row.source_golden_visibility),
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
