import {
  createSqlSandboxStore,
  GoldenError,
  type GoldenRow,
  type GoldenStore,
  type Harness,
  type LaunchTiming,
  type ModalBinding,
  mapGoldenRow,
  mapSandboxRow,
  type OrgSummary,
  recordLaunchStageSql,
  resolveOrg,
  type SandboxListMetadata,
  type SandboxRecord,
  type SandboxRow,
  type SandboxStatus,
  type SandboxStore,
  type SandboxUsage,
  type Sql,
  sandboxRowModalBinding,
  statusReasonOf,
  summarizeLaunch,
  type TaskOutcome,
  type TurnPriceContext,
  type TurnTokenUsage,
  VaultError,
  type VaultStore,
  type Visibility,
  withUsageTotals,
} from "@armada/core";
import type { Provider } from "@armada/core/server";
import { assertGoldenBackendBinding, assertSqlGoldenMutation } from "@armada/core/server";
import { beginGoldenOperation, reconcileGoldenOperations } from "../../core/src/golden-store.ts";
import type { Caller } from "./caller.ts";
import { scopedOrg } from "./control-caller.ts";
import { createResourceStore, type ResourceStore } from "./resource-store.ts";
import { admittedTurnContexts, stampTurnPricing, withServerCost } from "./turn-pricing.ts";
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
  /** Persist an accepted native receipt even if stop fences later task publication. */
  recordNativePrompt?(id: string, providerSandboxId: string, promptId: string, requestId?: string): Promise<void>;
  /** Persist an accepted native steer whose run is not yet provable, so native
   * lifecycle reconciliation registers the run once it appears. */
  recordPendingSteer?(id: string, providerSandboxId: string, priorPromptId: string | null): Promise<void>;
  controlState?(
    id: string,
  ): Promise<Pick<
    SandboxView,
    | "provider"
    | "status"
    | "statusReason"
    | "expiresAt"
    | "boatRuntime"
    | "runtimeTransport"
    | "preservationNote"
    | "credentialId"
  > | null>;
  recordAccountRateLimit?(id: string, promptId: string, retryAt: number | null): Promise<void>;
  /** #2560: latest activation's recorded launch stages, for a visible sandbox; null before any. */
  launchTiming?(id: string): Promise<LaunchTiming | null>;
  assertExtensionAllowed?(id: string): Promise<void>;
  assertDeletionAllowed?(id: string): Promise<void>;
  /** Admission-only read: ordinary exec stays concurrent, but cannot start during stop. */
  assertExecAllowed?(id: string): Promise<void>;
  recordUsage?(
    id: string,
    usage: Pick<SandboxUsage, "turnCount" | "turns">,
    options?: {
      /** Fresh native snapshots only, not retained/server-merged rows. */
      observations: readonly TurnTokenUsage[];
      /** Trusted service admission contexts, never guest monetary output. */
      contexts?: readonly TurnPriceContext[];
    },
  ): Promise<void>;
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
    /** Interior-only: matches sandboxes the caller owns or administers. */
    externalRef?: string;
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
  g.modal_environment, g.modal_app_id, g.config, g.size_policy, g.build_warnings, g.helper_receipt, g.baseline_version, g.created_at`;
// Include admitted prompts even before their native usage is collected; never show a stale subtotal as complete.
const SANDBOX_USAGE = `(public.sandbox_usage(s) || jsonb_build_object('turnCount',
  greatest((s.usage_turns->>'turnCount')::int, (select nullif(count(distinct prompt_id),0)::int from (
    select prompt_id from public.sandbox_turn_models where sandbox_id=s.id
    union select value->>'promptId' from jsonb_array_elements(coalesce(s.usage_turns->'turns','[]'::jsonb))
  ) admitted_prompts))))`;
const SANDBOX_COLUMNS = `${SANDBOX_USAGE} as usage, s.runtime_transport,s.boat_runtime, s.preservation_note, s.pull_requests, s.task_outcome, s.task_prompt_id, s.credential_id, s.credential_version, s.id, s.provider::text as provider, s.provider_sandbox_id, s.golden_id, s.org_id, s.owner_id, s.harness::text as harness,
  s.status::text as status, s.conversation_ids, s.created_at, s.stopped_at, s.deleted_at, s.status_reason,
  s.skills,s.expires_at,s.effective_ttl_seconds,s.requested_ttl_seconds,s.last_observed_at,s.lifecycle_error,s.lifecycle_generation,s.stop_requested_at,s.model, s.reasoning_effort, s.machine_size,s.resource_project, s.repository_dir, g.name as golden, s.visibility::text as visibility, s.access_owner_id,
  s.source_golden_visibility::text as source_golden_visibility, g.modal_workspace,
  g.modal_environment, g.modal_app_id, s.external_ref`;
/** `$1` is the caller's orgs and `$2` the caller. */
const GOLDEN_VISIBLE = `g.org_id = any($1::uuid[]) and (g.visibility = 'org' or g.owner_id = $2::uuid)
  and exists(select 1 from public.members m where m.org_id=g.org_id and m.user_id=$2::uuid)`;
const SANDBOX_MEMBER = `not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)
  and s.org_id=any($1::uuid[]) and exists(select 1 from public.members m
  where m.org_id=s.org_id and m.user_id=$2::uuid)`;
const SANDBOX_VISIBLE = `${SANDBOX_MEMBER} and exists(select 1 from public.members m
  where m.org_id=s.org_id and m.user_id=$2::uuid and (s.owner_id=$2::uuid or m.role='admin'))`;
// Ordinary delegated children retain their relation, but permanent parent deletion
// fences their authority before owner/admin cleanup. Legacy orchestrators keep
// their dedicated lifecycle. Share the policy between authorization and admission.
const SANDBOX_DELETION_MANAGED = `(exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)
  or exists(select 1 from public.orchestrator_children c where c.sandbox_id=s.id
    and not exists(select 1 from public.armada_access_parents p
      join public.sandboxes parent on parent.id=p.sandbox_id
      where p.id=c.orchestrator_id and p.org_id=c.org_id and p.owner_id=c.owner_id
        and p.kind='sandbox' and parent.status='deleted')))`;
const SANDBOX_INTERIOR = `(s.owner_id=$2::uuid or exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$2::uuid and m.role='admin'))`;
const SANDBOX_LIST_COLUMNS = `case when (s.owner_id=$2::uuid or exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$2::uuid and m.role='admin')) then ${SANDBOX_USAGE} else null end as usage, s.preservation_note as "preservationNote", nullif(s.provider_sandbox_id,'') as "providerSandboxId",
  case when s.provider='boat' then nullif(s.provider_sandbox_id,'') else null end as "boatId", s.id, s.org_id as "orgId", s.owner_id as "ownerId",
  s.provider::text as provider, s.harness::text as harness, s.model, s.reasoning_effort as "reasoningEffort",
  coalesce(s.status='stopped' and s.status_reason='idle_paused',false) as "idlePaused", s.status::text as status, s.created_at as "createdAt", s.stopped_at as "stoppedAt", s.expires_at as "expiresAt",
  s.effective_ttl_seconds as "effectiveTtlSeconds",
  case when s.machine_size->>'effective' in ('small','medium','large','xlarge') then s.machine_size->>'effective' else null end as "machineSize",
  'Sandbox ' || s.id::text as "displayLabel",
  case when (s.owner_id=$2::uuid or exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$2::uuid and m.role='admin')) then s.task_outcome else null end as "taskOutcome",
  case when ${SANDBOX_INTERIOR} then s.pull_requests else null end as "pullRequests",
  case when ${SANDBOX_INTERIOR} then s.external_ref else null end as "externalRef",
  (s.owner_id=$2::uuid or exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$2::uuid and m.role='admin')) as "canOpen",
  (s.owner_id=$2::uuid or exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$2::uuid and m.role='admin')) as "canManage"`;

// Interior-only filter: a metadata-only org viewer cannot probe another member's external reference.
const sandboxListMatch = (externalRef: number) => `${SANDBOX_MEMBER}
               and ($${externalRef}::text is null or (s.external_ref = $${externalRef}::text and ${SANDBOX_INTERIOR}))
               and ($9::uuid is null or s.org_id=$9::uuid)
               and (($3::text[] is null and s.status <> 'deleted') or s.status::text = any($3::text[]))
               and ($4::text is null or s.harness::text = $4)
               and ($5::uuid is null or s.golden_id = $5 and exists(select 1 from public.goldens g where g.id=s.golden_id
                 and g.org_id=s.org_id and g.removed_at is null and (g.visibility='org' or g.owner_id=$2::uuid)))
               and ($6::uuid is null or s.owner_id = $6)`;

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
    readonly code: "unavailable" | "sandbox_not_ready" | "not_found" | "invalid" = "unavailable",
  ) {
    super(message);
  }
}

export function createSqlData(
  sql: Sql,
  listOrgId?: string,
  namedList?: { ref: string; store: VaultStore },
): DataSource {
  return (caller) => {
    const orgIds = caller.orgs.map((org) => org.orgId);
    const scope: [string[], string] = [orgIds, caller.userId];
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
      async launchTiming(id) {
        const rows = await sql.query<{ activation: string; stage: string; at: string }>(
          `select st.activation::text as activation,st.stage,to_json(st.at)#>>'{}' as at from public.sandbox_launch_stages st
           join public.sandboxes s on s.id=st.sandbox_id
           where ${SANDBOX_VISIBLE} and s.id=$3::uuid
           and st.activation=(select max(l.activation) from public.sandbox_launch_stages l where l.sandbox_id=s.id)`,
          [...scope, id],
        );
        return summarizeLaunch(rows.rows);
      },
      async recordUsagePricingContext(id, context) {
        if (!(await sandboxes.get(id))) throw new DataError("No such sandbox.");
        await createSqlSandboxStore(sql, { turnModels: true }).recordUsagePricingContext!(id, context);
      },
      async captureUsagePricingContext(id) {
        const visible = await sql.query(
          `select s.id from public.sandboxes s where ${SANDBOX_VISIBLE} and s.id=$3::uuid`,
          [...scope, id],
        );
        if (!visible.rows.length) throw new DataError("No such sandbox.");
        return createSqlSandboxStore(sql, { turnModels: true }).captureUsagePricingContext!(id);
      },
      async recordTurnModel(id, promptId, requestedModel, pricingContext) {
        const visible = await sql.query(
          `select s.id from public.sandboxes s where ${SANDBOX_VISIBLE} and s.id=$3::uuid`,
          [...scope, id],
        );
        if (!visible.rows.length) throw new DataError("No such sandbox.");
        await createSqlSandboxStore(sql, { turnModels: true }).recordTurnModel!(
          id,
          promptId,
          requestedModel,
          pricingContext,
        );
        // Usage may arrive before the accepted RPC receipt. Reconcile that already stored observation
        // after its authoritative pre-work context is captured, without changing any existing quote.
        const rows = await sql.query<{ usage: Pick<SandboxUsage, "turnCount" | "turns"> | null }>(
          `select s.usage_turns as usage from public.sandboxes s where ${SANDBOX_VISIBLE} and s.id=$3::uuid`,
          [...scope, id],
        );
        const usage = rows.rows[0]?.usage;
        const pending = usage?.turns.filter((turn) => turn.promptId === promptId && !turn.pricing) ?? [];
        if (usage && pending.length) await sandboxes.recordUsage!(id, usage, { observations: pending });
      },
      async recordAccountRateLimit(id, promptId, retryAt) {
        if (!(await sandboxes.get(id))) throw new DataError("No such sandbox.");
        await sql.query(
          `update public.sandbox_turn_models set rate_limit_retry_at=$3::timestamptz where sandbox_id=$1::uuid and prompt_id=$2`,
          [id, promptId, retryAt === null ? null : new Date(retryAt).toISOString()],
        );
      },
      async readTurnModel(id, promptId) {
        if (!(await sandboxes.get(id))) throw new DataError("No such sandbox.");
        return createSqlSandboxStore(sql, { turnModels: true }).readTurnModel!(id, promptId);
      },
      async recordTurnModelEvidence(id, promptId, evidence) {
        if (!(await sandboxes.get(id))) throw new DataError("No such sandbox.");
        await createSqlSandboxStore(sql, { turnModels: true }).recordTurnModelEvidence!(id, promptId, evidence);
      },
      async recordLaunchStage(id, stage, elapsedMs) {
        // Server measurement of the caller's own launch: the same owner fence as its skill receipts.
        const owned = await sql.query("select 1 from public.sandboxes where id=$1::uuid and owner_id=$2::uuid", [
          id,
          caller.userId,
        ]);
        if (owned.rows.length) await recordLaunchStageSql(sql, id, stage, elapsedMs);
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
             reasoning_effort, provider, visibility, access_owner_id, repository_dir, requested_ttl_seconds, effective_ttl_seconds, expires_at, activity_lease_id, activity_until, credential_id, credential_version, machine_size, resource_project, boat_runtime, runtime_transport, external_ref, stop_when_work_merged, pull_request_source)
           select $4::uuid, $5::text, visible.id, $8::uuid, $2::uuid, $6::public.harness, $7::public.sandbox_status,
             $9::text, $10::text, $11::public.sandbox_provider,case when $21::text='private' then 'private'::public.visibility else visible.visibility end,$2::uuid,$12::text,$13::integer,$14::integer,coalesce($20::timestamptz,now()+$14 * interval '1 second'),$15::uuid,case when $15::uuid is not null then now()+interval '2 minutes' else null end,$16::uuid,$17::integer,$18::text::jsonb,$19::text::jsonb, $22::boolean,$23::text,$24::text,$25::boolean,$26::text::jsonb from visible
           returning runtime_transport,boat_runtime, credential_id, credential_version, id, provider::text as provider, provider_sandbox_id, golden_id, org_id, owner_id, harness::text as harness, status::text as status,
             conversation_ids, created_at, stopped_at, deleted_at, status_reason, model, reasoning_effort,machine_size,resource_project,repository_dir,expires_at,effective_ttl_seconds,requested_ttl_seconds,last_observed_at,lifecycle_error,lifecycle_generation,visibility::text as visibility,access_owner_id,source_golden_visibility::text as source_golden_visibility,external_ref`,
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
            input.boatRuntime === true,
            input.runtimeTransport ?? null,
            input.externalRef ?? null,
            input.stopWhenWorkMerged ?? true,
            JSON.stringify(input.pullRequestSource ?? null),
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
             ${SANDBOX_DELETION_MANAGED} as managed
           from public.sandboxes s where s.id=$3::uuid and s.org_id=any($1::uuid[])
           and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$2::uuid
             and (s.owner_id=$2::uuid or m.role='admin'))`,
            [...scope, id],
          )
        ).rows[0];
        if (!row) throw new GoldenError("not_found", "No such sandbox or deletion access denied.");
        if (row.managed)
          throw new GoldenError(
            "conflict",
            "Managed orchestrators have their own lifecycle; delete an ordinary delegated parent before its child.",
          );
        if (!["stopped", "failed", "deleted"].includes(row.status))
          throw new GoldenError("conflict", "Stop the sandbox before deleting it.");
      },
      async recordUsage(id, usage, options) {
        const mergeNative = async (target: Sql, unpriced: boolean) =>
          target.query<{ usage: Pick<SandboxUsage, "turnCount" | "turns"> }>(
            `update public.sandboxes s set usage_turns=(
            with snapshots as (
              select value, ordinality as ordinal
              from jsonb_array_elements(coalesce(s.usage_turns->'turns','[]'::jsonb) ||
                coalesce(($4::text::jsonb)->'turns','[]'::jsonb)) with ordinality
            ), lifetime_snapshots as (
              select *,
                bool_or(value ? 'cacheWriteTokensByTtl') over identity as has_ttl,
                bool_or(value#>'{cacheWriteTokensByTtl,conflicted}'='true'::jsonb) over identity as ttl_conflicted,
                max((value#>>'{cacheWriteTokensByTtl,fiveMinute}')::bigint) over identity as ttl_five,
                max((value#>>'{cacheWriteTokensByTtl,oneHour}')::bigint) over identity as ttl_hour,
                max((value->>'cacheWriteTokens')::bigint) over identity as ttl_total
              from snapshots
              window identity as (partition by value->>'promptId', value->>'model')
            ), merged as (
              select distinct on (value->>'promptId', value->>'model')
                value || jsonb_strip_nulls(jsonb_build_object(
                  'unavailableReason', first_value(value->'unavailableReason') over diagnostic,
                  'inputTokens', max((value->>'inputTokens')::bigint) over identity,
                  'outputTokens', max((value->>'outputTokens')::bigint) over identity,
                  'cachedTokens', max((value->>'cachedTokens')::bigint) over identity,
                  'cacheWriteTokens', max((value->>'cacheWriteTokens')::bigint) over identity,
                  'reasoningTokens', max((value->>'reasoningTokens')::bigint) over identity)) ||
                  -- Keep monotone lifetime subsets across stale writers, without inventing a
                  -- coherent breakdown when conflicting snapshots exceed the aggregate.
                  -- A conflict is sticky: ordinary replays carry no authoritative reset/order proof.
                  case when has_ttl then jsonb_build_object('cacheWriteTokensByTtl',
                    case when ttl_conflicted or
                        (ttl_total is not null and coalesce(ttl_five,0)+coalesce(ttl_hour,0)>ttl_total)
                      then jsonb_build_object('fiveMinute',null,'oneHour',null,'conflicted',true)
                      else jsonb_build_object('fiveMinute',ttl_five,'oneHour',ttl_hour) end)
                    else '{}'::jsonb end as value
              from lifetime_snapshots
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
                (select nullif(count(distinct prompt_id),0)::int from (
                  select prompt_id from public.sandbox_turn_models where sandbox_id=s.id
                  union select value->>'promptId' from retained
                ) admitted_prompts)),
              'turns', coalesce((select jsonb_agg(value order by value->>'promptId', value->>'model') from retained),'[]'::jsonb))
          )
          where ${SANDBOX_VISIBLE} and s.id=$3::uuid
            -- Managed parents use their durable journal as the sole usage writer.
            and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)
            ${
              unpriced
                ? `and not exists(select 1 from jsonb_array_elements(coalesce(s.usage_turns->'turns','[]'::jsonb)) r
              where jsonb_typeof(r->'pricing')='object')`
                : ""
            }
            returning s.usage_turns as usage`,
            [
              ...scope,
              id,
              JSON.stringify({
                ...usage,
                turns: usage.turns.map(({ pricing: _ignored, ...native }) => ({
                  ...native,
                  ...(unpriced ? { pricing: null } : {}),
                })),
              }),
            ],
          );
        // Legacy adapters record unpriced telemetry only. Never erase a frozen context or
        // leave a stale known amount beside updated counters without a transaction.
        if (!sql.transaction) {
          await mergeNative(sql, true);
          return;
        }
        await sql.transaction(async (tx) => {
          const prior = await tx.query<{
            usage: Pick<SandboxUsage, "turnCount" | "turns"> | null;
            harness: Harness;
            admission: unknown;
            rebound: boolean;
          }>(
            `select s.usage_turns as usage,s.harness::text as harness,
               (select p.context from public.sandbox_usage_pricing p where p.sandbox_id=s.id) as admission,
               exists(select 1 from public.sandbox_account_usage_pricing a where a.sandbox_id=s.id) as rebound
             from public.sandboxes s where ${SANDBOX_VISIBLE} and s.id=$3::uuid for update`,
            [...scope, id],
          );
          const before = prior.rows[0];
          if (!before) return;
          const merged = (await mergeNative(tx, false)).rows[0]?.usage;
          if (!merged) return;
          const observations = options?.observations ?? [];
          let contexts = options?.contexts;
          if (contexts === undefined && observations.length) {
            const admissions = await tx.query<{ prompt_id: string; context: unknown; captured: boolean }>(
              `select prompt_id,pricing_context as context,pricing_context is not null as captured
               from public.sandbox_turn_models where sandbox_id=$1 and prompt_id=any($2::text[])`,
              [id, observations.map((row) => row.promptId)],
            );
            const byPrompt = new Map(admissions.rows.map((row) => [row.prompt_id, row]));
            contexts = observations.flatMap((row) => {
              const captured = byPrompt.get(row.promptId);
              // Legacy turns retain the launch book. Missing provenance after a switch is unknown,
              // never an excuse to bill the old turn against the new account (or vice versa).
              const book = captured
                ? captured.captured
                  ? captured.context
                  : before.admission
                : before.rebound
                  ? null
                  : before.admission;
              return admittedTurnContexts(book, [row], before.harness);
            });
          }
          const priced = {
            ...merged,
            turns: stampTurnPricing(
              merged.turns,
              before.usage?.turns ?? [],
              observations,
              contexts ?? [],
              before.harness,
            ),
          };
          const saved = await tx.query<{ id: string }>(
            `update public.sandboxes s set usage_turns=$4::text::jsonb
             where ${SANDBOX_VISIBLE} and s.id=$3::uuid returning s.id`,
            [...scope, id, JSON.stringify(priced)],
          );
          if (saved.rows.length !== 1) throw new DataError("Usage admission changed during recording.");
        });
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
        const selected = await sandboxes.get(id);
        if (!selected) throw new DataError("No such sandbox.");
        return preserveBeforeStop(sql, provider, id, providerId, "user_stop");
      },
      async readWorkRecovery(id, recoveryId) {
        if (!(await sandboxes.get(id))) throw new DataError("No such sandbox.");
        return readWorkRecovery(sql, id, recoveryId);
      },
      async recordNativePrompt(id, providerSandboxId, promptId, requestId) {
        await sql.query(
          `with accepted as (
            select s.* from public.sandboxes s join public.goldens g on g.id=s.golden_id
            where s.id=$3 and ${SANDBOX_VISIBLE} and s.provider_sandbox_id=$4
              and s.provider in ('boat','modal') and not s.boat_runtime
              and s.runtime_transport is distinct from 'dialout'
          ), aliased as (
            update public.account_turn_queue q set native_prompt_id=coalesce(q.native_prompt_id,$5)
            from accepted s where q.sandbox_id=s.id and q.request_id=$6::uuid
              and q.owner_id=s.owner_id and q.org_id=s.org_id
          ) insert into public.native_webhook_prompts(sandbox_id,prompt_id,provider,provider_sandbox_id,owner_id,org_id)
            select id,$5,provider,provider_sandbox_id,owner_id,org_id from accepted on conflict do nothing`,
          [...scope, id, providerSandboxId, promptId, requestId ?? null],
        );
      },
      async recordPendingSteer(id, providerSandboxId, priorPromptId) {
        // A still-pending cursor is older than any later concrete run, so keep it:
        // reconciliation registers everything after it and duplicates are no-ops.
        // Each accepted steer adds one unresolved replacement; the cursor stays
        // pending until every one of them has its own registered run, even after downtime.
        await sql.query(
          `insert into public.native_steer_cursors(sandbox_id,after_prompt_id,steer_id,pending_since,pending_steers)
          select s.id,$5,gen_random_uuid(),clock_timestamp(),1 from public.sandboxes s
            join public.goldens g on g.id=s.golden_id
            where s.id=$3 and ${SANDBOX_VISIBLE} and s.provider_sandbox_id=$4
              and s.provider in ('boat','modal') and not s.boat_runtime
              and s.runtime_transport is distinct from 'dialout'
          on conflict(sandbox_id) do update set
            after_prompt_id=case when native_steer_cursors.pending_since is not null
              then coalesce(native_steer_cursors.after_prompt_id,excluded.after_prompt_id)
              else coalesce(excluded.after_prompt_id,native_steer_cursors.after_prompt_id) end,
            pending_steers=case when native_steer_cursors.pending_since is not null
              then native_steer_cursors.pending_steers+1 else 1 end,
            steer_id=excluded.steer_id,pending_since=coalesce(native_steer_cursors.pending_since,excluded.pending_since)`,
          [...scope, id, providerSandboxId, priorPromptId || null],
        );
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
        if (patch.status !== undefined) {
          set("status", patch.status, "::public.sandbox_status");
          sets.push(`transition_context = case when s.provider in ('boat','modal')
            then jsonb_build_object('actor','api','code','sandbox_' || ($${params.length}::public.sandbox_status)::text) end`);
        }
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
        if (patch.advanceGeneration && patch.activityToken && patch.stopRequested === false)
          fence +=
            " and (coalesce(s.status_reason,'') not in ('idle_paused','work_merged') or (s.status<>'stopping' and s.expires_at>clock_timestamp()))";
        if (patch.queueRequestId !== undefined) {
          params.push(patch.queueRequestId);
          fence += ` and not exists(select 1 from public.account_turn_queue q where q.sandbox_id=s.id and q.request_id=$${params.length}::uuid and q.state<>'dispatching')`;
        }
        let generationParam: number | undefined;
        if (patch.expectedGeneration !== undefined) {
          params.push(patch.expectedGeneration);
          generationParam = params.length;
          fence += ` and s.lifecycle_generation = $${params.length}`;
        }
        if (patch.deleteRequested)
          fence += ` and s.status in ('stopped','failed')
            and not ${SANDBOX_DELETION_MANAGED}`;
        // A read-only reconciler may overlap list readiness. Admission can supersede
        // that observation, but never a claimed stop or an expired/starting sandbox.
        // The generation CAS also fences its stop-claim and late publication.
        const supersedeObservation =
          patch.advanceGeneration && patch.activityToken && patch.expectedGeneration !== undefined;
        const observationFence = supersedeObservation
          ? "(s.reconcile_lease_until is null or s.reconcile_lease_until < now() or (s.status in ('ready','running') and s.stop_requested_at is null and s.expires_at > clock_timestamp()))"
          : "(s.reconcile_lease_until is null or s.reconcile_lease_until < now())";
        if (supersedeObservation) sets.push("reconcile_lease = null", "reconcile_lease_until = null");
        const ownsActivity = !!patch.activityToken && (patch.finishActivity || patch.renewActivity);
        if (ownsActivity) {
          params.push(patch.activityToken);
          fence += ` and s.activity_lease_id = $${params.length}::uuid`;
        }
        // Once a prompt identity is durable, its turn evidence owns capacity rather
        // than the pre-dispatch reservation. Transfer ownership in the same SQL
        // statement so there is never an uncounted admission window.
        const releaseReservation =
          patch.taskPromptId !== undefined ||
          (patch.stoppedAt !== undefined && patch.stoppedAt !== null) ||
          patch.status === "deleted";
        const cancelTurns = patch.stopRequested === true;
        const wrapped = releaseReservation || cancelTurns;
        const admission = !!patch.advanceGeneration && !!patch.activityToken;
        // A refused delete admission names its predicates from the CAS statement's own snapshot,
        // not a later read that a concurrent lease release could already have cleared. A row
        // changed while this statement waited on its lock is rechecked at its newest version,
        // so then the CAS may refuse a holder that this snapshot predates.
        const observeRefusal = !!patch.deleteRequested && admission && !wrapped;
        const update = `update public.sandboxes s set ${sets.join(", ")} from public.goldens g
           where s.id = $3 and g.id = s.golden_id and ${SANDBOX_VISIBLE}
             and (${ownsActivity && patch.expectedGeneration !== undefined ? "true" : `${observationFence} and (s.activity_until is null or s.activity_until < now())`}) ${fence} returning s.id`;
        const result = await sql.query<{ id: string | null; observed?: Record<string, unknown> | null }>(
          observeRefusal
            ? `with observed as (select s.status::text as status,
                  s.activity_lease_id as "activityLeaseId",
                  coalesce(s.activity_until>=now(),false) as "activityLeaseHeld",
                  coalesce(s.reconcile_lease_until>=now(),false) as "reconcileLeaseHeld",
                  s.stop_requested_at is not null as "stopRequested",
                  ${generationParam ? `s.lifecycle_generation<>$${generationParam}::bigint` : "false"} as "generationChanged",
                  ${SANDBOX_DELETION_MANAGED} as managed
                from public.sandboxes s where s.id=$3::uuid and ${SANDBOX_VISIBLE}),
              updated as (${update})
              select (select id from updated) as id, (select row_to_json(o) from observed o) as observed`
            : `${wrapped ? "with updated as (" : ""}${update}${wrapped ? `)${patch.status === "deleted" ? ", purged as (delete from public.sandbox_work_recovery r using updated u where r.sandbox_id=u.id)" : ""}${cancelTurns ? ", refused as (update public.account_turn_queue q set state='failed',failure_reason='Dispatch refused by owner stop.' from updated u where q.sandbox_id=u.id and q.state in ('queued','dispatching'))" : ""}${releaseReservation ? ", released as (delete from public.account_agent_reservations r using updated u where r.sandbox_id=u.id)" : ""} select id from updated` : ""}`,
          params,
        );
        if (!result.rows[0]?.id) {
          // Record only admission predicates. The provider has not received this delete.
          if (observeRefusal)
            console.info(
              JSON.stringify({
                event: "sandbox_delete_admission_refused",
                sandboxId: id,
                observed: result.rows[0]?.observed ?? null,
              }),
            );
          throw new DataError(
            "The sandbox is busy or its lifecycle changed; retry after refreshing status.",
            "sandbox_not_ready",
          );
        }
        // Names the writer behind any later refusal's activityLeaseId. Lease IDs are random
        // fences, not credentials.
        if (admission)
          console.info(
            JSON.stringify({
              event: "sandbox_activity_admitted",
              sandboxId: id,
              activityLeaseId: patch.activityToken,
              kind: patch.deleteRequested
                ? "delete"
                : patch.stopRequested === true
                  ? "stop"
                  : patch.stopRequested === false
                    ? "resume"
                    : "activity",
            }),
          );
      },
      async reportTaskOutcome(id, promptId, outcome, expectedGeneration) {
        const result = await sql.query(
          `update public.sandboxes s set task_outcome=$5::text::jsonb,
             pull_request_reports=(s.pull_request_reports - (s.lifecycle_generation::text || ':' || $4::text)) ||
               case when $5::text::jsonb->>'state'='ready' and ($5::text::jsonb ? 'prNumber' or $5::text::jsonb ? 'prUrl')
                 then jsonb_build_object(s.lifecycle_generation::text || ':' || $4::text, $5::text::jsonb)
                 else '{}'::jsonb end,
             pull_request_merge_proof=null
           where ${SANDBOX_VISIBLE} and s.id=$3::uuid and s.task_prompt_id=$4::text
           and ($6::bigint is null or s.lifecycle_generation=$6::bigint)
           and (s.activity_until is null or s.activity_until < now())
           and s.status not in ('starting','deleted')
           and (s.status<>'running' or (s.provider='docker' and s.stop_requested_at is null
             and exists(select 1 from public.runtime_idle_turns where sandbox_id=s.id and prompt_id=$4 and settled)))
           returning s.id`,
          [...scope, id, promptId, JSON.stringify(outcome), expectedGeneration ?? null],
        );
        if (!result.rows.length) throw new DataError("The turn changed or this sandbox is not reportable.");
      },
      async controlState(id) {
        if (!UUID.test(id)) return null;
        const result = await sql.query<
          Pick<
            SandboxView,
            | "provider"
            | "status"
            | "statusReason"
            | "expiresAt"
            | "boatRuntime"
            | "runtimeTransport"
            | "preservationNote"
            | "credentialId"
          >
        >(
          `select s.credential_id as "credentialId",s.provider,s.status,s.preservation_note as "preservationNote",s.status_reason as "statusReason",s.expires_at as "expiresAt",s.boat_runtime as "boatRuntime",s.runtime_transport as "runtimeTransport"
           from public.sandboxes s where ${SANDBOX_VISIBLE} and s.id=$3`,
          [...scope, id],
        );
        return result.rows[0] ?? null;
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
        if (namedList) return namedSandboxPage(sql, scope, filter, namedList);
        const statuses = filter.statuses?.length ? [...filter.statuses] : null;
        const result = await sql.query<
          | (SandboxListMetadata & { total: number; scope_member: boolean })
          | { id: null; total: number; scope_member: boolean }
        >(
          `with scope_member as (
             select 1 from public.members m join public.orgs o on o.id=m.org_id
             where m.user_id=$2::uuid and m.org_id=$9::uuid
           ), matched as materialized (
             select s.id,s.created_at from public.sandboxes s
             where ${sandboxListMatch(10)}
           ), page as materialized (
             select id from matched order by created_at desc,id limit $7 offset $8
           ) select ${SANDBOX_LIST_COLUMNS}, totals.total,
               ($9::uuid is null or exists(select 1 from scope_member)) as scope_member
             from (select count(*)::int as total from matched) totals
             left join page p on true left join public.sandboxes s on s.id=p.id
             order by s.created_at desc,s.id`,
          [
            ...scope,
            statuses,
            filter.harness ?? null,
            filter.goldenId ?? null,
            filter.ownerId ?? null,
            filter.limit,
            ((filter.page ?? 1) - 1) * filter.limit,
            listOrgId ?? null,
            filter.externalRef ?? null,
          ],
        );
        const page = result.rows[0];
        if (!page) throw new DataError("The sandbox page could not be read.");
        if (listOrgId !== undefined && page.scope_member !== true)
          throw new DataError("You are not a member of that org.", "not_found");
        return {
          rows: result.rows
            .filter((row): row is SandboxListMetadata & { total: number; scope_member: boolean } => row.id !== null)
            .map(({ total: _total, scope_member: _member, ...row }) => sandboxListRow(row)),
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
  const record = mapSandboxRow(row);
  return {
    ...record,
    usage: withServerCost(record.usage ?? null, record.harness),
    golden: row.golden,
    visibility: visibility(row.visibility),
    sourceGoldenVisibility: visibility(row.source_golden_visibility),
    modal: sandboxRowModalBinding(row),
  };
}

function visibility(value: string): Visibility {
  if (value !== "org" && value !== "private") throw new DataError("A golden row has an unknown visibility.");
  return value;
}

/** Server-owned list scope; named refs retain core's exact current-membership resolution. */
export function createScopedSandboxData(sql: Sql, store: VaultStore) {
  return (caller: Caller, ref: string): ScopedData => {
    const bound = scopedOrg(caller, ref)!;
    const wanted = bound.trim().toLowerCase();
    return UUID.test(wanted)
      ? createSqlData(sql, wanted)(caller)
      : createSqlData(sql, undefined, { ref: bound, store })(caller);
  };
}

function sandboxListRow({
  externalRef,
  ...row
}: Omit<SandboxListMetadata, "externalRef"> & { externalRef?: string | null }): SandboxListMetadata {
  return {
    ...row,
    ...(externalRef ? { externalRef } : {}),
    usage: withServerCost(withUsageTotals(row.usage), row.harness),
    createdAt: new Date(row.createdAt).toISOString(),
    stoppedAt: row.stoppedAt === null ? null : new Date(row.stoppedAt).toISOString(),
    expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt).toISOString(),
  };
}

type NamedMembership = {
  selection_id: string;
  selection_name: string;
  selection_role: OrgSummary["role"];
  total: number;
};
type NamedRow = NamedMembership & (SandboxListMetadata | { id: null });
// SQL only narrows ASCII names with exact ASCII trim/C-lower rules; all non-ASCII
// candidates survive for core's final resolution. Page each candidate before reading wide metadata.
async function namedSandboxPage(
  sql: Sql,
  scope: readonly [readonly string[], string],
  filter: Parameters<ServerSandboxStore["list"]>[0],
  named: { ref: string; store: VaultStore },
) {
  const result = await sql.query<NamedRow>(
    `with memberships as materialized (
       select o.id as selection_id,o.name as selection_name,m.role::text as selection_role
       from public.members m join public.orgs o on o.id=m.org_id where m.user_id=$2::uuid
     ), candidates as (
       select selection_id from memberships
       where ($10::text='' and (select count(*) from memberships)=1)
         or ($10::text<>'' and (length(convert_to(selection_name,'UTF8'))<>length(selection_name)
           or lower(btrim(selection_name,$11::text) collate "C")=$10::text))
     ), matched as materialized (
       select s.id,s.org_id,s.created_at from public.sandboxes s
       where ${sandboxListMatch(12)}
         and exists(select 1 from candidates c where c.selection_id=s.org_id)
     ), ranked as (
       select id,org_id,row_number() over(partition by org_id order by created_at desc,id) as ordinal from matched
     ), pages as (
       select * from ranked where ordinal>$8::bigint and ordinal<=$8::bigint+$7::bigint
     ), totals as (
       select org_id,count(*)::int as total from matched group by org_id
     ) select ${SANDBOX_LIST_COLUMNS},a.selection_id,a.selection_name,a.selection_role,coalesce(t.total,0) as total
       from memberships a left join totals t on t.org_id=a.selection_id
       left join pages p on p.org_id=a.selection_id left join public.sandboxes s on s.id=p.id
       order by lower(a.selection_name),a.selection_id,p.ordinal`,
    [
      ...scope,
      filter.statuses?.length ? [...filter.statuses] : null,
      filter.harness ?? null,
      filter.goldenId ?? null,
      filter.ownerId ?? null,
      filter.limit,
      ((filter.page ?? 1) - 1) * filter.limit,
      null,
      named.ref.trim().toLowerCase(),
      String.fromCharCode(32, 9, 10, 13, 11, 12),
      filter.externalRef ?? null,
    ],
  );
  const orgs = new Map(
    result.rows.map((row) => [
      row.selection_id,
      { id: row.selection_id, name: row.selection_name, role: row.selection_role },
    ]),
  );
  let selected: OrgSummary;
  try {
    selected = await resolveOrg({ ...named.store, memberships: async () => [...orgs.values()] }, scope[1], named.ref);
  } catch (error) {
    if (error instanceof VaultError && (error.code === "invalid" || error.code === "not_found"))
      throw new DataError(error.message, error.code);
    throw error;
  }
  const page = result.rows.filter((row) => row.selection_id === selected.id);
  return {
    total: page[0]?.total ?? 0,
    rows: page
      .filter((row): row is NamedMembership & SandboxListMetadata => row.id !== null)
      .map(({ total: _total, selection_id: _id, selection_name: _name, selection_role: _role, ...row }) =>
        sandboxListRow(row),
      ),
  };
}
