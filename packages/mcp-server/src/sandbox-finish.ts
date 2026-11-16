import { createHmac, timingSafeEqual } from "node:crypto";
import { DelegatedAuthorityDenied, type Sql } from "@armada/core/server";
import { createDockerHostStore } from "./docker-host-store.ts";
import { createRuntimeEnrolments, scopedRuntimeSql } from "./runtime-enrolment.ts";
import { runtimePreservationNote } from "./work-preservation.ts";

type Binding = { sandboxId: string; ownerId: string; epoch: string; generation: number };
const signature = (key: string, payload: string) =>
  createHmac("sha256", Buffer.from(key, "base64")).update(`armada/self-finish/v1:${payload}`).digest("base64url");
/** Private MCP configuration only: never an owner token or runtime session bearer. */
export function selfFinishToken(key: string, binding: Binding): string {
  const payload = Buffer.from(JSON.stringify(binding)).toString("base64url");
  return `armada_finish_${payload}.${signature(key, payload)}`;
}
function bindingFromToken(key: string, token: string): Binding {
  const match = /^armada_finish_([A-Za-z0-9_-]{1,1000})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match?.[1] || !match[2]) throw new DelegatedAuthorityDenied();
  const expected = signature(key, match[1]);
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(match[2]))) throw new DelegatedAuthorityDenied();
  const value: unknown = JSON.parse(Buffer.from(match[1], "base64url").toString());
  if (!value || typeof value !== "object") throw new DelegatedAuthorityDenied();
  const binding = value as Binding;
  if (
    typeof binding.sandboxId !== "string" ||
    typeof binding.ownerId !== "string" ||
    typeof binding.epoch !== "string" ||
    !Number.isSafeInteger(binding.generation)
  )
    throw new DelegatedAuthorityDenied();
  return binding;
}

/** Shared effect after live self authority is locked; no provider I/O on the reporting call. */
export async function requestSandboxFinish(sql: Sql, key: string, sandboxId: string, ownerId: string) {
  const row = (
    await sql.query<{ id: string; provider: string; org_id: string }>(
      `select id,provider::text,org_id from public.sandboxes
     where id=$1 and owner_id=$2 and status in ('ready','running') and stop_requested_at is null`,
      [sandboxId, ownerId],
    )
  ).rows[0];
  if (!row) throw new DelegatedAuthorityDenied();
  let preservationNote: string | undefined;
  if (row.provider === "docker") {
    preservationNote = `${await runtimePreservationNote(sql, row.id, null)} Unpushed Git work is not preserved; agent-declared completion permanently removes the Docker home volume.`;
    await sql.query("update public.sandboxes set preservation_note=$2 where id=$1", [row.id, preservationNote]);
    await createDockerHostStore(scopedRuntimeSql(sql), key).enqueueSandbox(
      { userId: ownerId, orgId: row.org_id },
      row.id,
      { requestId: crypto.randomUUID(), operation: "stop" },
    );
  }
  await sql.query(
    `update public.sandboxes set status='stopping',status_reason='agent_finished',
     stop_requested_at=coalesce(stop_requested_at,clock_timestamp()),
     stop_generation=case when stop_requested_at is null then stop_generation+1 else stop_generation end,
     lifecycle_generation=lifecycle_generation+case when provider='docker' then 0 else 1 end,
     reconcile_after=now() where id=$1`,
    [row.id],
  );
  return { id: row.id, status: "stopping", ...(preservationNote ? { preservationNote } : {}) };
}

export function createRuntimeSelfFinish(sql: Sql, key: string) {
  const authority = createRuntimeEnrolments(sql, key);
  return async (token: string) => {
    const binding = bindingFromToken(key, token);
    return authority.withOwner(binding.sandboxId, binding.ownerId, async (tx, live) => {
      if (live.epoch !== binding.epoch) throw new DelegatedAuthorityDenied();
      const current = (
        await tx.query<{ mcp_generation: number }>("select mcp_generation from public.sandboxes where id=$1", [
          binding.sandboxId,
        ])
      ).rows[0];
      if (current?.mcp_generation !== binding.generation) throw new DelegatedAuthorityDenied();
      return requestSandboxFinish(tx, key, binding.sandboxId, binding.ownerId);
    });
  };
}

/** Durable, rate-limited repair of terminal host failures; never replay an uncertain job. */
export function createFinishedDockerCleanup(sql: Sql, key: string) {
  let pending: Promise<boolean> | undefined;
  async function reconcile(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const candidate = (
      await sql.query<{ id: string }>(
        `select id from public.sandboxes where provider='docker'
         and status_reason='agent_finished' and status in ('stopping','stopped')
         and preservation_note is not null and reconcile_after<=now()
         and not exists(select 1 from public.docker_host_jobs j where j.bound_sandbox_id=sandboxes.id
           and j.bound_operation in ('stop','delete') and j.outcome is null)
         order by reconcile_after,id limit 1`,
      )
    ).rows[0];
    if (!candidate || !sql.transaction) return false;
    try {
      return await sql.transaction(async (tx) => {
        await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`finish-cleanup:${candidate.id}`]);
        const row = (
          await tx.query<{ owner_id: string; org_id: string; status: string }>(
            `select owner_id,org_id,status from public.sandboxes where id=$1 and status_reason='agent_finished'
             and status in ('stopping','stopped') and reconcile_after<=now()
             and not exists(select 1 from public.docker_host_jobs where bound_sandbox_id=$1
               and bound_operation in ('stop','delete') and outcome is null)`,
            [candidate.id],
          )
        ).rows[0];
        if (!row) return false;
        signal.throwIfAborted();
        await createDockerHostStore(scopedRuntimeSql(tx), key).enqueueSandbox(
          { userId: row.owner_id, orgId: row.org_id },
          candidate.id,
          { requestId: crypto.randomUUID(), operation: row.status === "stopped" ? "delete" : "stop" },
        );
        await tx.query("update public.sandboxes set reconcile_after=now()+interval '1 minute' where id=$1", [
          candidate.id,
        ]);
        return true;
      });
    } catch {
      // Changed authorization cannot be bypassed. Space attempts out across ticks too.
      await sql.query("update public.sandboxes set reconcile_after=now()+interval '1 minute' where id=$1", [
        candidate.id,
      ]);
      return false;
    }
  }
  return {
    async drain() {
      await pending;
    },
    reconcileOne(signal: AbortSignal): Promise<boolean> {
      if (pending) return Promise.resolve(false);
      pending = reconcile(signal).finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}
