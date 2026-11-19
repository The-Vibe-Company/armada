import { DelegatedAuthority, decryptSecret, type Sql, VaultError } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import type { SandboxView } from "./data.ts";
import { createSqlData } from "./data.ts";
import { createDockerSandboxService } from "./docker-sandbox-service.ts";
import { runtimeHarnessSupported } from "./provider-runtime-admission.ts";
import type { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import { unsettledRuntimeCommands } from "./runtime-idle-evidence.ts";

interface Intent {
  epoch: string;
  current_epoch: string;
  request_id: string;
  watermark: string | null;
  archive?: string;
}
type CheckpointReply = {
  status?: number;
  epoch?: string;
  requestId?: string;
  body?: {
    version?: number;
    requestId?: string;
    error?: unknown;
    result?: { generation?: string; watermark?: number; acknowledgedSequence?: number };
  };
};

export class RuntimeCheckpointRejected extends VaultError {
  constructor() {
    super("conflict", "Runtime refused the checkpoint. No resume proof was recorded.");
  }
}

/** The runtime checkpoint acknowledgement for this epoch and command, or undefined when Armada rejects it. */
function checkpointProof(result: CheckpointReply, epoch: string, commandId: string): { watermark: number } | undefined {
  const proof = result?.body?.result;
  if (
    result?.status !== 200 ||
    result.epoch !== epoch ||
    result.requestId !== commandId ||
    result.body?.version !== 1 ||
    result.body.requestId !== result.requestId ||
    result.body.error !== undefined ||
    proof?.generation !== epoch ||
    typeof proof.watermark !== "number" ||
    !Number.isSafeInteger(proof.watermark) ||
    proof.watermark < 0 ||
    proof.acknowledgedSequence !== proof.watermark
  )
    return undefined;
  return { watermark: proof.watermark };
}
function scrubAcknowledged(
  reply: Awaited<ReturnType<ReturnType<typeof createRuntimeCommands>["call"]>>,
  epoch: string,
  requestId: string,
) {
  return (
    reply.status === 200 &&
    reply.epoch === epoch &&
    reply.requestId === requestId &&
    reply.body.version === 1 &&
    reply.body.requestId === requestId &&
    reply.body.error === undefined &&
    (reply.body.result as { acknowledged?: unknown } | undefined)?.acknowledged === true
  );
}

export interface RuntimeCheckpointInput {
  id: string;
  request_id: string;
  runtimeVersion: 1;
}
export type RuntimeCheckpoint = ReturnType<typeof createRuntimeCheckpoint>;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
/** Explicit quiescence, NOT compute stop or proof that the host retained its disk.
 * No locks cross RPC. Durable intent blocks sends; any uncertainty stays fenced.
 */
export function createRuntimeCheckpoint(
  sql: Sql,
  key: string,
  commands: ReturnType<typeof createRuntimeCommands>,
  options: { docker?: boolean } = {},
) {
  type Target = {
    id: string;
    ownerId: string;
    orgId: string;
    provider: string;
    harness: string;
    status: string;
    deletedAt: string | null;
    stopRequestedAt?: string | null;
    boatRuntime?: boolean;
    runtimeTransport?: string;
  };
  const dockerTarget = async (caller: Caller, id: string): Promise<Target | null> => {
    if (!options.docker) return null;
    const target = (
      await sql.query<{ org_id: string }>(
        `select s.org_id from public.sandboxes s join public.members m on m.org_id=s.org_id and m.user_id=$2
       where s.id=$1 and s.provider='docker' and s.owner_id=$2 and s.org_id=any($3::uuid[])`,
        [id, caller.userId, caller.orgs.map((org) => org.orgId)],
      )
    ).rows[0];
    if (!target) return null;
    return createDockerSandboxService(sql, key).get({ userId: caller.userId, orgId: target.org_id }, id);
  };
  const authorize = async (caller: Caller, id: string) => {
    const row: Target | null = (await createSqlData(sql)(caller).sandboxes.get(id)) ?? (await dockerTarget(caller, id));
    if (
      !row ||
      row.ownerId !== caller.userId ||
      !(
        (row.provider === "docker" && options.docker) ||
        ((row.boatRuntime || row.runtimeTransport === "dialout") && ["boat", "modal"].includes(row.provider))
      ) ||
      !runtimeHarnessSupported(row.provider, row.harness) ||
      row.deletedAt
    )
      throw new VaultError("not_found", "No owned runtime checkpoint target.");
    if (
      !(await sql.query("select id from public.sandboxes where id=$1 and not application_secret_tainted", [id])).rows[0]
    )
      throw new VaultError("conflict", "Application-secret exposure forbids checkpoint reuse.");
    return row;
  };
  const read = async (tx: Sql, id: string, requestId: string) =>
    (
      await tx.query<Intent>(
        `select p.epoch::text,r.epoch::text as current_epoch,p.request_id::text,p.watermark::text,
     (select coalesce(max(sequence),0)::text from public.runtime_events e where e.sandbox_id=p.sandbox_id) as archive
     from public.runtime_checkpoints p join public.runtime_enrolments r on r.sandbox_id=p.sandbox_id
     where p.sandbox_id=$1 and p.request_id=$2`,
        [id, requestId],
      )
    ).rows[0];
  const receipt = (id: string, p: Intent) => ({
    id,
    requestId: p.request_id,
    runtime: { kind: "armada" as const, epoch: p.epoch },
    checkpoint: {
      state: "complete" as const,
      watermark: Number(p.watermark),
      acknowledgedSequence: Number(p.watermark),
    },
  });
  return async (caller: Caller, input: RuntimeCheckpointInput, beforeIntent?: (tx: Sql) => Promise<void | boolean>) => {
    const requestId = input.request_id.toLowerCase();
    if (input.runtimeVersion !== 1 || !uuid.test(input.id) || !uuid.test(requestId))
      throw new VaultError("invalid", "Runtime checkpoint v1 requires sandbox and request UUIDs.");
    const sandbox = await authorize(caller, input.id);
    const old = await read(sql, sandbox.id, requestId);
    if (old && old.epoch !== old.current_epoch)
      throw new VaultError("conflict", "Checkpoint belongs to an older runtime epoch.");
    if (old?.watermark !== null && old?.watermark !== undefined) {
      if (old.archive !== old.watermark)
        throw new VaultError(
          "conflict",
          "Runtime journal changed after checkpoint; no resumable checkpoint is claimed.",
        );
      await authorize(caller, sandbox.id);
      return receipt(sandbox.id, old);
    }
    // Reconcile an ACK lost AFTER durable command completion, even if compute
    // was stopped before this server could publish its checkpoint receipt.
    const finish = async (intent: Intent) => {
      const row = (
        await sql.query<{ result_enc: Uint8Array<ArrayBuffer> | null }>(
          "select result_enc from public.runtime_commands where sandbox_id=$1 and request_id=$2 and epoch=$3",
          [sandbox.id, `checkpoint_${requestId}`, intent.epoch],
        )
      ).rows[0];
      if (!row?.result_enc) return undefined;
      let reply: CheckpointReply;
      try {
        reply = JSON.parse(await decryptSecret(row.result_enc, key));
      } catch {
        throw new VaultError("unavailable", "Runtime checkpoint receipt is unavailable.");
      }
      const commandId = `checkpoint_${requestId}`;
      if (
        reply?.status === 409 &&
        reply.epoch === intent.epoch &&
        reply.requestId === commandId &&
        typeof reply.body?.error === "string" &&
        reply.body.error !== "request_outcome_unknown"
      )
        throw new RuntimeCheckpointRejected();
      const proof = checkpointProof(reply, intent.epoch, commandId);
      if (!proof)
        throw new VaultError(
          "conflict",
          "Runtime did not acknowledge a complete checkpoint; inspect or stop without claiming resume.",
        );
      if (!sql.transaction)
        throw new VaultError("unavailable", "Runtime checkpoint requires transactional publication.");
      const completed = await sql.transaction(async (tx) => {
        const member = (
          await tx.query("select user_id from public.members where user_id=$1 and org_id=$2 for update", [
            caller.userId,
            sandbox.orgId,
          ])
        ).rows[0];
        if (!member) throw new VaultError("not_found", "Runtime checkpoint membership was revoked.");
        const target = (
          await tx.query(
            "select id from public.sandboxes where id=$1 and owner_id=$2 and (boat_runtime or (provider='modal' and runtime_transport='dialout') or (provider='docker' and $3::boolean)) and deleted_at is null and not application_secret_tainted for update",
            [sandbox.id, caller.userId, options.docker === true],
          )
        ).rows[0];
        if (!target) throw new VaultError("not_found", "Runtime checkpoint target changed.");
        const current = await read(tx, sandbox.id, requestId);
        if (!current || current.epoch !== intent.epoch || current.current_epoch !== intent.epoch)
          throw new VaultError("conflict", "Runtime epoch changed before checkpoint publication.");
        const high = (
          await tx.query<{ sequence: string }>(
            "select coalesce(max(sequence),0)::text as sequence from public.runtime_events where sandbox_id=$1",
            [sandbox.id],
          )
        ).rows[0];
        if (high?.sequence !== String(proof.watermark))
          throw new VaultError("conflict", "Checkpoint journal prefix is not fully synchronized.");
        const saved = await tx.query(
          "update public.runtime_checkpoints set watermark=$3,completed_at=coalesce(completed_at,now()) where sandbox_id=$1 and epoch=$2 and (watermark is null or watermark=$3) returning sandbox_id",
          [sandbox.id, intent.epoch, proof.watermark],
        );
        await tx.query(
          `update public.sandboxes set preservation_note=$2
           where id=$1 and stopped_at is not null and status in ('stopped','failed') and not application_secret_tainted
             and preservation_stop_generation is distinct from stop_generation`,
          [
            sandbox.id,
            `Armada runtime checkpoint acknowledged for epoch ${intent.epoch} through event ${proof.watermark}; host stop is confirmed. No Git work archive is claimed.`,
          ],
        );
        if (!saved.rows.length)
          throw new VaultError("conflict", "Runtime checkpoint receipt conflicts with prior proof.");
        return { ...current, watermark: String(proof.watermark) };
      });
      return receipt(sandbox.id, completed);
    };
    if (old) {
      const completed = await finish(old);
      if (completed) return completed;
    }
    if (!["ready", "running"].includes(sandbox.status) || sandbox.stopRequestedAt)
      throw new VaultError("conflict", "Stopped runtime has no acknowledged checkpoint; no compute was resumed.");
    const intent = await createRuntimeEnrolments(sql, key).withOwner(sandbox.id, caller.userId, async (tx, scope) => {
      const lease = (
        await tx.query<{ busy: boolean }>(
          "select (activity_lease_id is not null or reconcile_lease_until>now()) as busy from public.sandboxes where id=$1",
          [sandbox.id],
        )
      ).rows[0];
      if (lease?.busy)
        throw new VaultError(
          "conflict",
          "Runtime admission is busy; wait or reconcile its original request before checkpointing.",
        );
      const mergeStop = (await beforeIntent?.(tx)) === true;
      const current = (
        await tx.query<{ request_id: string }>(
          "select request_id::text from public.runtime_checkpoints where sandbox_id=$1 and epoch=$2 for update",
          [sandbox.id, scope.epoch],
        )
      ).rows[0];
      if (current && current.request_id !== requestId)
        throw new VaultError("conflict", "Reuse the original checkpoint request_id for this epoch.");
      const parent = (
        await tx.query<{ id: string }>(
          "select id from public.armada_access_parents where sandbox_id=$1 and kind='sandbox'",
          [sandbox.id],
        )
      ).rows[0];
      if (!current) {
        if (parent) {
          const locked = await tx.query(
            "select id from public.armada_access_parents where id=$1 for update skip locked",
            [parent.id],
          );
          if (!locked.rows.length)
            throw new VaultError("conflict", "Scoped parent authority is busy. Retry checkpoint.");
          await new DelegatedAuthority(tx, async () => {}).revoke(parent.id);
        }
        await tx.query(
          "insert into public.runtime_checkpoints(sandbox_id,epoch,request_id,merge_stop) values($1,$2,$3,$4)",
          [sandbox.id, scope.epoch, requestId, mergeStop],
        );
      }
      return {
        epoch: scope.epoch,
        current_epoch: scope.epoch,
        request_id: requestId,
        watermark: null,
        scrub: !!parent,
      };
    });
    try {
      if (intent.scrub) {
        const prefix = `scrub_checkpoint_${requestId}_`;
        const previous = (
          await sql.query<{
            request_id: string;
            sequence: string;
            result_enc: Uint8Array<ArrayBuffer> | null;
          }>(
            `select request_id,sequence::text,result_enc from public.runtime_commands
             where sandbox_id=$1 and epoch=$2 and starts_with(request_id,$3) order by sequence desc limit 1`,
            [sandbox.id, intent.epoch, prefix],
          )
        ).rows[0];
        const stored = previous?.result_enc ? JSON.parse(await decryptSecret(previous.result_enc, key)) : undefined;
        if (!stored || !scrubAcknowledged(stored, intent.epoch, previous!.request_id)) {
          const scrubId = stored ? `${prefix}${previous!.sequence}` : (previous?.request_id ?? `${prefix}0`);
          const accept = (reply: Parameters<typeof scrubAcknowledged>[0]) =>
            scrubAcknowledged(reply, intent.epoch, scrubId);
          const reply = await commands.call(
            caller.userId,
            { version: 1, sandboxId: sandbox.id, requestId: scrubId, op: "scrubOrchestratorEpoch" },
            { expectedEpoch: intent.epoch, accept },
          );
          if (!accept(reply)) throw new Error("Scoped parent scrub was not acknowledged.");
        }
      }
      await commands.call(
        caller.userId,
        { version: 1, sandboxId: sandbox.id, requestId: `checkpoint_${requestId}`, op: "checkpoint" },
        {
          expectedEpoch: intent.epoch,
          accept: (reply) => checkpointProof(reply, intent.epoch, `checkpoint_${requestId}`) !== undefined,
        },
      );
    } catch {
      throw new VaultError(
        "conflict",
        "Runtime checkpoint outcome is uncertain; reuse the original request_id or stop without claiming resume.",
      );
    }
    const completed = await finish(intent);
    if (!completed)
      throw new VaultError("conflict", "Runtime checkpoint is not yet acknowledged; reuse the original request_id.");
    return completed;
  };
}

export function createRuntimeStopCheckpoint(sql: Sql, checkpoint: RuntimeCheckpoint) {
  return async (caller: Caller, sandbox: SandboxView, onlyIfIdle: boolean) => {
    if (sandbox.ownerId !== caller.userId)
      throw new VaultError("forbidden", "Only the runtime owner may checkpoint this sandbox.");
    const current = (
      await sql.query<{ request_id: string | null; application_secret_tainted: boolean }>(
        `select p.request_id::text,s.application_secret_tainted from public.sandboxes s
         left join public.runtime_enrolments r on r.sandbox_id=s.id
         left join public.runtime_checkpoints p on p.sandbox_id=s.id and p.epoch=r.epoch
         where s.id=$1 and s.owner_id=$2 and s.org_id=$3 and s.lifecycle_generation=$4`,
        [sandbox.id, caller.userId, sandbox.orgId, sandbox.lifecycleGeneration],
      )
    ).rows[0];
    if (!current) throw new VaultError("conflict", "Sandbox changed before runtime stop.");
    if (current.application_secret_tainted) return undefined;
    return checkpoint(
      caller,
      { id: sandbox.id, request_id: current.request_id ?? crypto.randomUUID(), runtimeVersion: 1 },
      async (tx) => {
        const eligible = await tx.query(
          `select s.id from public.sandboxes s where s.id=$1 and s.lifecycle_generation=$4 and s.status in ('ready','running')
             and not s.application_secret_tainted
             and (not $2::boolean or (s.status='ready'
               and not exists(select 1 from public.account_turn_queue q where q.sandbox_id=s.id
                 and q.state in ('queued','dispatching'))
               and ($3::boolean or not exists(${unsettledRuntimeCommands("s.id", "s.lifecycle_generation")}))))`,
          [sandbox.id, onlyIfIdle, current.request_id !== null, sandbox.lifecycleGeneration],
        );
        if (!eligible.rows.length)
          throw new VaultError("conflict", "Runtime stop admission changed or work is pending.");
      },
    );
  };
}
