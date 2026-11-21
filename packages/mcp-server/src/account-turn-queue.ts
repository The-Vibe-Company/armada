import { createHash, randomUUID } from "node:crypto";
import {
  ACCOUNT_WORKING_PREDICATE,
  accountWorkingCountSql,
  decryptSecret,
  encryptSecret,
  type Harness,
  resolveModelChoice,
  type Sql,
  VaultError,
} from "@armada/core/server";
import {
  admitAccountTurn,
  DISPATCHING_TURN_CANCELLED,
  type DispatchTurn,
  dispatchAccountTurn,
  NATIVE_DISPATCH_UNCERTAIN,
  QUEUED_DISPATCH_EVIDENCE,
  QUEUED_TURN_CANCELLED,
  TURN_FIFO_ELIGIBLE,
  TURN_RECOVERY_ELIGIBLE,
  UNCERTAIN_DISPATCH_MESSAGE,
  UNSETTLED_TASK,
} from "./account-turn-dispatch.ts";
import type { Caller } from "./caller.ts";
import { DOCKER_SEND_REFUSAL, DOCKER_SEND_REQUEST } from "./docker-send-request-schema.ts";
import { assertModalLaunchSetup, MODAL_LAUNCH_SETUP_STATE } from "./jobs/modal-launch-setup.ts";
import type { JobContext } from "./jobs/runner.ts";
import { createJobsStore } from "./jobs/store.ts";
import { queuedPromptAliases } from "./queued-prompt-ids.ts";
import { currentRequestId } from "./request-observability.ts";
import type { RuntimeFollowupInput } from "./runtime-followup.ts";
import { sandboxControlRefusal } from "./sandbox-control-refusal.ts";
import { ToolError } from "./tool-error.ts";

