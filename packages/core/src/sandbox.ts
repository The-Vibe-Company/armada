import type { Harness } from "./contract.ts";
import type { SandboxStatus } from "./database.types.ts";
import type { Sql } from "./golden-store.ts";
import { isHarness } from "./harnesses.ts";
import type { MachineSizeEvidence } from "./machine-size.ts";
import type { OrchestratorSkillReceipt } from "./orchestrator.ts";
import { type Provider, ProviderError } from "./provider.ts";
import { isSandboxProvider, type SandboxProviderId } from "./sandbox-provider.ts";
import { type SandboxUsage, withUsageTotals } from "./sandbox-usage.ts";
import type { TaskOutcome } from "./task-outcome.ts";

/** An Armada sandbox: the metadata of one fork of a golden. The provider keeps the disk and the conversations. */
export interface ResourceProject {
  version: 1;
  url: string;
  branch: string;
  dir: string;
}

export interface SandboxRecord {
  skills?: OrchestratorSkillReceipt[];
  usage?: SandboxUsage | null;
  preservationNote?: string | null;
  taskOutcome?: TaskOutcome | null;
  /** Actual accepted run ID; empty only after successful steer (resolve via events), null when unreportable. */
  taskPromptId?: string | null;
  resourceProject?: ResourceProject | null;
  machineSize?: MachineSizeEvidence | null;
  credentialId?: string | null;
  credentialVersion?: number | null;
  expiresAt?: string;
  effectiveTtlSeconds?: number;
  requestedTtlSeconds?: number | null;
  lastObservedAt?: string | null;
  lifecycleError?: string | null;
  stopRequestedAt?: string | null;
  lifecycleGeneration?: number;
  id: string;
  /** Its golden's provider: where it runs, for good. */
  provider: SandboxProviderId;
  /** The provider's own id (`bx_...` on boat). Unique per provider only. */
  providerSandboxId: string;
  goldenId: string;
  orgId: string;
  ownerId: string;
  visibility?: "private" | "org";
  harness: Harness;
  status: SandboxStatus;
  conversationIds: string[];
  createdAt: string;
  stoppedAt: string | null;
  deletedAt: string | null;
  /** Why it failed (a usage limit, an expired login, a launch error). Null unless the status is failed. */
  statusReason: string | null;
  /** Immutable native repository directory selected at launch; null for no selection or legacy rows. */
  repositoryDir: string | null;
  /** The model its turns run with. Null only for sandboxes launched before the choice was recorded. */
  model: string | null;
  /** The reasoning effort its turns run with. Null exactly when `model` is. */
  reasoningEffort: string | null;
}

export interface SandboxPatch {
  expiresAt?: string;
  effectiveTtlSeconds?: number;
  /** Admission guard for explicit owner/admin deletion of terminal, unmanaged sandboxes. */
  deleteRequested?: boolean;
  /** Physical interval endpoint is unknown; never fabricate a duration. */
  usageRuntimeUnknown?: boolean;
  clearTaskOutcome?: boolean;
  taskPromptId?: string;
  renewLifecycle?: boolean;
  expectedGeneration?: number;
  advanceGeneration?: boolean;
  finishActivity?: boolean;
  activityToken?: string;
  renewActivity?: boolean;
  rearmDeadline?: boolean;
  stopRequested?: boolean;
  status?: SandboxStatus;
  conversationIds?: string[];
  /** ISO timestamp. */
  stoppedAt?: string | null;
  /** ISO timestamp. */
  deletedAt?: string | null;
  /** Only with the failed status; any other status clears it. */
  statusReason?: string | null;
}

/**
 * Sandboxes through a database. The connection's role is the caller: a sandbox is visible
 * to its current organization owner/admin for interior. Lists use the separate SandboxListMetadata projection.
 */
