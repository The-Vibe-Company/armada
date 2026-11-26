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
  type SandboxPatch,
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
import {
  assertGoldenBackendBinding,
  assertSqlGoldenMutation,
  beginSnapshotLaunch,
  failureDiagnostic,
} from "@armada/core/server";
import { beginGoldenOperation, reconcileGoldenOperations } from "../../core/src/golden-store.ts";
import { publishAccountSpend, unmeasuredUsage } from "./account-spend.ts";
import type { Caller } from "./caller.ts";
import { scopedOrg } from "./control-caller.ts";
import { DataError } from "./data-error.ts";
import { createScopedGoldenWrites, GOLDEN_VISIBLE } from "./golden-store.ts";
import { unresolvedModalLaunch } from "./modal-launch-handoff.ts";
import { recordOperatorDiagnostic } from "./request-observability.ts";
import { createResourceStore, type ResourceStore } from "./resource-store.ts";
import {
  RuntimeCheckpointActivityConflict,
  RuntimeReconciliationConflict,
  SandboxStopTargetChanged,
} from "./runtime-reconciliation-conflict.ts";
import {
  applyScopedSandboxPatch,
  completeSandboxDeletion,
  expireAfterExtension,
  mergeSandboxUsage,
  recordObservedProviderState,
  recordSandboxSkills,
  reportSandboxTaskOutcome,
  requestStartingModalStop,
  saveSandboxUsage,
  unresolvedModalStop,
} from "./sandbox-lifecycle.ts";
import { publicSandboxStatusSql } from "./sandbox-readiness.ts";
import { SANDBOX_DELETION_MANAGED, SANDBOX_MEMBER, SANDBOX_VISIBLE } from "./sandbox-visibility.ts";
import { admittedTurnContexts, recordTurnRateLimit, stampTurnPricing, withServerCost } from "./turn-pricing.ts";
import { MODAL_LAUNCH_FAILURE } from "./turns.ts";
import { readWorkRecovery } from "./work-preservation.ts";

/** A sandbox with what the caller needs to know about its golden. */
export interface SandboxView extends SandboxRecord {
  golden: string;
  /** Provider management credentials follow the source golden, never independent sandbox access visibility. */
  sourceGoldenVisibility: Visibility;
  visibility: Visibility;
  /** The golden's pinned Modal App, on a Modal sandbox. Routing reaches the sandbox through it. */
  modal: ModalBinding | null;
}

export interface ServerSandboxPatch extends SandboxPatch {
  deleteCompleted?: true;
  expireAfterExtension?: true;
  ownerStop?: true;
  queueModalStop?: true | string;
  ownerStopSignal?: AbortSignal;
  onlyIfIdle?: boolean;
  retainedRuntimeStop?: string;
  modalRuntimeExtensionTarget?: string;
  providerObservation?: { fromState: SandboxStatus };
  turnActivity?: "claim" | "finish";
}

