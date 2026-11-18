import type { ForkRequest, LaunchOptions, MemberRole, Provider, ProviderTarget, Sql } from "@armada/core";
import {
  decryptSecret,
  encryptSecret,
  isNonMutatingProviderRefusal,
  LaunchError,
  ProviderError,
  recordLaunchStageSql,
  SANDBOX_STOP_MARGIN_SECONDS,
} from "@armada/core/server";
import { insertGoldenOperationFence } from "../../core/src/golden-store.ts";
import type { Caller } from "./caller.ts";
import { createSqlData } from "./data.ts";
import { INTERRUPTED_LAUNCH_REASON } from "./turns.ts";

type Boot = NonNullable<LaunchOptions["modalBoot"]>;
type Machine = Awaited<ReturnType<Provider["fork"]>>;
type PinnedFork = {
  request: ForkRequest;
  target: ProviderTarget;
  runtime: boolean;
  backendId: string;
  management: { scope: "org" | "user"; ownerId: string };
};
type BootFailure = {
  code: ProviderError["code"];
  status?: number;
  retryable: boolean;
  retryAfterSeconds?: number;
};
type Outcome = { expiresAt: string | null } | { refusal: BootFailure } | { reason: string; cancelled?: true };
type Claim = {
  sandbox_id: string;
  lease_epoch: string;
  request_enc: Uint8Array<ArrayBuffer>;
  phase: "queued" | "booting" | "cleanup_pending";
  org_id: string;
  owner_id: string;
  provider_sandbox_id: string;
  remaining_ms: number;
};
const DEADLINE_MS = 15 * 60_000;
const MAX_CONCURRENT_BOOTS = 4;
const CLEANUP_ATTEMPT_MS = 30_000;
const BOOT_ALLOWED = `s.status='starting' and s.stop_requested_at is null
  and (s.credential_id is null or exists(select 1 from public.credentials c
    where c.id=s.credential_id and c.version=s.credential_version and c.status='active'
    and (c.expires_at is null or c.expires_at>now())
    and ((c.scope='user' and c.owner_id=s.owner_id) or (c.scope='org' and c.owner_id=s.org_id))))`;

