import type { Harness } from "./contract.ts";
import type { SandboxStatus } from "./database.types.ts";
import type { Sql } from "./golden-store.ts";
import { type Provider, ProviderError } from "./provider.ts";
import { isSandboxProvider, type SandboxProviderId } from "./sandbox-provider.ts";

/** An Armada sandbox: the metadata of one fork of a golden. The provider keeps the disk and the conversations. */
export interface SandboxRecord {
  id: string;
  /** Its golden's provider: where it runs, for good. */
  provider: SandboxProviderId;
  /** The provider's own id (`bx_...` on boat). Unique per provider only. */
  providerSandboxId: string;
  goldenId: string;
  orgId: string;
  ownerId: string;
  harness: Harness;
  status: SandboxStatus;
  conversationIds: string[];
  createdAt: string;
  stoppedAt: string | null;
  deletedAt: string | null;
  /** Why it failed (a usage limit, an expired login, a launch error). Null unless the status is failed. */
  statusReason: string | null;
  /** The model its turns run with. Null only for sandboxes launched before the choice was recorded. */
  model: string | null;
  /** The reasoning effort its turns run with. Null exactly when `model` is. */
  reasoningEffort: string | null;
}

export interface SandboxPatch {
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
 * exactly when its golden is, so a private golden's sandboxes are the owner's alone.
 */
export interface SandboxStore {
  insert(input: {
    id: string;
    /** Must be the golden's provider: the database refuses another. */
    provider: SandboxProviderId;
    providerSandboxId: string;
    goldenId: string;
    orgId: string;
    ownerId: string;
    harness: Harness;
    status: SandboxStatus;
    model: string;
    reasoningEffort: string;
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
      await store.update(sandbox.id, { status: "deleted", deletedAt: now.toISOString() });
      result.deleted.push(sandbox.id);
    } catch (error) {
      result.failed.push({ id: sandbox.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export interface SandboxRow {
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
  reasoning_effort: string | null;
}

/** The longest failure reason kept; a longer one is cut. */
export const MAX_STATUS_REASON_LENGTH = 2000;

const COLUMNS = `id, provider::text as provider, provider_sandbox_id, golden_id, org_id, owner_id, harness::text as harness, status::text as status,
  conversation_ids, created_at, stopped_at, deleted_at, status_reason, model, reasoning_effort`;

export function createSqlSandboxStore(sql: Sql): SandboxStore {
  return {
    async insert(input): Promise<SandboxRecord> {
      const result = await sql.query<SandboxRow>(
        `insert into public.sandboxes (id, provider_sandbox_id, golden_id, org_id, owner_id, harness, status, model,
           reasoning_effort, provider)
         values ($1, $2, $3, $4, $5, $6::public.harness, $7::public.sandbox_status, $8, $9, $10::public.sandbox_provider)
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
      if (patch.status !== undefined) set("status", patch.status, "::public.sandbox_status");
      if (patch.conversationIds !== undefined) set("conversation_ids", patch.conversationIds, "::text[]");
      if (patch.stoppedAt !== undefined) set("stopped_at", patch.stoppedAt, "::timestamptz");
      if (patch.deletedAt !== undefined) set("deleted_at", patch.deletedAt, "::timestamptz");
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
         order by created_at asc`,
        [cutoff],
      );
      return result.rows.map(mapSandboxRow);
    },
  };
}

export function mapSandboxRow(row: SandboxRow): SandboxRecord {
  if (row.harness !== "claude" && row.harness !== "codex") throw new Error("Sandbox row harness is invalid.");
  if (!isSandboxProvider(row.provider)) throw new Error("Sandbox row provider is invalid.");
  return {
    id: row.id,
    provider: row.provider,
    providerSandboxId: row.provider_sandbox_id,
    goldenId: row.golden_id,
    orgId: row.org_id,
    ownerId: row.owner_id,
    harness: row.harness,
    status: row.status as SandboxStatus,
    conversationIds: row.conversation_ids,
    createdAt: iso(row.created_at),
    stoppedAt: row.stopped_at === null ? null : iso(row.stopped_at),
    deletedAt: row.deleted_at === null ? null : iso(row.deleted_at),
    statusReason: row.status_reason ?? null,
    model: row.model ?? null,
    reasoningEffort: row.reasoning_effort ?? null,
  };
}

/**
 * The `status_reason` a patch writes: its reason with the failed status (cut to the limit), null with
 * any other status, and undefined (left as it is) when the patch does not touch either.
 */
export function statusReasonOf(patch: SandboxPatch): string | null | undefined {
  if (patch.status !== undefined && patch.status !== "failed") return null;
  if (patch.statusReason === undefined) return undefined;
  if (patch.statusReason === null || patch.statusReason.trim() === "") return null;
  return patch.statusReason.slice(0, MAX_STATUS_REASON_LENGTH);
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
