import { createHash, randomUUID } from "node:crypto";
import {
  accountWorkingCountSql,
  decryptSecret,
  encryptSecret,
  type Harness,
  resolveModelChoice,
  type Sql,
  VaultError,
} from "@armada/core/server";
import { admitAccountCapacity } from "./account-capacity.ts";
import type { Caller } from "./caller.ts";
import type { RuntimeFollowupInput } from "./runtime-followup.ts";

const RUNTIME_REQUEST_EVIDENCE = `(s.activity_lease_id=q.request_id
  or exists(select 1 from public.runtime_commands c where c.sandbox_id=s.id and c.request_id in ('follow_'||q.request_id::text,'docker_prompt_'||q.request_id::text,'resume_'||q.request_id::text))
  or exists(select 1 from public.runtime_resumes r where r.sandbox_id=s.id and r.request_id=q.request_id)
  or exists(select 1 from public.docker_host_jobs j where j.bound_sandbox_id=s.id and j.request_id=q.request_id))`;
const RUNTIME_LANE = `(s.provider='docker' or s.boat_runtime or s.runtime_transport='dialout')`;
type Entry = {
  sequence: string;
  queued_generation: string;
  failure_reason: string | null;
  sandbox_id: string;
  request_id: string;
  account_id: string;
  owner_id: string;
  org_id: string;
  actor_epoch: string;
  credential_version: number;
  input_hash: string;
  input_enc: Uint8Array<ArrayBuffer>;
  state: string;
  result_enc: Uint8Array<ArrayBuffer> | null;
  conversation_id: string;
};
/** Durable encrypted sends. Account locking serializes FIFO admission across server replicas.
 * Native dispatches are never retried: native providers have no idempotent prompt protocol.
 * Runtime-backed lanes reconcile the same durable request under a bounded dispatch lease.
 * An uncertain dispatch retains its slot until lifecycle evidence or an owner stop resolves it. */