export interface SandboxStore {
  recordTurnModel?(id: string, promptId: string, requestedModel: string | null): Promise<void>;
  readTurnModel?(id: string, promptId: string): Promise<{ requestedModel: string | null; evidence: unknown } | null>;
  recordTurnModelEvidence?(id: string, promptId: string, evidence: unknown): Promise<void>;
  recordSkills?(id: string, skills: OrchestratorSkillReceipt[]): Promise<void>;
  /** Server store can atomically reserve activity ownership; caller-role stores keep their existing restricted grants. */
  activityOwnership?: true;
  insert(input: {
    credentialId?: string;
    credentialVersion?: number;
    id: string;
    /** Must be the golden's provider: the database refuses another. */
    provider: SandboxProviderId;
    providerSandboxId: string;
    goldenId: string;
    orgId: string;
    ownerId: string;
    harness: Harness;
    status: SandboxStatus;
    machineSize?: MachineSizeEvidence;
    resourceProject?: ResourceProject;
    activityLeaseId?: string;
    expiresAt?: string;
    requestedTtlSeconds?: number;
    effectiveTtlSeconds?: number;
    repositoryDir?: string | null;
    model: string;
    reasoningEffort: string;
    visibility?: "private" | "org";
  }): Promise<SandboxRecord>;
  update(id: string, patch: SandboxPatch): Promise<void>;
  /** Sandboxes created before `cutoff` (ISO) that are not deleted yet, oldest first. */
  listBefore(cutoff: string): Promise<SandboxRecord[]>;
}

/** How long Armada keeps a sandbox before its cleanup deletes it, when nobody says otherwise. */
export const DEFAULT_SANDBOX_RETENTION_DAYS = 7;

export interface CleanupResult {
  deleted: string[];
  failed: { id: string; message: string }[];
}

/**
 * Deletes this provider's sandboxes older than `retentionDays` from it and marks them `deleted`.
 * A sandbox the provider no longer has counts as deleted. One failure does not stop the others.
 */