export interface ServerSandboxStore extends SandboxStore {
  update(id: string, patch: ServerSandboxPatch): Promise<void>;
  controlState?(
    id: string,
  ): Promise<Pick<
    SandboxView,
    | "provider"
    | "status"
    | "statusReason"
    | "expiresAt"
    | "boatRuntime"
    | "modalTransport"
    | "preservationNote"
    | "credentialId"
    | "conversationIds"
  > | null>;
  recordAccountRateLimit?(id: string, promptId: string, retryAt: number | null): Promise<void>;
  /** #2560: latest activation's recorded launch stages, for a visible sandbox; null before any. */
  launchTiming?(id: string): Promise<LaunchTiming | null>;
  assertExtensionAllowed?(id: string): Promise<void>;
  assertDeletionAllowed?(id: string): Promise<void>;
  getForStop?(id: string): Promise<{ sandbox: SandboxView; busy: boolean } | null>;
  requestStartingModalStop?(sandbox: SandboxRecord, signal?: AbortSignal): ReturnType<typeof requestStartingModalStop>;
  /** Refuse taint and stop intent before exec; native Boat exec also claims the activity lease. */
  assertExecAllowed?(id: string): Promise<void>;
  recordUsage?(
    id: string,
    usage: Pick<SandboxUsage, "turnCount" | "turns">,
    options?: {
      /** Fresh native snapshots only, not retained/server-merged rows. */
      observations: readonly TurnTokenUsage[];
      /** Trusted service admission contexts, never guest monetary output. */
      contexts?: readonly TurnPriceContext[];
      completed?: ReadonlyMap<string, string>;
    },
  ): Promise<void>;
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
const SANDBOX_INTERIOR = `(s.owner_id=$2::uuid or exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$2::uuid and m.role='admin'))`;
const SANDBOX_LIST_INTERIOR = `(s.owner_id=$2::uuid or coalesce(lm.role='admin',false))`;
const SANDBOX_LIST_COLUMNS = `case when ${SANDBOX_LIST_INTERIOR} then ${SANDBOX_USAGE} else null end as usage, s.preservation_note as "preservationNote", nullif(s.provider_sandbox_id,'') as "providerSandboxId",
  s.id, s.org_id as "orgId", s.owner_id as "ownerId",
  s.provider::text as provider, s.harness::text as harness, s.model, s.reasoning_effort as "reasoningEffort",
  coalesce(s.status='stopped' and s.status_reason='idle_paused',false) as "idlePaused", ${publicSandboxStatusSql} as status, s.created_at as "createdAt", s.stopped_at as "stoppedAt", s.expires_at as "expiresAt",
  s.effective_ttl_seconds as "effectiveTtlSeconds",
  case when s.machine_size->>'effective' in ('small','medium','large','xlarge') then s.machine_size->>'effective' else null end as "machineSize",
  'Sandbox ' || s.id::text as "displayLabel",
  case when ${SANDBOX_LIST_INTERIOR} then s.task_outcome else null end as "taskOutcome",
  case when ${SANDBOX_LIST_INTERIOR} then s.pull_requests else null end as "pullRequests",
  case when ${SANDBOX_LIST_INTERIOR} then s.external_ref else null end as "externalRef",
  ${SANDBOX_LIST_INTERIOR} as "canOpen",
  ${SANDBOX_LIST_INTERIOR} as "canManage"`;

// Interior-only filter: a metadata-only org viewer cannot probe another member's external reference.
const sandboxListMatch = (externalRef: number) => `${SANDBOX_MEMBER}
               and ($${externalRef}::text is null or (s.external_ref = $${externalRef}::text and ${SANDBOX_INTERIOR}))
               and ($9::uuid is null or s.org_id=$9::uuid)
               and (($3::text[] is null and s.status <> 'deleted') or ${publicSandboxStatusSql} = any($3::text[]))
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

    const goldens: GoldenStore = {
      ...createScopedGoldenWrites(sql, caller, scope),
      reconcileOperations: (golden, actor) => reconcileGoldenOperations(sql, golden, actor),
      beginOperation: (id, expected) => beginGoldenOperation(sql, id, expected),
      beginSnapshotLaunch(golden, actor, sandboxId) {
        ownOrg(golden.orgId);
        if (actor.userId !== caller.userId || actor.orgId !== golden.orgId)
          throw new GoldenError("forbidden", "Caller mismatch.");
        return beginSnapshotLaunch(sql, golden, actor, sandboxId);
      },
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
      insert: readOnly,
      setConfig: readOnly,
    };

    async function readSandbox(id: string, forStop: boolean) {
      if (!UUID.test(id)) return null;
      const result = await sql.query<SandboxViewRow & { stop_busy: boolean }>(
        `select ${SANDBOX_COLUMNS}${
          forStop
            ? `, (
          coalesce(s.reconcile_lease_until > clock_timestamp(), false)
          or ${unresolvedModalLaunch("s")}
          or coalesce(s.activity_until > clock_timestamp(), false)
          or ((s.boat_runtime or s.runtime_transport is not distinct from 'dialout')
            and s.status in ('ready','running') and s.activity_lease_id is not null)
        ) as stop_busy`
            : ""
        }
        from public.sandboxes s join public.goldens g on g.id = s.golden_id
        where ${SANDBOX_VISIBLE} and s.id = $3`,
        [...scope, id],
      );
      const row = result.rows[0];
      return row ? { sandbox: mapView(row), busy: row.stop_busy === true } : null;
    }

    const sandboxes: ServerSandboxStore = {
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
        const rows = await sql.query<{
          usage: Pick<SandboxUsage, "turnCount" | "turns"> | null;
          awaiting_spend: boolean;
        }>(
          `select s.usage_turns as usage, exists(
            select 1 from public.account_spend_turns t
            where t.sandbox_id=s.id and t.prompt_id=$4 and t.account_id is null
          ) as awaiting_spend from public.sandboxes s where ${SANDBOX_VISIBLE} and s.id=$3::uuid`,
          [...scope, id, promptId],
        );
        const row = rows.rows[0];
        if (!row?.usage) return;
        const shares = row.usage.turns.filter((turn) => turn.promptId === promptId);
        const pending = shares.filter((turn) => !turn.pricing);
        if (row.awaiting_spend && !shares.length) {
          const unmeasured = unmeasuredUsage(promptId);
          await sandboxes.recordUsage!(id, { ...row.usage, turns: [unmeasured] }, { observations: [unmeasured] });
        } else if (pending.length) {
          await sandboxes.recordUsage!(id, row.usage, { observations: pending });
        }
      },
      async recordAccountRateLimit(id, promptId, retryAt) {
        if (!(await sandboxes.get(id))) throw new DataError("No such sandbox.");
        await recordTurnRateLimit(sql, id, promptId, retryAt);
      },
      async recordTurnModelEvidence(id, promptId, evidence) {
        if (!(await sandboxes.get(id))) throw new DataError("No such sandbox.");
        await createSqlSandboxStore(sql, { turnModels: true }).recordTurnModelEvidence!(id, promptId, evidence);
      },
      async recordLaunchStage(id, stage, elapsedMs, generation) {
        // An admitted resume can be driven by the owner or an organization admin.
        if (generation !== undefined) {
          if (await sandboxes.get(id)) await recordLaunchStageSql(sql, id, stage, elapsedMs, generation);
          return;
        }
        const owned = await sql.query("select 1 from public.sandboxes where id=$1::uuid and owner_id=$2::uuid", [
          id,
          caller.userId,
        ]);
        if (owned.rows.length) await recordLaunchStageSql(sql, id, stage, elapsedMs);
      },
      async recordSkills(id, skills) {
        await recordSandboxSkills(sql, id, caller.userId, skills);
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
      requestStartingModalStop: (sandbox, signal) => requestStartingModalStop(sql, scope, sandbox, signal),
      async assertDeletionAllowed(id) {
        if (!UUID.test(id)) throw new GoldenError("not_found", "No such sandbox.");
        const row = (
          await sql.query<{ status: string; managed: boolean; modal_cleanup_owns_exit: boolean }>(
            `select s.status::text as status,
             coalesce(s.status='failed' and (s.provider='modal' or s.boat_runtime) and s.status_reason=$4 and s.stopped_at is null, false) or ${unresolvedModalStop("s")}
               as modal_cleanup_owns_exit,
             ${SANDBOX_DELETION_MANAGED} as managed
           from public.sandboxes s where s.id=$3::uuid and s.org_id=any($1::uuid[])
           and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$2::uuid
             and (s.owner_id=$2::uuid or m.role='admin'))`,
            [...scope, id, MODAL_LAUNCH_FAILURE],
          )
        ).rows[0];
        if (!row) throw new GoldenError("not_found", "No such sandbox or deletion access denied.");
        if (row.modal_cleanup_owns_exit) throw new GoldenError("conflict", "Sandbox exit is unconfirmed.");
        if (row.managed)
          throw new GoldenError(
            "conflict",
            "Managed orchestrators have their own lifecycle; delete an ordinary delegated parent before its child.",
          );
        if (!["stopped", "failed", "deleted"].includes(row.status))
          throw new GoldenError("conflict", "Stop the sandbox before deleting it.");
      },
      async recordUsage(id, usage, options) {
        // Legacy adapters record unpriced telemetry only. Never erase a frozen context or
        // leave a stale known amount beside updated counters without a transaction.
        if (!sql.transaction) {
          await mergeSandboxUsage(sql, scope, id, usage, true);
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
          const merged = (await mergeSandboxUsage(tx, scope, id, usage, false)).rows[0]?.usage;
          if (!merged) return;
          const observations = options?.observations ?? [];
          const completed = options?.completed ?? new Map<string, string>();
          const unmeasured = [...completed.keys()].map(unmeasuredUsage);
          const contextRows = [...observations, ...unmeasured];
          let contexts = options?.contexts;
          if (contexts === undefined && contextRows.length) {
            const admissions = await tx.query<{ prompt_id: string; context: unknown; captured: boolean }>(
              `select prompt_id,pricing_context as context,pricing_context is not null as captured
               from public.sandbox_turn_models where sandbox_id=$1 and prompt_id=any($2::text[])`,
              [id, [...new Set(contextRows.map((row) => row.promptId))]],
            );
            const byPrompt = new Map(admissions.rows.map((row) => [row.prompt_id, row]));
            const byShare = new Map(contextRows.map((row) => [JSON.stringify([row.promptId, row.model]), row]));
            contexts = [...byShare.values()].flatMap((row) => {
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
          await saveSandboxUsage(tx, scope, id, priced);
          await publishAccountSpend(
            tx,
            id,
            completed,
            observations,
            priced.turns,
            stampTurnPricing(unmeasured, [], [], contexts ?? [], before.harness),
          );
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
      async readWorkRecovery(id, recoveryId) {
        if (!UUID.test(id)) throw new DataError("No such sandbox.", "not_found");
        const archive = await readWorkRecovery(sql, scope, id, recoveryId);
        if (archive === undefined) throw new DataError("No such sandbox.", "not_found");
        return archive;
      },
      async update(id, patch) {
        if (patch.expireAfterExtension) {
          const { expectedGeneration, activityToken } = patch;
          if (!sql.transaction || expectedGeneration === undefined || !activityToken || !patch.finishActivity)
            throw new DataError("Unsafe extension settlement requires its activity generation and token.");
          const applied = await sql.transaction((tx) =>
            expireAfterExtension(tx, scope, id, expectedGeneration, activityToken),
          );
          if (!applied) throw new DataError("Extension activity changed before settlement.", "sandbox_not_ready");
          return;
        }
        if (patch.deleteCompleted) {
          const { expectedGeneration, activityToken } = patch;
          if (!sql.transaction || expectedGeneration === undefined || !activityToken || !patch.finishActivity)
            throw new DataError("Sandbox deletion completion requires its activity generation and token.");
          const applied = await sql.transaction((tx) =>
            completeSandboxDeletion(tx, scope, id, expectedGeneration, activityToken),
          );
          if (!applied) {
            const error = new DataError("Sandbox deletion receipt is stale.", "sandbox_not_ready");
            throw error;
          }
          return;
        }
        if (patch.status === "deleted") throw new DataError("Sandbox deletion requires a confirmed receipt.");
        const stopStatus =
          patch.ownerStop && (patch.status === "stopping" || patch.status === "failed") ? patch.status : undefined;
        if (
          patch.ownerStop &&
          (!stopStatus ||
            patch.expectedGeneration === undefined ||
            !patch.activityToken ||
            !patch.advanceGeneration ||
            patch.finishActivity ||
            patch.stopRequested !== true)
        )
          throw new DataError("Owner stop requires its activity generation, token and phase.");
        const reason = statusReasonOf(patch);
        if (patch.providerObservation !== undefined) {
          if (
            patch.expectedGeneration === undefined ||
            reason === undefined ||
            (patch.status !== "failed" &&
              patch.status !== "stopped" &&
              patch.status !== "ready" &&
              patch.status !== "running" &&
              patch.status !== "starting" &&
              patch.status !== "stopping") ||
            (patch.status === "stopped" && !patch.stoppedAt)
          )
            throw new DataError("Provider observation publication requires generation and state evidence.");
          const result = await recordObservedProviderState(sql, scope, {
            sandboxId: id,
            generation: patch.expectedGeneration,
            ...patch.providerObservation,
            toState: patch.status,
            reason,
            stoppedAt: patch.stoppedAt ?? null,
          });
          if (result.kind === "conflict")
            throw new DataError("Provider state observation is stale.", "sandbox_not_ready");
          return;
        }
        if (patch.status !== undefined && stopStatus === undefined)
          throw new DataError("Sandbox status changes require a lifecycle transition.");
        const applied = await applyScopedSandboxPatch(sql, scope, id, patch, stopStatus, reason);
        if (!applied) return;
        const { result, admission, observeRefusal } = applied;
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
          const evidence = result.rows[0]?.stop_evidence;
          const blockedStop = stopStatus !== undefined && admission && !patch.onlyIfIdle && evidence;
          const cause =
            result.observationBlocked || (blockedStop && evidence.reconcileLeaseHeld)
              ? new RuntimeReconciliationConflict()
              : blockedStop && evidence.activityLeaseHeld
                ? new RuntimeCheckpointActivityConflict()
                : blockedStop && evidence.generation !== evidence.requestGeneration
                  ? new SandboxStopTargetChanged()
                  : undefined;
          const error = new DataError(
            "The sandbox is busy or its lifecycle changed; retry after refreshing status.",
            "sandbox_not_ready",
            cause ? { cause } : undefined,
          );
          if (stopStatus !== undefined)
            recordOperatorDiagnostic("sandbox.stop.admission", failureDiagnostic(error), {
              sandboxId: id,
              refusalCode: "stop_fence_rejected",
              stopEvidence: result.rows[0]?.stop_evidence ?? null,
            });
          throw error;
        }
        // Names the writer behind any later refusal's activityLeaseId. Lease IDs are random
        // fences, not credentials.
        if (admission || patch.turnActivity === "claim")
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
        await reportSandboxTaskOutcome(sql, scope, id, promptId, outcome, expectedGeneration);
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
            | "modalTransport"
            | "preservationNote"
            | "credentialId"
            | "conversationIds"
          >
        >(
          `select s.credential_id as "credentialId",s.provider,s.status,s.preservation_note as "preservationNote",s.status_reason as "statusReason",s.expires_at as "expiresAt",s.boat_runtime as "boatRuntime",s.runtime_transport as "modalTransport",s.conversation_ids as "conversationIds"
           from public.sandboxes s where ${SANDBOX_VISIBLE} and s.id=$3`,
          [...scope, id],
        );
        return result.rows[0] ?? null;
      },
      getForStop: (id) => readSandbox(id, true),
      async get(id) {
        return (await readSandbox(id, false))?.sandbox ?? null;
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
             left join public.members lm on lm.org_id=s.org_id and lm.user_id=$2::uuid
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
       left join public.members lm on lm.org_id=s.org_id and lm.user_id=$2::uuid
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