export function createAccountTurnQueue(sql: Sql, key: string) {
  const pending = new Set<Promise<unknown>>();
  let scanAfter = "0";
  let dispatch: ((caller: Caller, input: RuntimeFollowupInput) => Promise<unknown>) | undefined;
  async function waitingMessage(accountId: string) {
    const row = (
      await sql.query<{ name: string; max_agents: number | null; working: string }>(
        `select c.name,c.max_agents,${accountWorkingCountSql("c.id")} as working from public.credentials c where c.id=$1`,
        [accountId],
      )
    ).rows[0];
    if (row?.max_agents === null) return "Prompt accepted; waiting for sandbox dispatch, not an account slot.";
    return row
      ? `Waiting for a free agent slot on account ${row.name} (${row.working}/${row.max_agents ?? "unlimited"}).`
      : "Waiting for a free agent slot.";
  }
  async function accept(caller: Caller, input: RuntimeFollowupInput) {
    if (!input.prompt.trim()) throw new VaultError("invalid", "The prompt is empty.");
    const requestId = input.request_id?.toLowerCase() ?? randomUUID();
    const normalized = {
      id: input.id,
      request_id: requestId,
      prompt: input.prompt,
      conversation_id: input.conversation_id,
      model: input.model,
      reasoning_effort: input.reasoning_effort,
    };
    const serialized = JSON.stringify(normalized);
    const hash = createHash("sha256").update(serialized).digest("hex");
    const sealed = await encryptSecret(serialized, key);
    if (!sql.transaction) throw new VaultError("unavailable", "Transactional account admission unavailable.");
    const entry = await sql.transaction(async (tx) => {
      const target = (
        await tx.query<{
          harness: Harness;
          provider: string;
          boat_runtime: boolean;
          runtime_transport: string | null;
          model: string | null;
          reasoning_effort: string | null;
          credential_id: string | null;
          credential_version: number;
          org_id: string;
          conversation_ids: string[];
        }>(
          `select s.harness,s.provider,s.boat_runtime,s.runtime_transport,s.model,s.reasoning_effort,s.credential_id,s.credential_version,s.org_id,s.conversation_ids from public.sandboxes s
         join public.members m on m.org_id=s.org_id and m.user_id=$2
         where s.id=$1 and s.owner_id=$2 and s.deleted_at is null`,
          [input.id, caller.userId],
        )
      ).rows[0];
      if (!target || !caller.orgs.some((org) => org.orgId === target.org_id))
        throw new VaultError("not_found", "No owned sandbox.");
      if (!target.credential_id) return null;
      if (target.boat_runtime || target.runtime_transport === "dialout" || target.provider === "docker") {
        if (
          (input.model !== undefined && (target.provider !== "boat" || input.model !== target.model)) ||
          (input.reasoning_effort !== undefined &&
            (target.provider !== "boat" || input.reasoning_effort !== target.reasoning_effort))
        )
          throw new VaultError("invalid", "Runtime follow-up uses the launch model and effort.");
        if (Buffer.byteLength(input.prompt) > 262144) throw new VaultError("invalid", "The prompt is too large.");
        if (input.conversation_id !== undefined && !target.conversation_ids.includes(input.conversation_id))
          throw new VaultError("invalid", "Continue an existing runtime conversation.");
      }
      if (
        !(target.boat_runtime || target.runtime_transport === "dialout" || target.provider === "docker") &&
        (input.model !== undefined || input.reasoning_effort !== undefined)
      ) {
        resolveModelChoice(
          target.harness,
          { model: input.model, reasoningEffort: input.reasoning_effort },
          target.model && target.reasoning_effort
            ? { model: target.model, reasoningEffort: target.reasoning_effort }
            : undefined,
        );
      }
      const member = (
        await tx.query<{ epoch: string }>(
          `select e.epoch::text from public.members m join public.mcp_actor_epochs e using(org_id,user_id)
         where m.org_id=$1 and m.user_id=$2 for share of m`,
          [target.org_id, caller.userId],
        )
      ).rows[0];
      if (!member) throw new VaultError("not_found", "Sandbox membership was revoked.");
      const credential = await tx.query(
        `select id from public.credentials where id=$1 and version=$2 and status='active'
         and (expires_at is null or expires_at>now())
         and ((scope='user' and owner_id=$3) or (scope='org' and owner_id=$4)) for update`,
        [target.credential_id, target.credential_version, caller.userId, target.org_id],
      );
      if (!credential.rows.length) throw new VaultError("not_found", "Pinned account is no longer authorized.");
      let saved = (
        await tx.query<Entry>("select * from public.account_turn_queue where sandbox_id=$1 and request_id=$2", [
          input.id,
          requestId,
        ])
      ).rows[0];
      if (
        saved &&
        (saved.owner_id !== caller.userId || saved.input_hash !== hash || String(saved.actor_epoch) !== member.epoch)
      )
        throw new VaultError("conflict", "Reuse the original request_id and identical input.");
      if (!saved) {
        const sandbox = await tx.query(
          `select id from public.sandboxes where id=$1 and credential_id=$2 and credential_version=$3
           and deleted_at is null and expires_at>now() and stop_requested_at is null
           and status in ('ready','running','stopped') for update`,
          [input.id, target.credential_id, target.credential_version],
        );
        if (!sandbox.rows.length) throw new VaultError("conflict", "Sandbox cannot accept a queued prompt.");
        saved = (
          await tx.query<Entry>(
            `insert into public.account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,actor_epoch,credential_version,input_hash,input_enc,conversation_id,queued_generation)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,(select lifecycle_generation from public.sandboxes where id=$1)) returning *`,
            [
              input.id,
              requestId,
              target.credential_id,
              caller.userId,
              target.org_id,
              member.epoch,
              target.credential_version,
              hash,
              sealed,
              input.conversation_id ?? target.conversation_ids.at(-1) ?? `first_${requestId}`,
            ],
          )
        ).rows[0]!;
      }
      return saved;
    });
    if (!entry) return null;
    if (entry.result_enc) return JSON.parse(await decryptSecret(entry.result_enc, key));
    if (entry.state === "failed")
      throw new VaultError("conflict", "Queued prompt was cancelled; inspect sandbox status.");
    return {
      id: input.id,
      requestId,
      promptId: requestId,
      conversationId: entry.conversation_id,
      status: "queued" as const,
      statusMessage: await waitingMessage(entry.account_id),
    };
  }
  return {
    accept,
    async cancelQueued(caller: Caller, sandboxId: string) {
      await sql.query(
        `update public.account_turn_queue q set state='failed',failure_reason='Queued prompt was cancelled.'
        from public.sandboxes s join public.members m on m.org_id=s.org_id and m.user_id=$2
        where q.sandbox_id=s.id and s.id=$1 and s.owner_id=$2 and q.owner_id=$2 and q.state='queued'
        and s.org_id=any($3::uuid[])`,
        [sandboxId, caller.userId, caller.orgs.map((org) => org.orgId)],
      );
    },
    // Keep provider journals and accounting native; translate only at the public boundary.
    async publicPromptIdsBatch(caller: Caller, requests: { sandboxId: string; nativeIds: string[] }[]) {
      const ids = new Map<string, Map<string, string>>();
      const wanted = new Map(
        requests.filter((r) => r.nativeIds.length).map((r) => [r.sandboxId, new Set(r.nativeIds)]),
      );
      if (!wanted.size) return ids;
      const rows = (
        await sql.query<Entry>(
          `select q.* from public.account_turn_queue q
         join public.members m on m.org_id=q.org_id and m.user_id=$2
         join public.sandboxes s on s.id=q.sandbox_id
         where q.sandbox_id=any($1::uuid[]) and (s.visibility='org' or s.owner_id=$2) and q.org_id=any($3::uuid[])
         and q.result_enc is not null order by q.sequence`,
          [[...wanted.keys()], caller.userId, caller.orgs.map((org) => org.orgId)],
        )
      ).rows;
      for (const row of rows) {
        const receipt = JSON.parse(await decryptSecret(row.result_enc!, key));
        if (wanted.get(row.sandbox_id)?.has(receipt.promptId)) {
          const aliases = ids.get(row.sandbox_id) ?? new Map<string, string>();
          aliases.set(receipt.promptId, row.request_id);
          ids.set(row.sandbox_id, aliases);
        }
      }
      return ids;
    },
    async publicPromptIds(caller: Caller, sandboxId: string, nativeIds: string[]) {
      return (
        (await this.publicPromptIdsBatch(caller, [{ sandboxId, nativeIds }])).get(sandboxId) ??
        new Map<string, string>()
      );
    },
    async status(caller: Caller, sandboxId: string, promptId?: string) {
      promptId = promptId?.toLowerCase();
      const row = (
        await sql.query<Entry>(
          `select q.* from public.account_turn_queue q join public.members m on m.org_id=q.org_id and m.user_id=$2
         join public.sandboxes s on s.id=q.sandbox_id
         where q.sandbox_id=$1 and (s.visibility='org' or s.owner_id=$2) and ($3::uuid is null or q.request_id=$3::uuid)
         order by q.sequence desc limit 1`,
          [
            sandboxId,
            caller.userId,
            promptId && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(promptId) ? promptId : null,
          ],
        )
      ).rows[0];
      if (!row || !caller.orgs.some((org) => org.orgId === row.org_id) || (promptId && row.request_id !== promptId))
        return null;
      if (row.result_enc) {
        const result = JSON.parse(await decryptSecret(row.result_enc, key));
        return { nativePromptId: result.promptId as string, ...(!promptId ? { publicPromptId: row.request_id } : {}) };
      }
      return {
        requestId: row.request_id,
        conversationId: row.conversation_id,
        failed: row.state === "failed",
        message:
          row.state === "failed"
            ? (row.failure_reason ?? "Queued prompt was cancelled.")
            : row.state === "dispatching"
              ? "Prompt dispatch is pending; inspect status before sending another request."
              : await waitingMessage(row.account_id),
      };
    },
    setDispatch(value: NonNullable<typeof dispatch>) {
      dispatch = value;
    },
    async drain() {
      await Promise.allSettled([...pending]);
    },
    async reconcileOne(signal: AbortSignal) {
      if (!dispatch || pending.size >= 32 || signal.aborted) return false;
      if (!sql.transaction) throw new VaultError("unavailable", "Transactional account admission unavailable.");
      const picked = await (async () => {
        // Older replicas could leave a queued receipt after publishing its request.
        // Never replay it (especially on native providers without idempotency).
        await sql.query(`update public.account_turn_queue q set state='failed',
          failure_reason='Queued receipt already has dispatch evidence; inspect sandbox history before resending.'
          from public.sandboxes s where q.sandbox_id=s.id and q.state='queued'
          and (s.task_prompt_id=q.request_id::text or ${RUNTIME_REQUEST_EVIDENCE})`);
        await sql.query(`update public.account_turn_queue q set state='failed',
          failure_reason='Queued prompt cannot start: sandbox stopped, deleted, expired, or stopping.'
          from public.sandboxes s where q.sandbox_id=s.id and q.state='queued'
          and (s.deleted_at is not null or s.expires_at<=now() or s.stop_requested_at is not null
            or s.status not in ('ready','running','stopped')
            or (s.status='stopped' and s.lifecycle_generation<>q.queued_generation))`);
        await sql.query(`update public.account_turn_queue q set state='failed',failure_reason='Dispatch cancelled by confirmed stop.'
          from public.sandboxes s where q.sandbox_id=s.id and q.state='dispatching'
          and s.activity_lease_id is null and s.status in ('stopped','deleted') and s.lifecycle_generation>q.dispatch_generation`);
        const candidates = (
          await sql.query<Entry>(
            `select q.* from public.account_turn_queue q join public.sandboxes s on s.id=q.sandbox_id
             where (q.state='queued' or (q.state='dispatching' and q.dispatch_until<=now() and q.dispatch_generation is not null and ((${RUNTIME_LANE} and ${RUNTIME_REQUEST_EVIDENCE}) or (s.lifecycle_generation=q.dispatch_generation and s.activity_lease_id is null and not coalesce(${RUNTIME_REQUEST_EVIDENCE},false)))))
           and (exists(select 1 from public.credentials c where c.id=q.account_id and c.max_agents is null) or not exists(select 1 from public.account_turn_queue earlier where earlier.account_id=q.account_id and earlier.state='queued' and earlier.sequence<q.sequence))
           order by case when q.sequence>$1::bigint then 0 else 1 end,q.sequence limit 20`,
            [scanAfter],
          )
        ).rows;
        for (const candidate of candidates) {
          scanAfter = String(candidate.sequence);
          const recovering = candidate.state === "dispatching";
          const admitted = await sql.transaction!(async (tx) => {
            const member = (
              await tx.query<{ role: "admin" | "member"; epoch: string }>(
                `select m.role,e.epoch::text from public.members m join public.mcp_actor_epochs e using(org_id,user_id)
             where m.org_id=$1 and m.user_id=$2 for share of m`,
                [candidate.org_id, candidate.owner_id],
              )
            ).rows[0];
            await tx.query("select id from public.credentials where id=$1 for update", [candidate.account_id]);
            const current = await tx.query(
              `select q.request_id from public.account_turn_queue q where q.sandbox_id=$1 and q.request_id=$2 and q.state=$3
              and (q.state='queued' or q.dispatch_until<=now())
              and (exists(select 1 from public.credentials c where c.id=q.account_id and c.max_agents is null) or not exists(select 1 from public.account_turn_queue earlier where earlier.account_id=q.account_id and earlier.state='queued' and earlier.sequence<q.sequence)) for update of q`,
              [candidate.sandbox_id, candidate.request_id, candidate.state],
            );
            if (!current.rows.length) return null;
            if (recovering) {
              // Recheck under account, queue and sandbox locks: the discovery read may be stale.
              // Native providers cannot replay uncertain mutations, but an unchanged generation
              // with no request evidence proves the previous claim never began dispatch.
              const abandoned = await tx.query(
                `select s.id from public.sandboxes s
                 join public.account_turn_queue q on q.sandbox_id=s.id and q.request_id=$2
                 where s.id=$1 and not coalesce(${RUNTIME_LANE},false)
                 and s.lifecycle_generation=q.dispatch_generation and s.activity_lease_id is null
                 and not coalesce(${RUNTIME_REQUEST_EVIDENCE},false) for update of s`,
                [candidate.sandbox_id, candidate.request_id],
              );
              if (abandoned.rows.length) {
                await tx.query(
                  `with retried as (update public.account_turn_queue set state='queued',
                    dispatch_generation=null,dispatch_until=null,failure_reason=null
                    where sandbox_id=$1 and request_id=$2 and state='dispatching' returning sandbox_id)
                   delete from public.account_agent_reservations r using retried q where r.sandbox_id=q.sandbox_id`,
                  [candidate.sandbox_id, candidate.request_id],
                );
                return null;
              }
            }
            const valid = await tx.query<{ id: string; runtime: boolean }>(
              `select s.id,${RUNTIME_LANE} as runtime from public.sandboxes s join public.credentials c on c.id=s.credential_id
             where s.id=$1 and s.owner_id=$2 and s.org_id=$3 and s.credential_id=$4 and s.credential_version=$5
             and c.version=$5 and c.status='active' and (c.expires_at is null or c.expires_at>now())
             and ((c.scope='user' and c.owner_id=$2) or (c.scope='org' and c.owner_id=$3))
             and s.deleted_at is null and s.stop_requested_at is null and s.expires_at>now()
             and ($6::boolean or s.status<>'stopped' or s.lifecycle_generation=$7::bigint)
             and (s.status in ('ready','running','stopped') or ($6::boolean and s.status='starting')) for update of s`,
              [
                candidate.sandbox_id,
                candidate.owner_id,
                candidate.org_id,
                candidate.account_id,
                candidate.credential_version,
                recovering,
                candidate.queued_generation,
              ],
            );
            if (!member || member.epoch !== String(candidate.actor_epoch) || !valid.rows.length) {
              await tx.query(
                "update public.account_turn_queue set state='failed',failure_reason='Authorization or sandbox lifecycle changed.' where sandbox_id=$1 and request_id=$2 and state='queued'",
                [candidate.sandbox_id, candidate.request_id],
              );
              return null;
            }
            if (recovering && !valid.rows[0]!.runtime) return null;
            const busy = await tx.query(
              `select 1 from public.account_turn_queue where sandbox_id=$1 and state='dispatching'
             union all select 1 from public.sandboxes s where s.id=$1 and (s.reconcile_lease_until>now() or s.activity_lease_id is not null
             or (s.task_prompt_id is not null and s.status='running' and not exists(select 1 from public.runtime_idle_turns t where t.sandbox_id=s.id and t.prompt_id=s.task_prompt_id and t.settled))) limit 1`,
              [candidate.sandbox_id],
            );
            if (!recovering && busy.rows.length) return null;
            try {
              if (!recovering) await admitAccountCapacity(tx, candidate.account_id, candidate.sandbox_id);
              else
                await tx.query(
                  "insert into public.account_agent_reservations(sandbox_id,account_id) values($1,$2) on conflict(sandbox_id) do nothing",
                  [candidate.sandbox_id, candidate.account_id],
                );
            } catch (error) {
              if (error instanceof VaultError && error.code === "conflict") return null;
              throw error;
            }
            const claimed = await tx.query(
              "update public.account_turn_queue set dispatch_generation=case when state='queued' then (select lifecycle_generation from public.sandboxes where id=$1) else dispatch_generation end,state='dispatching',dispatch_until=now()+interval '15 minutes' where sandbox_id=$1 and request_id=$2 and state=$3 returning request_id",
              [candidate.sandbox_id, candidate.request_id, candidate.state],
            );
            if (!claimed.rows.length) return null;
            return {
              entry: candidate,
              caller: {
                userId: candidate.owner_id,
                via: "service" as const,
                orgs: [{ orgId: candidate.org_id, role: member.role }],
              },
            };
          });
          if (admitted) return admitted;
        }
        return null;
      })();
      if (!picked) return false;
      const work = (async () => {
        try {
          const input = JSON.parse(await decryptSecret(picked.entry.input_enc, key)) as RuntimeFollowupInput;
          const result = await dispatch!(picked.caller, input);
          await sql.query(
            `with admitted as (update public.account_turn_queue set state='admitted',result_enc=$3
                 where sandbox_id=$1 and request_id=$2 and state='dispatching' returning sandbox_id)
               delete from public.account_agent_reservations r using admitted a where r.sandbox_id=a.sandbox_id`,
            [input.id, picked.entry.request_id, await encryptSecret(JSON.stringify(result), key)],
          );
        } catch (error) {
          // Retry only when durable evidence proves no model mutation began. Generation/lease
          // fences native and runtime sends; journals and host jobs additionally fence Docker.
          await sql.transaction!(async (tx) => {
            await tx.query("select id from public.credentials where id=$1 for update", [picked.entry.account_id]);
            const unchanged = await tx.query(
              `select s.id from public.sandboxes s
              join public.account_turn_queue q on q.sandbox_id=s.id and q.request_id=$2
              where s.id=$1 and q.state='dispatching' and s.lifecycle_generation=q.dispatch_generation
              and s.activity_lease_id is null
              and not exists(select 1 from public.runtime_commands where sandbox_id=s.id
                and request_id in ('follow_'||$2::text,'docker_prompt_'||$2::text,'resume_'||$2::text))
              and not exists(select 1 from public.docker_host_jobs where bound_sandbox_id=s.id and request_id=$2::uuid)
              and not exists(select 1 from public.runtime_resumes where sandbox_id=s.id and request_id=$2::uuid)
              for update of s,q`,
              [picked.entry.sandbox_id, picked.entry.request_id],
            );
            if (unchanged.rows.length) {
              const retry = error instanceof VaultError && (error.code === "conflict" || error.code === "unavailable");
              await tx.query(
                `with retried as (update public.account_turn_queue set state=$3,failure_reason=$4,dispatch_generation=null,dispatch_until=null
                where sandbox_id=$1 and request_id=$2 and state='dispatching' returning sandbox_id)
                delete from public.account_agent_reservations r using retried q where r.sandbox_id=q.sandbox_id`,
                [
                  picked.entry.sandbox_id,
                  picked.entry.request_id,
                  retry ? "queued" : "failed",
                  retry
                    ? null
                    : "Queued prompt rejected before dispatch; inspect sandbox and account settings before resending.",
                ],
              );
            } else {
              // No raw exception text: provider diagnostics may contain credentials.
              await tx.query(
                `update public.account_turn_queue q set failure_reason='Dispatch outcome uncertain; inspect status.',
                 dispatch_until=case when ${RUNTIME_LANE} and ${RUNTIME_REQUEST_EVIDENCE} then now() else q.dispatch_until end
                 from public.sandboxes s where s.id=q.sandbox_id and q.sandbox_id=$1 and q.request_id=$2 and q.state='dispatching'`,
                [picked.entry.sandbox_id, picked.entry.request_id],
              );
            }
          });
        }
      })();
      pending.add(work);
      void work.finally(() => pending.delete(work));
      return true;
    },
  };
}
export type AccountTurnQueue = ReturnType<typeof createAccountTurnQueue>;
