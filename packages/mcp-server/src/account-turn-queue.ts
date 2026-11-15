import { createHash, randomUUID } from "node:crypto";
import { accountWorkingCountSql, decryptSecret, encryptSecret, type Sql, VaultError } from "@armada/core/server";
import { admitAccountCapacity } from "./account-capacity.ts";
import type { Caller } from "./caller.ts";
import type { RuntimeFollowupInput } from "./runtime-followup.ts";

type Entry = {
  sequence: string;
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
 * Dispatching is deliberately not retried: native providers have no idempotent prompt protocol.
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
          `select s.provider,s.boat_runtime,s.runtime_transport,s.model,s.reasoning_effort,s.credential_id,s.credential_version,s.org_id,s.conversation_ids from public.sandboxes s
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
            `insert into public.account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,actor_epoch,credential_version,input_hash,input_enc,conversation_id)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
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
    async status(caller: Caller, sandboxId: string, promptId?: string) {
      promptId = promptId?.toLowerCase();
      const row = (
        await sql.query<Entry>(
          `select q.* from public.account_turn_queue q join public.members m on m.org_id=q.org_id and m.user_id=$2
         where q.sandbox_id=$1 and q.owner_id=$2 and ($3::uuid is null and q.state in ('queued','dispatching') or q.request_id=$3::uuid)
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
        return { nativePromptId: result.promptId as string };
      }
      return {
        requestId: row.request_id,
        conversationId: row.conversation_id,
        failed: row.state === "failed",
        message:
          row.state === "dispatching"
            ? "Prompt dispatch is pending; uncertain outcomes are not retried."
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
      if (!dispatch || pending.size || signal.aborted) return false;
      if (!sql.transaction) throw new VaultError("unavailable", "Transactional account admission unavailable.");
      const picked = await (async () => {
        await sql.query(`update public.account_turn_queue q set state='failed',failure_reason='Dispatch cancelled by confirmed stop.'
          from public.sandboxes s where q.sandbox_id=s.id and q.state='dispatching'
          and s.activity_lease_id is null and s.status in ('stopped','deleted') and s.lifecycle_generation>q.dispatch_generation`);
        const candidates = (
          await sql.query<Entry>(
            `select q.* from public.account_turn_queue q where q.state='queued'
           and not exists(select 1 from public.account_turn_queue earlier where earlier.account_id=q.account_id and earlier.state='queued' and earlier.sequence<q.sequence)
           order by case when q.sequence>$1::bigint then 0 else 1 end,q.sequence limit 20`,
            [scanAfter],
          )
        ).rows;
        for (const candidate of candidates) {
          scanAfter = String(candidate.sequence);
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
              `select q.request_id from public.account_turn_queue q where q.sandbox_id=$1 and q.request_id=$2 and q.state='queued'
              and not exists(select 1 from public.account_turn_queue earlier where earlier.account_id=q.account_id and earlier.state='queued' and earlier.sequence<q.sequence) for update of q`,
              [candidate.sandbox_id, candidate.request_id],
            );
            if (!current.rows.length) return null;
            const valid = await tx.query<{ id: string; commands: string; host_jobs: string; resumes: string }>(
              `select s.id,
             coalesce((select max(sequence) from public.runtime_commands where sandbox_id=s.id),0)::text as commands,
             coalesce((select max(position) from public.docker_host_jobs where bound_sandbox_id=s.id),0)::text as host_jobs,
             (select count(*) from public.runtime_resumes where sandbox_id=s.id)::text as resumes from public.sandboxes s join public.credentials c on c.id=s.credential_id
             where s.id=$1 and s.owner_id=$2 and s.org_id=$3 and s.credential_id=$4 and s.credential_version=$5
             and c.version=$5 and c.status='active' and (c.expires_at is null or c.expires_at>now())
             and ((c.scope='user' and c.owner_id=$2) or (c.scope='org' and c.owner_id=$3))
             and s.deleted_at is null and s.stop_requested_at is null and s.expires_at>now()
             and s.status in ('ready','running','stopped') for update of s`,
              [
                candidate.sandbox_id,
                candidate.owner_id,
                candidate.org_id,
                candidate.account_id,
                candidate.credential_version,
              ],
            );
            if (!member || member.epoch !== String(candidate.actor_epoch) || !valid.rows.length) {
              await tx.query(
                "update public.account_turn_queue set state='failed',failure_reason='Authorization or sandbox lifecycle changed.' where sandbox_id=$1 and request_id=$2 and state='queued'",
                [candidate.sandbox_id, candidate.request_id],
              );
              return null;
            }
            const busy = await tx.query(
              `select 1 from public.account_turn_queue where sandbox_id=$1 and state='dispatching'
             union all select 1 from public.sandboxes s where s.id=$1 and (s.reconcile_lease_until>now() or s.activity_lease_id is not null
             or (s.task_prompt_id is not null and s.status='running' and not exists(select 1 from public.runtime_idle_turns t where t.sandbox_id=s.id and t.prompt_id=s.task_prompt_id and t.settled))) limit 1`,
              [candidate.sandbox_id],
            );
            if (busy.rows.length) return null;
            try {
              await admitAccountCapacity(tx, candidate.account_id, candidate.sandbox_id);
            } catch (error) {
              if (error instanceof VaultError && error.code === "conflict") return null;
              throw error;
            }
            const claimed = await tx.query(
              "update public.account_turn_queue set state='dispatching',dispatch_generation=(select lifecycle_generation from public.sandboxes where id=$1) where sandbox_id=$1 and request_id=$2 and state='queued' returning request_id",
              [candidate.sandbox_id, candidate.request_id],
            );
            if (!claimed.rows.length) return null;
            return {
              entry: candidate,
              before: valid.rows[0]!,
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
        } catch {
          // Retry only when durable evidence proves no model mutation began. Generation/lease
          // fences native and runtime sends; journals and host jobs additionally fence Docker.
          await sql.transaction!(async (tx) => {
            await tx.query("select id from public.credentials where id=$1 for update", [picked.entry.account_id]);
            const unchanged = await tx.query(
              `select s.id from public.sandboxes s
              join public.account_turn_queue q on q.sandbox_id=s.id and q.request_id=$2
              where s.id=$1 and q.state='dispatching' and s.lifecycle_generation=q.dispatch_generation
              and s.activity_lease_id is null
              and coalesce((select max(sequence) from public.runtime_commands where sandbox_id=s.id),0)=$3::bigint
              and coalesce((select max(position) from public.docker_host_jobs where bound_sandbox_id=s.id),0)=$4::bigint
              and (select count(*) from public.runtime_resumes where sandbox_id=s.id)=$5::bigint
              for update of s,q`,
              [
                picked.entry.sandbox_id,
                picked.entry.request_id,
                picked.before.commands,
                picked.before.host_jobs,
                picked.before.resumes,
              ],
            );
            if (unchanged.rows.length) {
              await tx.query(
                `with retried as (update public.account_turn_queue set state='queued',failure_reason=null,dispatch_generation=null
                where sandbox_id=$1 and request_id=$2 and state='dispatching' returning sandbox_id)
                delete from public.account_agent_reservations r using retried q where r.sandbox_id=q.sandbox_id`,
                [picked.entry.sandbox_id, picked.entry.request_id],
              );
            } else {
              // No raw exception text: provider diagnostics may contain credentials.
              await tx.query(
                "update public.account_turn_queue set failure_reason='Dispatch outcome uncertain; inspect or stop the sandbox before sending again.' where sandbox_id=$1 and request_id=$2 and state='dispatching'",
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