export async function cleanupSandboxes(
  provider: Provider,
  store: SandboxStore,
  options: { retentionDays?: number; now?: Date } = {},
): Promise<CleanupResult> {
  const days = options.retentionDays ?? DEFAULT_SANDBOX_RETENTION_DAYS;
  if (!Number.isFinite(days) || days <= 0) throw new RangeError("retentionDays must be a positive number.");
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const result: CleanupResult = { deleted: [], failed: [] };
  for (const sandbox of await store.listBefore(cutoff)) {
    // Another provider's sandboxes are that provider's cleanup to delete.
    if (sandbox.provider !== provider.id) continue;
    try {
      await provider.delete({ sandboxId: sandbox.providerSandboxId });
    } catch (error) {
      if (!(error instanceof ProviderError && error.code === "not_found")) {
        result.failed.push({ id: sandbox.id, message: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }
    try {
      await store.update(sandbox.id, {
        status: "deleted",
        deletedAt: now.toISOString(),
        ...(sandbox.stoppedAt === null ? { usageRuntimeUnknown: true } : {}),
      });
      result.deleted.push(sandbox.id);
    } catch (error) {
      result.failed.push({ id: sandbox.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export interface SandboxRow {
  usage?: SandboxUsage | null;
  preservation_note?: string | null;
  task_outcome?: TaskOutcome | null;
  task_prompt_id?: string | null;
  machine_size?: MachineSizeEvidence | null;
  resource_project?: ResourceProject | null;
  credential_id?: string | null;
  credential_version?: number | null;
  id: string;
  provider: string;
  provider_sandbox_id: string;
  golden_id: string;
  org_id: string;
  owner_id: string;
  harness: string;
  status: string;
  conversation_ids: string[];
  created_at: string | Date;
  stopped_at: string | Date | null;
  deleted_at: string | Date | null;
  status_reason: string | null;
  model: string | null;
  skills?: OrchestratorSkillReceipt[];
  reasoning_effort: string | null;
  repository_dir: string | null;
  visibility?: "private" | "org";
  expires_at?: string | Date;
  effective_ttl_seconds?: number;
  requested_ttl_seconds?: number | null;
  last_observed_at?: string | Date | null;
  lifecycle_error?: string | null;
  stop_requested_at?: Date | string | null;
  lifecycle_generation?: number | string | bigint;
}

/** The longest failure reason kept; a longer one is cut. */
export const MAX_STATUS_REASON_LENGTH = 2000;

const COLUMNS = `skills, preservation_note, task_outcome, task_prompt_id, credential_id, credential_version, id, provider::text as provider, provider_sandbox_id, golden_id, org_id, owner_id, harness::text as harness, status::text as status,
  conversation_ids, created_at, stopped_at, deleted_at, status_reason, model, reasoning_effort, machine_size, resource_project, visibility, repository_dir, expires_at, effective_ttl_seconds, requested_ttl_seconds, last_observed_at, lifecycle_error, lifecycle_generation, stop_requested_at`;

/** Turn evidence is service-role-only; caller-role stores must not gain these ports. */
export function createSqlSandboxStore(sql: Sql, options: { turnModels?: true } = {}): SandboxStore {
  return {
    ...(options.turnModels ? sqlTurnModelStore(sql) : {}),
    async recordSkills(id, skills) {
      const result = await sql.query(
        "update public.sandboxes set skills=$2::text::jsonb where id=$1::uuid returning id",
        [id, JSON.stringify(skills)],
      );
      if (result.rows.length !== 1) throw new Error("Skill receipts could not be recorded.");
    },
    async insert(input): Promise<SandboxRecord> {
      const result = await sql.query<SandboxRow>(
        `insert into public.sandboxes (id, provider_sandbox_id, golden_id, org_id, owner_id, harness, status, model,
           reasoning_effort, provider, visibility, repository_dir, requested_ttl_seconds, effective_ttl_seconds, expires_at, activity_lease_id, activity_until, credential_id, credential_version, machine_size, resource_project)
         values ($1, $2, $3, $4, $5, $6::public.harness, $7::public.sandbox_status, $8, $9, $10::public.sandbox_provider, $11::public.visibility, $12::text, $13::integer, $14::integer, coalesce($20::timestamptz, now() + $14::integer * interval '1 second'), $15::uuid, case when $15::uuid is not null then now()+interval '2 minutes' else null end, $16::uuid, $17::integer, $18::text::jsonb, $19::text::jsonb)
         returning ${COLUMNS}`,
        [
          input.id,
          input.providerSandboxId,
          input.goldenId,
          input.orgId,
          input.ownerId,
          input.harness,
          input.status,
          input.model,
          input.reasoningEffort,
          input.provider,
          input.visibility ?? null,
          input.repositoryDir ?? null,
          input.requestedTtlSeconds ?? null,
          input.effectiveTtlSeconds ?? 14400,
          input.activityLeaseId ?? null,
          input.credentialId ?? null,
          input.credentialVersion ?? null,
          JSON.stringify(input.machineSize ?? null),
          JSON.stringify(input.resourceProject ?? null),
          input.expiresAt ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("The sandbox could not be recorded.");
      return mapSandboxRow(row);
    },

    async update(id, patch): Promise<void> {
      const sets: string[] = [];
      const params: unknown[] = [id];
      const set = (column: string, value: unknown, cast = "") => {
        params.push(value);
        sets.push(`${column} = $${params.length}${cast}`);
      };
      if (patch.usageRuntimeUnknown) sets.push("usage_runtime_seconds = null", "usage_running_since = null");
      if (patch.clearTaskOutcome) sets.push("task_outcome = null", "task_prompt_id = null");
      if (patch.taskPromptId !== undefined) set("task_prompt_id", patch.taskPromptId, "::text");
      if (patch.status !== undefined) set("status", patch.status, "::public.sandbox_status");
      if (patch.conversationIds !== undefined) set("conversation_ids", patch.conversationIds, "::text[]");
      if (patch.stoppedAt !== undefined) set("stopped_at", patch.stoppedAt, "::timestamptz");
      if (patch.deletedAt !== undefined) set("deleted_at", patch.deletedAt, "::timestamptz");
      if (patch.expiresAt !== undefined) set("expires_at", patch.expiresAt, "::timestamptz");
      if (patch.effectiveTtlSeconds !== undefined) set("effective_ttl_seconds", patch.effectiveTtlSeconds, "::integer");
      const reason = statusReasonOf(patch);
      if (reason !== undefined) set("status_reason", reason, "::text");
      if (sets.length === 0) return;
      const result = await sql.query<{ id: string }>(
        `update public.sandboxes set ${sets.join(", ")} where id = $1 returning id`,
        params,
      );
      if (!result.rows[0]) throw new Error("The sandbox could not be updated.");
    },

    async listBefore(cutoff): Promise<SandboxRecord[]> {
      const result = await sql.query<SandboxRow>(
        `select ${COLUMNS} from public.sandboxes
         where created_at < $1::timestamptz and status <> 'deleted'
         and not exists(select 1 from public.orchestrators o where o.sandbox_id=sandboxes.id)
         order by created_at asc`,
        [cutoff],
      );
      return result.rows.map(mapSandboxRow);
    },
  };
}

export function mapSandboxRow(row: SandboxRow): SandboxRecord {
  if (!isHarness(row.harness)) throw new Error("Sandbox row harness is invalid.");
  if (!isSandboxProvider(row.provider)) throw new Error("Sandbox row provider is invalid.");
  const lifecycleGeneration = decodeLifecycleGeneration(row.lifecycle_generation);
  return {
    ...(row.expires_at
      ? {
          expiresAt: iso(row.expires_at),
          effectiveTtlSeconds: row.effective_ttl_seconds ?? 14400,
          requestedTtlSeconds: row.requested_ttl_seconds ?? null,
          lastObservedAt: row.last_observed_at ? iso(row.last_observed_at) : null,
          lifecycleError: row.lifecycle_error ?? null,
          lifecycleGeneration,
        }
      : {}),
    stopRequestedAt: row.stop_requested_at ? iso(row.stop_requested_at) : null,
    usage: withUsageTotals(row.usage),
    preservationNote: row.preservation_note ?? null,
    taskOutcome: row.task_outcome ?? null,
    taskPromptId: row.task_prompt_id ?? null,
    id: row.id,
    provider: row.provider,
    providerSandboxId: row.provider_sandbox_id,
    goldenId: row.golden_id,
    orgId: row.org_id,
    ownerId: row.owner_id,
    ...(row.visibility ? { visibility: row.visibility } : {}),
    credentialId: row.credential_id ?? null,
    credentialVersion: row.credential_version ?? null,
    harness: row.harness,
    status: row.status as SandboxStatus,
    conversationIds: row.conversation_ids,
    createdAt: iso(row.created_at),
    stoppedAt: row.stopped_at === null ? null : iso(row.stopped_at),
    deletedAt: row.deleted_at === null ? null : iso(row.deleted_at),
    statusReason: row.status_reason ?? null,
    repositoryDir: row.repository_dir ?? null,
    machineSize: row.machine_size ?? null,
    resourceProject: row.resource_project ?? null,
    model: row.model ?? null,
    reasoningEffort: row.reasoning_effort ?? null,
    skills: row.skills ?? [],
  };
}

/**
 * The `status_reason` a patch writes: its reason with the failed status (cut to the limit), null with
 * any other status, and undefined (left as it is) when the patch does not touch either.
 */
export function statusReasonOf(patch: SandboxPatch): string | null | undefined {
  if (patch.statusReason === "expired" && (patch.status === "stopped" || patch.status === "stopping")) return "expired";
  if (patch.status !== undefined && patch.status !== "failed") return null;
  if (patch.statusReason === undefined) return undefined;
  if (patch.statusReason === null || patch.statusReason.trim() === "") return null;
  return patch.statusReason.slice(0, MAX_STATUS_REASON_LENGTH);
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** PostgreSQL int8 is a string with Bun.SQL's default decoder, but a number with
 * PGlite. Normalize once at the trusted row boundary, before any activity arithmetic. */
function decodeLifecycleGeneration(value: SandboxRow["lifecycle_generation"]): number {
  if (value === undefined) return 1; // Legacy in-memory records without lifecycle metadata.
  if (typeof value === "string" && !/^[1-9][0-9]*$/.test(value))
    throw new Error("Sandbox lifecycle generation is invalid.");
  if (typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint")
    throw new Error("Sandbox lifecycle generation is invalid.");
  const decoded = Number(value);
  if (!Number.isSafeInteger(decoded) || decoded < 1) throw new Error("Sandbox lifecycle generation is invalid.");
  return decoded;
}

function sqlTurnModelStore(
  sql: Sql,
): Pick<SandboxStore, "recordTurnModel" | "readTurnModel" | "recordTurnModelEvidence"> {
  return {
    async recordTurnModel(id, promptId, requestedModel) {
      await sql.query(
        `insert into public.sandbox_turn_models(sandbox_id,prompt_id,requested_model)
        values($1::uuid,$2,$3) on conflict do nothing`,
        [id, promptId, requestedModel],
      );
    },
    async readTurnModel(id, promptId) {
      const result = await sql.query<{ requestedModel: string | null; evidence: unknown }>(
        `select requested_model as "requestedModel", evidence from public.sandbox_turn_models where sandbox_id=$1::uuid and prompt_id=$2`,
        [id, promptId],
      );
      return result.rows[0] ?? null;
    },
    async recordTurnModelEvidence(id, promptId, evidence) {
      await sql.query(
        `update public.sandbox_turn_models set evidence=$3::text::jsonb where sandbox_id=$1::uuid and prompt_id=$2`,
        [id, promptId, JSON.stringify(evidence)],
      );
    },
  };
}