type Entry = {
  model: string | null;
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
type DispatchJobEntry = Pick<Entry, "sandbox_id" | "request_id" | "org_id" | "queued_generation">;
const DISPATCH_JOB_BACKFILL_BATCH = 20;

/** Durable encrypted sends. Account locking serializes FIFO admission across server replicas.
 * Native dispatches are never retried: native providers have no idempotent prompt protocol.
 * Runtime-backed lanes reconcile the same durable request under a bounded dispatch lease.
 * An uncertain dispatch retains its slot until lifecycle evidence or an owner stop resolves it. */
export function createAccountTurnQueue(sql: Sql, key: string) {
  const jobs = createJobsStore(sql, key);
  const pending = new Set<Promise<unknown>>();
  let scanAfter = "0";
  let backfillRange: { after: string; through: string | null } = { after: "0", through: null };
  let dispatch: DispatchTurn | undefined;
  function enqueueDispatchJob(entry: DispatchJobEntry, tx?: Sql) {
    return jobs.enqueue(
      "turn_dispatch",
      entry.sandbox_id,
      Number(entry.queued_generation),
      entry.request_id,
      { requestId: entry.request_id },
      { orgId: entry.org_id, maxAttempts: 3 },
      tx,
    );
  }
  async function backfillDispatchJobs(signal: AbortSignal) {
    // WARNING: Match the producer's compact key with queued_generation, since the job generation can advance.
    const { rows } = await sql.query<DispatchJobEntry & { sequence: string; through: string; missing_job: boolean }>(
      `with sweep as (
         select coalesce($3::bigint,(select max(sequence) from public.account_turn_queue)) as through
       )
       select q.sandbox_id,q.request_id,q.org_id,q.queued_generation::text,q.sequence::text,sweep.through::text,
       case when q.state in ('queued','dispatching') then not exists (
         select 1 from public.jobs j where j.idem_key =
           format('["internal","%s","turn_dispatch","%s",%s,"%s"]',q.org_id,q.sandbox_id,q.queued_generation,q.request_id)
       ) else false end as missing_job
       from sweep cross join lateral (
         select sandbox_id,request_id,org_id,queued_generation,sequence,state
         from public.account_turn_queue where sequence>$1::bigint and sequence<=sweep.through
         order by sequence limit $2
       ) q order by q.sequence`,
      [backfillRange.after, DISPATCH_JOB_BACKFILL_BATCH, backfillRange.through],
    );
    const last = rows.at(-1);
    backfillRange =
      last && rows.length === DISPATCH_JOB_BACKFILL_BATCH && last.sequence !== last.through
        ? { after: last.sequence, through: last.through }
        : { after: "0", through: null };
    for (const entry of rows) {
      if (signal.aborted) return;
      if (entry.missing_job) await enqueueDispatchJob(entry);
    }
  }

  async function waitingMessage(accountId: string, sandboxId: string, requestId: string) {
    const row = (
      await sql.query<{
        name: string;
        max_agents: number | null;
        model: string | null;
        model_limit: number | null;
        model_working: string;
        working: string;
        busy: boolean;
        has_slot: boolean;
      }>(
        `select c.name,c.max_agents,coalesce(q.model,s.model) as model,(c.model_limits->>coalesce(q.model,s.model))::integer as model_limit,${accountWorkingCountSql("c.id", "$2", "q.model")} as model_working,${accountWorkingCountSql("c.id")} as working,
          (s.reconcile_lease_until>now() or s.activity_lease_id is not null
            or (${UNSETTLED_TASK})
            or exists(select 1 from public.account_turn_queue active where active.sandbox_id=s.id and active.state='dispatching')) as busy,
          ((${ACCOUNT_WORKING_PREDICATE}) or exists(
            select 1 from public.account_agent_reservations r where r.sandbox_id=s.id and r.account_id=c.id)) as has_slot
          from public.credentials c join public.sandboxes s on s.credential_id=c.id left join public.account_turn_queue q on q.sandbox_id=s.id and q.request_id=$3::uuid where c.id=$1 and s.id=$2`,
        [accountId, sandboxId, requestId],
      )
    ).rows[0];
    if (row?.busy) return "Prompt accepted; waiting for the current sandbox turn or dispatch to finish.";
    if (row && row.max_agents !== null && !row.has_slot && Number(row.working) >= row.max_agents)
      return `Waiting for a free agent slot on account ${row.name} (${row.working}/${row.max_agents}).`;
    if (row && row.model_limit != null && !row.has_slot && Number(row.model_working) >= row.model_limit)
      return `Waiting for a free agent slot for model ${row.model} on account ${row.name} (${row.model_working}/${row.model_limit}).`;
    return "Prompt accepted; waiting for sandbox dispatch, not an account slot.";
  }
  async function persist(
    caller: Caller,
    input: RuntimeFollowupInput & { request_id: string },
    initialLaunch?: { generation: string; canDispatch: JobContext["canDispatch"] },
  ) {
    const requestId = input.request_id;
    const normalized = {
      id: input.id,
      request_id: requestId,
      prompt: input.prompt,
      model: input.model,
      reasoning_effort: input.reasoning_effort,
    };
    const serialized = JSON.stringify(normalized);
    const hash = createHash("sha256").update(serialized).digest("hex");
    // The first insert owns correlation. Keep it outside the idempotency hash.
    const sealed = await encryptSecret(JSON.stringify({ ...normalized, correlationId: currentRequestId() }), key);
    if (!sql.transaction) throw new VaultError("unavailable", "Transactional account admission unavailable.");
    return sql.transaction(async (tx) => {
      const target = (
        await tx.query<{
          status: string;
          status_reason: string | null;
          preservation_note: string | null;
          expires_at: string | null;
          harness: Harness;
          provider: string;
          boat_runtime: boolean;
          runtime_transport: string | null;
          model: string | null;
          reasoning_effort: string | null;
          credential_id: string | null;
          credential_version: number;
          org_id: string;
          launch_setup_state: string | null;
        }>(
          `select s.status,s.status_reason,s.preservation_note,s.expires_at,s.harness,s.provider,s.boat_runtime,
                  s.runtime_transport,s.model,s.reasoning_effort,s.credential_id,s.credential_version,s.org_id,
                  case when s.provider='modal' and not $3::boolean then ${MODAL_LAUNCH_SETUP_STATE} end as launch_setup_state
           from public.sandboxes s
           join public.members m on m.org_id=s.org_id and m.user_id=$2
           where s.id=$1 and s.owner_id=$2 and s.deleted_at is null`,
          [input.id, caller.userId, initialLaunch !== undefined],
        )
      ).rows[0];
      if (!target || !caller.orgs.some((org) => org.orgId === target.org_id))
        throw new VaultError("not_found", "No owned sandbox.");
      const refusal = sandboxControlRefusal(
        {
          ...target,
          statusReason: target.status_reason,
          preservationNote: target.preservation_note,
          expiresAt: target.expires_at,
          boatRuntime: target.boat_runtime,
          runtimeTransport: target.runtime_transport,
        },
        new Date(),
      );
      if (refusal) throw new VaultError("conflict", refusal);
      assertModalLaunchSetup(target.launch_setup_state);
      // Docker admission rules apply to the normalized request before anything is persisted. A keyless
      // send keeps its server-generated request_id, as installed clients (earlier iOS builds) rely on.
      if (target.provider === "docker" && !DOCKER_SEND_REQUEST.safeParse(normalized).success)
        throw new ToolError("invalid_request", DOCKER_SEND_REFUSAL);
      if (!input.prompt.trim()) throw new VaultError("invalid", "The prompt is empty.");
      if (!target.credential_id) return null;
      if (target.boat_runtime || target.runtime_transport === "dialout" || target.provider === "docker") {
        if (
          (input.model !== undefined && (target.provider !== "boat" || input.model !== target.model)) ||
          (input.reasoning_effort !== undefined &&
            (target.provider !== "boat" || input.reasoning_effort !== target.reasoning_effort))
        )
          throw new VaultError("invalid", "Runtime follow-up uses the launch model and effort.");
        if (Buffer.byteLength(input.prompt) > 262144) throw new VaultError("invalid", "The prompt is too large.");
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
      if (initialLaunch) {
        const { rows: sandboxes } = await tx.query(
          `select id from public.sandboxes
           where id=$1 and lifecycle_generation=$2 and org_id=$3 and owner_id=$4
             and provider='modal' and runtime_transport='dialout' and provider_sandbox_id is not null
             and status in ('ready','running') and stop_requested_at is null and deleted_at is null
             and expires_at>clock_timestamp() for update`,
          [input.id, initialLaunch.generation, target.org_id, caller.userId],
        );
        if (!sandboxes.length) return null;
        // WARNING: Read after locking because ticket rotation can change the receipt without updating the sandbox.
        const { rows: enrolled } = await tx.query(
          `select sandbox_id from public.runtime_enrolments
           where sandbox_id=$1 and lifecycle_generation=$2 and runtime_hash is not null`,
          [input.id, initialLaunch.generation],
        );
        if (!enrolled.length || !(await initialLaunch.canDispatch(tx))) return null;
      }
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
        const sandbox = await tx.query<Record<string, unknown> & { conversation_ids: string[] }>(
          `select id,status,provider,status_reason,preservation_note,expires_at,boat_runtime,runtime_transport,conversation_ids from public.sandboxes where id=$1 and credential_id=$2 and credential_version=$3
           and deleted_at is null and expires_at>now() and stop_requested_at is null
           and status in ('ready','running','stopped') for update`,
          [input.id, target.credential_id, target.credential_version],
        );
        const locked = sandbox.rows[0];
        if (!locked) throw new VaultError("conflict", "Sandbox cannot accept a queued prompt.");
        if (locked.status !== "stopped") {
          const checkpoint = (
            await tx.query<{ merge_stop: boolean }>(
              `select p.merge_stop from public.runtime_checkpoints p join public.runtime_enrolments r
               on r.sandbox_id=p.sandbox_id and r.epoch=p.epoch where p.sandbox_id=$1`,
              [input.id],
            )
          ).rows[0];
          if (checkpoint)
            throw new VaultError(
              "conflict",
              checkpoint.merge_stop
                ? "Sandbox is stopping after its pull requests were merged."
                : "Sandbox is checkpointing. Wait for a confirmed retained stop before sending.",
            );
        }
        const lockedRefusal = sandboxControlRefusal(
          {
            status: String(locked.status),
            provider: String(locked.provider),
            statusReason: locked.status_reason as string | null,
            preservationNote: locked.preservation_note as string | null,
            expiresAt: locked.expires_at as string | null,
            boatRuntime: !!locked.boat_runtime,
            runtimeTransport: locked.runtime_transport as string | null,
          },
          new Date(),
        );
        if (lockedRefusal) throw new VaultError("conflict", lockedRefusal);
        const currentConversation = locked.conversation_ids.at(-1);
        saved = (
          await tx.query<Entry>(
            `insert into public.account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,actor_epoch,credential_version,input_hash,input_enc,conversation_id,model,queued_generation)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,(select lifecycle_generation from public.sandboxes where id=$1)) returning *`,
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
              currentConversation ?? `first_${requestId}`,
              input.model ?? target.model,
            ],
          )
        ).rows[0]!;
        await enqueueDispatchJob(saved, tx);
        if (initialLaunch && !(await initialLaunch.canDispatch(tx)))
          throw new Error("Modal initial turn lost its job lease before queue commit.");
      }
      return saved;
    });
  }
  async function accept(caller: Caller, input: RuntimeFollowupInput) {
    const requestId = input.request_id?.toLowerCase() ?? randomUUID();
    const entry = await persist(caller, { ...input, request_id: requestId });
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
      statusMessage: await waitingMessage(entry.account_id, input.id, entry.request_id),
    };
  }
  return {
    accept,
    async acceptInitialLaunch(
      caller: Caller,
      input: { id: string; request_id: string; prompt: string },
      generation: string,
      canDispatch: JobContext["canDispatch"],
    ) {
      return Boolean(await persist(caller, input, { generation, canDispatch }));
    },
    async cancelQueued(caller: Caller, sandboxId: string) {
      await sql.query(
        `update public.account_turn_queue q set state='failed',failure_reason='Queued prompt was cancelled.'
        from public.sandboxes s join public.members m on m.org_id=s.org_id and m.user_id=$2
        where q.sandbox_id=s.id and s.id=$1 and s.owner_id=$2 and q.owner_id=$2 and q.state in ('queued','dispatching')
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
      for (const sandboxId of wanted.keys()) {
        const aliases = await queuedPromptAliases(
          rows.filter((row) => row.sandbox_id === sandboxId),
          key,
        );
        ids.set(sandboxId, new Map([...aliases].filter(([nativeId]) => wanted.get(sandboxId)?.has(nativeId))));
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
              : await waitingMessage(row.account_id, row.sandbox_id, row.request_id),
      };
    },
    setDispatch(value: NonNullable<typeof dispatch>) {
      dispatch = value;
    },
    backfillDispatchJobs,
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
          and ${QUEUED_DISPATCH_EVIDENCE}`);
        await sql.query(`update public.account_turn_queue q set state='failed',
          failure_reason='Queued prompt cannot start: sandbox stopped, deleted, expired, or stopping.'
          from public.sandboxes s where q.sandbox_id=s.id and q.state='queued'
          and ${QUEUED_TURN_CANCELLED}`);
        await sql.query(`update public.account_turn_queue q set state='failed',failure_reason='Dispatch cancelled by confirmed stop.'
          from public.sandboxes s where q.sandbox_id=s.id and q.state='dispatching'
          and ${DISPATCHING_TURN_CANCELLED}`);
        // Native admission advances the generation before calling the provider. An expired
        // changed-generation claim is uncertain, never safe to replay or leave dispatching.
        await sql.query(`update public.account_turn_queue q set state='failed',dispatch_until=null,
          failure_reason='${UNCERTAIN_DISPATCH_MESSAGE}'
          from public.sandboxes s where s.id=q.sandbox_id and q.state='dispatching'
          and q.dispatch_until<=now() and ${NATIVE_DISPATCH_UNCERTAIN}`);
        const candidates = (
          await sql.query<Entry>(
            `select q.* from public.account_turn_queue q join public.sandboxes s on s.id=q.sandbox_id
             where (q.state='queued' or (q.state='dispatching' and ${TURN_RECOVERY_ELIGIBLE}))
           and ${TURN_FIFO_ELIGIBLE}
           order by case when q.sequence>$1::bigint then 0 else 1 end,q.sequence limit 20`,
            [scanAfter],
          )
        ).rows;
        for (const candidate of candidates) {
          scanAfter = String(candidate.sequence);
          const admitted = await admitAccountTurn(sql, candidate);
          if (admitted) return admitted;
        }
        return null;
      })();
      if (!picked) return false;
      const work = dispatchAccountTurn(sql, key, picked.entry, picked.caller, dispatch);
      pending.add(work);
      void work.finally(() => pending.delete(work));
      return true;
    },
  };
}
export type AccountTurnQueue = ReturnType<typeof createAccountTurnQueue>;