export function createModalBootWorker(
  sql: Sql,
  encryptionKey: string | undefined,
  resolve: (target: ProviderTarget, caller: Caller, runtime: boolean) => Promise<Provider>,
) {
  const owner = crypto.randomUUID();
  let accepting = true;
  const inFlight = new Set<Promise<void>>();
  async function admit({ actor, golden, provider, runtime, request, sandbox }: Parameters<Boot>[0]) {
    if (!accepting) throw new LaunchError("invalid_request", "This server is draining. Retry on another instance.");
    const backendId = (await provider.backendIdentity?.())?.id;
    const management = await provider.managementIdentity?.();
    if (!backendId || !management || !sandbox.activityLeaseId)
      throw new LaunchError("invalid_request", "Modal boot cannot pin allocation authority.");
    const target: ProviderTarget = {
      provider: "modal",
      orgId: actor.orgId,
      visibility: golden.visibility,
      modal: golden.modal,
    };
    const pinned: PinnedFork = {
      request: { ...request, idempotencyKey: sandbox.id, modalLaunchId: sandbox.id },
      target,
      runtime,
      backendId,
      management,
    };
    const sealed = await encryptSecret(JSON.stringify(pinned), encryptionKey);
    const caller: Caller = {
      userId: actor.userId,
      orgs: [{ orgId: actor.orgId, role: actor.role }],
      via: "service",
    };
    return sql.transaction!(async (tx) => {
      if (!accepting) throw new LaunchError("invalid_request", "This server is draining. Retry on another instance.");
      const member = (
        await tx.query<{ epoch: string }>(
          `select e.epoch::text from public.members m join public.mcp_actor_epochs e using(org_id,user_id)
         where m.org_id=$1 and m.user_id=$2 for share of m`,
          [actor.orgId, actor.userId],
        )
      ).rows[0];
      if (!member) throw new LaunchError("invalid_request", "Modal launch membership was revoked.");
      // Keyed ordinary callers have already claimed their public receipt. Keyless REST
      // still needs a receipt for the request FK, but never exposes its generated key.
      await tx.query(
        `insert into public.ordinary_launch_receipts(id,org_id,owner_id,request_key,fingerprint,authority)
         values($1,$2,$3,$4,'internal-modal-boot',$5::jsonb) on conflict (id) do nothing`,
        [sandbox.id, actor.orgId, actor.userId, crypto.randomUUID(), JSON.stringify({ target, backendId, management })],
      );
      const fenceId = await insertGoldenOperationFence(tx, golden.id, {
        snapshotId: golden.providerSnapshotId,
        sandboxId: golden.providerSandboxId,
        kind: "launch",
      });
      const saved = await createSqlData(tx)(caller).sandboxes.insert(sandbox);
      await tx.query(
        `insert into public.provider_launch_requests(sandbox_id,actor_epoch,request_enc,fence_id,dispatch_deadline,correlation_id)
         values($1,$2,$3,$4,clock_timestamp()+$5::integer*interval '1 millisecond',$1)`,
        [sandbox.id, member.epoch, sealed, fenceId, DEADLINE_MS],
      );
      // Rolling readers also honor the ordinary activity lease. Leave enough
      // time for the worker to reach its dispatch deadline.
      await tx.query(
        `update public.sandboxes s set activity_until=r.dispatch_deadline
         from public.provider_launch_requests r where s.id=$1 and r.sandbox_id=s.id`,
        [sandbox.id],
      );
      return saved;
    });
  }

  async function waitForBoot(record: Awaited<ReturnType<typeof admit>>): ReturnType<Boot> {
    // Public launch remains synchronous. A process lost here leaves only the
    // caller's initialization interrupted; a successor still owns the boot row.
    const deadline = performance.now() + DEADLINE_MS + 5_000;
    while (accepting && performance.now() < deadline) {
      const result = (
        await sql.query<{ outcome: Outcome | null; expires_at: string | Date; handoff: boolean }>(
          `select r.outcome,s.expires_at,(${BOOT_ALLOWED} and s.activity_until>clock_timestamp()
           and s.lifecycle_generation=$2 and exists(
             select 1 from public.members m join public.mcp_actor_epochs e using(org_id,user_id)
             where m.org_id=s.org_id and m.user_id=s.owner_id and e.epoch=r.actor_epoch
           )) as handoff from public.provider_launch_requests r
         join public.sandboxes s on s.id=r.sandbox_id where r.sandbox_id=$1`,
          [record.id, record.lifecycleGeneration ?? 1],
        )
      ).rows[0];
      const outcome = result?.outcome;
      if (result?.handoff && outcome && "expiresAt" in outcome) {
        return {
          id: record.providerSandboxId,
          ...(outcome.expiresAt ? { expiresAt: new Date(outcome.expiresAt) } : {}),
          sandbox: { ...record, expiresAt: new Date(result.expires_at).toISOString() },
        };
      }
      if (outcome && "refusal" in outcome)
        throw new ProviderError({
          provider: "modal",
          message: "Modal refused the sandbox allocation.",
          ...outcome.refusal,
        });
      if (outcome) break;
      await Bun.sleep(500);
    }
    throw new LaunchError(
      "outcome_unknown",
      "Modal boot outcome is unknown. Inspect the launch receipt before retrying.",
      {
        sandboxId: record.id,
      },
    );
  }

  async function settle(claim: Claim, outcome: Outcome, needsCleanup: boolean) {
    const { sandbox_id: id, lease_epoch: epoch } = claim;
    const bootExpiry = "expiresAt" in outcome ? outcome.expiresAt : undefined;
    const succeeded = bootExpiry !== undefined;
    const cancelled = "reason" in outcome && outcome.cancelled === true;
    const cleanupConfirmed = claim.phase === "cleanup_pending" && !needsCleanup;
    let recoveryInput: Uint8Array<ArrayBuffer> | null = null;
    if (needsCleanup) {
      const pinned = JSON.parse(await decryptSecret(claim.request_enc, encryptionKey)) as PinnedFork;
      delete pinned.request.env;
      recoveryInput = await encryptSecret(JSON.stringify(pinned), encryptionKey);
    }
    const published = await sql.transaction!(async (tx) => {
      await tx.query("select id from public.sandboxes where id=$1 for update", [id]);
      const row = (
        await tx.query<{ fence_id: string | null; actor_epoch: string; dispatch_deadline: Date }>(
          `select fence_id,actor_epoch::text,dispatch_deadline
         from public.provider_launch_requests where sandbox_id=$1 and lease_owner=$2
         and lease_epoch=$3 and lease_expires_at>clock_timestamp() for update`,
          [id, owner, epoch],
        )
      ).rows[0];
      if (!row) return false;
      const updated = await tx.query(
        `update public.sandboxes s set
           expires_at=case when $2 then least(clock_timestamp()+effective_ttl_seconds*interval '1 second',
             coalesce($3::timestamptz-$4::integer*interval '1 second','infinity'::timestamptz)) else expires_at end,
           activity_until=case when $2 then now()+interval '2 minutes' else null end,
           activity_lease_id=case when $2 then activity_lease_id else null end,
           stopped_at=case when $5 or $6 then clock_timestamp() else stopped_at end,
           stop_requested_at=case when $5 then null else stop_requested_at end,
           status=case when $5 then 'stopped'::public.sandbox_status when $2 then status else 'failed'::public.sandbox_status end,
           status_reason=case when $5 then null when $2 then status_reason else $7 end,
           reconcile_after=now()
         where id=$1 and ((status='starting' and stop_requested_at is null and
           (not $2 or ($8::timestamptz>clock_timestamp() and ${BOOT_ALLOWED} and exists(
             select 1 from public.members m join public.mcp_actor_epochs e using(org_id,user_id)
             where m.org_id=s.org_id and m.user_id=s.owner_id and e.epoch=$9
           ))))
           or ($5 and status='stopping' and stop_requested_at is not null)
           or ($6 and status='failed' and stopped_at is null)) returning id`,
        [
          id,
          succeeded,
          bootExpiry ?? null,
          SANDBOX_STOP_MARGIN_SECONDS,
          cancelled,
          cleanupConfirmed,
          needsCleanup ? INTERRUPTED_LAUNCH_REASON : "Modal allocation did not complete.",
          row.dispatch_deadline,
          row.actor_epoch,
        ],
      );
      // The launch lost authority after the dispatch intent. Keep the pinned
      // request so the next claim can clean up under the original authority.
      if (succeeded && !updated.rows.length) {
        await tx.query(
          `update public.provider_launch_requests set lease_owner=null,lease_expires_at=null,next_attempt_at=now()
           where sandbox_id=$1`,
          [id],
        );
        return false;
      }
      // A committed child pins the exact image through Modal's image GC even
      // when its physical create outcome is uncertain. Cleanup keeps its own
      // request and lease, so an unresolved create need not block the golden.
      const hasImagePin =
        needsCleanup &&
        row.fence_id &&
        (
          await tx.query(
            `select 1 from public.modal_machines m join public.golden_operation_fences f on f.id=$5
           where m.id=$1 and m.request_key=$2 and m.org_id=$3 and m.owner_id=$4
             and m.record->'sourceImage'->>'name'=f.expected_snapshot_id
             and m.record->'sourceImage'->>'imageId' is not null
           limit 1`,
            [claim.provider_sandbox_id, id, claim.org_id, claim.owner_id, row.fence_id],
          )
        ).rows.length > 0;
      const retainFence = needsCleanup && !hasImagePin;
      await tx.query(
        `update public.provider_launch_requests set phase=$2,outcome=$3::jsonb,request_enc=$5,
          lease_owner=null,lease_expires_at=null,fence_id=case when $4 then fence_id else null end
         where sandbox_id=$1`,
        [
          id,
          needsCleanup ? "cleanup_pending" : succeeded ? "succeeded" : cancelled ? "cancelled" : "failed",
          JSON.stringify(outcome),
          retainFence,
          recoveryInput,
        ],
      );
      if (!retainFence && row.fence_id)
        await tx.query("delete from public.golden_operation_fences where id=$1", [row.fence_id]);
      return "expiresAt" in outcome;
    });
    if (published) {
      await recordLaunchStageSql(sql, id, "provider_claimed").catch(() => {});
      await recordLaunchStageSql(sql, id, "machine_started").catch(() => {});
    }
  }

  async function runClaim(claim: Claim, signal: AbortSignal) {
    const { sandbox_id: id, lease_epoch: epoch } = claim;
    const token = [id, owner, epoch];
    const reschedule = async () => {
      if (signal.aborted) return;
      await sql.query(
        `update public.provider_launch_requests set lease_owner=null,lease_expires_at=null,next_attempt_at=now()+interval '2 seconds'
       where sandbox_id=$1 and lease_owner=$2 and lease_epoch=$3 and lease_expires_at>clock_timestamp()`,
        token,
      );
    };
    const timer = setInterval(() => {
      if (signal.aborted) return;
      void sql
        .query(
          `update public.provider_launch_requests set lease_expires_at=now()+interval '45 seconds'
         where sandbox_id=$1 and lease_owner=$2 and lease_epoch=$3 and lease_expires_at>clock_timestamp()`,
          token,
        )
        .catch(() => {});
    }, 10_000);
    timer.unref();
    const stopHeartbeat = () => clearInterval(timer);
    signal.addEventListener("abort", stopHeartbeat, { once: true });
    try {
      const live = (
        await sql.query<{
          role: MemberRole | null;
          allowed: boolean;
          cancelled: boolean;
          expired: boolean;
          same_actor: boolean;
        }>(
          `select m.role, s.stop_requested_at is not null as cancelled,
           r.dispatch_deadline<=clock_timestamp() as expired, e.epoch=r.actor_epoch as same_actor,(
           e.epoch=r.actor_epoch and r.dispatch_deadline>clock_timestamp() and ${BOOT_ALLOWED}
         ) is true as allowed
         from public.provider_launch_requests r join public.sandboxes s on s.id=r.sandbox_id
         left join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
         left join public.mcp_actor_epochs e on e.org_id=m.org_id and e.user_id=m.user_id
         where s.id=$1`,
          [id],
        )
      ).rows[0];
      if (signal.aborted) return;
      if (live?.cancelled && claim.phase === "queued") {
        await settle(claim, { reason: "cancelled_before_boot", cancelled: true }, false);
        return;
      }
      const recovery = claim.phase === "cleanup_pending";
      const cleanup = recovery || (live?.cancelled === true && claim.phase === "booting");
      if (!recovery && cleanup && live?.expired) {
        await settle(claim, { reason: "cancelled_boot_outcome_unknown" }, true);
        return;
      }
      if (!live?.role || (!recovery && (!live.same_actor || (!cleanup && !live.allowed)))) {
        if (recovery) await reschedule();
        else await settle(claim, { reason: "admission_expired_or_revoked" }, claim.phase === "booting");
        return;
      }
      const pinned = JSON.parse(await decryptSecret(claim.request_enc, encryptionKey)) as PinnedFork;
      let provider: Provider;
      try {
        provider = await resolve(
          pinned.target,
          { userId: claim.owner_id, orgs: [{ orgId: claim.org_id, role: live.role }], via: "service" },
          pinned.runtime,
        );
        if (signal.aborted) return;
        const management = await provider.managementIdentity?.();
        const backendId = (await provider.backendIdentity?.())?.id;
        if (signal.aborted) return;
        if (
          provider.id !== "modal" ||
          backendId !== pinned.backendId ||
          management?.scope !== pinned.management.scope ||
          management.ownerId !== pinned.management.ownerId
        ) {
          if (recovery) await reschedule();
          else await settle(claim, { reason: "provider_authority_changed" }, claim.phase === "booting");
          return;
        }
      } catch {
        await reschedule();
        return;
      }
      if (!accepting || signal.aborted) {
        await reschedule();
        return;
      }
      const liveDispatch = async (transaction?: Sql) =>
        (
          await (transaction ?? sql).query<{ expired: boolean }>(
            `select r.dispatch_deadline<=clock_timestamp() as expired
             from public.provider_launch_requests r join public.sandboxes s on s.id=r.sandbox_id
             join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
             join public.mcp_actor_epochs e on e.org_id=m.org_id and e.user_id=m.user_id
             where r.sandbox_id=$1 and r.lease_owner=$2 and r.lease_epoch=$3
               and r.lease_expires_at>clock_timestamp()
               and ${
                 recovery
                   ? "r.phase='cleanup_pending'"
                   : `r.phase='booting' and e.epoch=r.actor_epoch and ${cleanup ? "s.status='stopping' and s.stop_requested_at is not null" : BOOT_ALLOWED}`
               } ${transaction ? "for update of r" : ""}`,
            token,
          )
        ).rows[0];
      const guardDispatch = Object.assign(
        async (transaction?: Sql) => {
          const dispatch = await liveDispatch(transaction);
          if (!accepting || signal.aborted || !dispatch || (!recovery && dispatch.expired))
            throw new LaunchError("outcome_unknown", "Modal dispatch authority expired or changed.", { sandboxId: id });
        },
        { signal },
      );
      if (cleanup) {
        const dispatch = await liveDispatch();
        if (signal.aborted) return;
        if (!accepting || !dispatch) {
          await reschedule();
          return;
        }
        if (!recovery && dispatch.expired) {
          await settle(claim, { reason: "cancelled_boot_outcome_unknown" }, true);
          return;
        }
        try {
          // The current claim fences older reservation transactions, including
          // when cancellation finds that boot never reached the adapter.
          const removed = await provider.delete(
            { sandboxId: claim.provider_sandbox_id, modalLaunchId: id },
            guardDispatch,
          );
          if (signal.aborted) return;
          if (removed.status === "deleted") {
            await settle(
              claim,
              live.cancelled
                ? { reason: "cancelled_during_boot", cancelled: true }
                : { reason: "failed_boot_allocation_removed" },
              false,
            );
            return;
          }
        } catch {
          // Preserve the request until cleanup can be retried.
        }
        if (signal.aborted) return;
        await reschedule();
        return;
      }
      const dispatch = await sql.transaction!(async (tx) => {
        // Hold the sandbox row while recording the intent so a stop cannot race
        // the status check. The Modal request key fences physical replay.
        const allowed = await tx.query(
          `select s.id from public.sandboxes s where s.id=$1 and ${BOOT_ALLOWED} for update of s`,
          [id],
        );
        if (!allowed.rows.length) return false;
        const updated = await tx.query(
          `update public.provider_launch_requests r set phase='booting' where sandbox_id=$1
           and lease_owner=$2 and lease_epoch=$3 and lease_expires_at>clock_timestamp() and dispatch_deadline>clock_timestamp()
           and exists(select 1 from public.members m join public.mcp_actor_epochs e using(org_id,user_id)
             where m.org_id=$4 and m.user_id=$5 and e.epoch=r.actor_epoch)
           returning sandbox_id`,
          [...token, claim.org_id, claim.owner_id],
        );
        return updated.rows.length === 1;
      });
      if (!dispatch) {
        await reschedule();
        return;
      }
      if (signal.aborted) return;
      let machine: Machine;
      try {
        machine = await provider.fork(pinned.request, guardDispatch);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ProviderError && isNonMutatingProviderRefusal(error) && claim.phase === "queued") {
          if (error.providerCode === "fork_source_busy") {
            await sql.query(
              `update public.provider_launch_requests set phase='queued' where sandbox_id=$1
               and lease_owner=$2 and lease_epoch=$3 and lease_expires_at>clock_timestamp()`,
              token,
            );
            await reschedule();
            return;
          }
          const { code, status, retryable, retryAfterSeconds } = error;
          await settle(
            claim,
            {
              refusal: {
                code,
                ...(status === undefined ? {} : { status }),
                retryable,
                ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
              },
            },
            false,
          );
          return;
        }
        // A lost provider acknowledgement is retried only through the exact
        // durable Modal reservation. The adapter looks up uncertain creates by name.
        await reschedule();
        return;
      }
      if (signal.aborted) return;
      if (machine.id !== claim.provider_sandbox_id) {
        await settle(claim, { reason: "provider_identity_mismatch" }, true);
        return;
      }
      const ready = machine.state === "ready" || machine.state === "running";
      await settle(
        claim,
        ready ? { expiresAt: machine.expiresAt?.toISOString() ?? null } : { reason: "provider_boot_not_ready" },
        !ready,
      );
    } finally {
      stopHeartbeat();
      signal.removeEventListener("abort", stopHeartbeat);
    }
  }

  return {
    admit,
    waitForBoot,
    async reconcileOne(signal: AbortSignal) {
      if (!accepting || signal.aborted || inFlight.size >= MAX_CONCURRENT_BOOTS) return false;
      const claim = (
        await sql.query<Claim>(
          `with due as (
           select r.sandbox_id,s.org_id,s.owner_id,s.provider_sandbox_id
           from public.provider_launch_requests r join public.sandboxes s on s.id=r.sandbox_id
           where s.provider='modal'
           and (r.phase in ('queued','booting','cleanup_pending')
             or (r.phase='failed' and r.fence_id is not null and r.request_enc is not null))
           and r.next_attempt_at<=now()
           and (r.lease_expires_at is null or r.lease_expires_at<=now())
           order by r.next_attempt_at,r.created_at,r.sandbox_id limit 1 for update of r skip locked
         ) update public.provider_launch_requests r set lease_owner=$1,lease_epoch=r.lease_epoch+1,
           lease_expires_at=now()+interval '45 seconds',
           phase=case when r.phase='failed' then 'cleanup_pending' else r.phase end
           from due where r.sandbox_id=due.sandbox_id
           returning r.sandbox_id,r.lease_epoch::text,r.phase,r.request_enc,due.org_id,due.owner_id,due.provider_sandbox_id,
           greatest(0,ceil(extract(epoch from (r.dispatch_deadline-clock_timestamp()))*1000))::integer as remaining_ms`,
          [owner],
        )
      ).rows[0];
      if (!claim) return false;
      const controller = new AbortController();
      // Already expired rows still need a local terminal transition.
      const attemptMs = claim.phase === "cleanup_pending" ? CLEANUP_ATTEMPT_MS : claim.remaining_ms;
      const deadline = attemptMs > 0 ? setTimeout(() => controller.abort(), attemptMs) : undefined;
      deadline?.unref();
      const elapsed = new Promise<void>((resolve) =>
        controller.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      const work = runClaim(claim, controller.signal).catch(() => {
        // A failed DB or provider operation leaves its claim to expire.
      });
      // At the budget boundary durable dispatch intent and the provider's
      // reservation take over. An SDK reply can no longer publish worker
      // state, and a hung call cannot hold a consumer slot indefinitely.
      const task = Promise.race([work, elapsed]).finally(() => clearTimeout(deadline));
      inFlight.add(task);
      void task.then(() => inFlight.delete(task));
      return true;
    },
    stopAdmission() {
      accepting = false;
    },
    async drain() {
      await Promise.all(inFlight);
    },
  };
}
