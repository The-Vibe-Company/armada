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
import type { Caller } from "./caller.ts";
import { createSqlData } from "./data.ts";

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
type Outcome = { expiresAt: string | null } | { refusal: BootFailure } | { reason: string };
type Claim = {
  sandbox_id: string;
  lease_epoch: string;
  request_enc: Uint8Array<ArrayBuffer>;
  phase: "queued" | "booting";
  org_id: string;
  owner_id: string;
  provider_sandbox_id: string;
};
const DEADLINE_MS = 15 * 60_000;
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
      const saved = await createSqlData(tx)(caller).sandboxes.insert(sandbox);
      const fence = (
        await tx.query<{ id: string }>(
          `insert into public.golden_operation_fences(golden_id,expected_snapshot_id,expected_sandbox_id,revision_known,operation_kind)
         values($1,$2,$3,true,'launch') returning id`,
          [golden.id, golden.providerSnapshotId, golden.providerSandboxId],
        )
      ).rows[0]!;
      await tx.query(
        `insert into public.provider_launch_requests(sandbox_id,actor_epoch,request_enc,fence_id,dispatch_deadline,correlation_id)
         values($1,$2,$3,$4,now()+interval '15 minutes',$1)`,
        [sandbox.id, member.epoch, sealed, fence.id],
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
        await sql.query<{ phase: string; outcome: Outcome | null; expires_at: string | Date }>(
          `select r.phase,r.outcome,s.expires_at from public.provider_launch_requests r
         join public.sandboxes s on s.id=r.sandbox_id where r.sandbox_id=$1`,
          [record.id],
        )
      ).rows[0];
      const outcome = result?.outcome;
      if (outcome && "expiresAt" in outcome) {
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

  async function settle(claim: Claim, outcome: Outcome, keepFence: boolean) {
    const { sandbox_id: id, lease_epoch: epoch } = claim;
    const bootExpiry = "expiresAt" in outcome ? outcome.expiresAt : undefined;
    const succeeded = bootExpiry !== undefined;
    await sql.transaction!(async (tx) => {
      await tx.query("select id from public.sandboxes where id=$1 for update", [id]);
      const row = (
        await tx.query<{ fence_id: string | null }>(
          `select fence_id from public.provider_launch_requests where sandbox_id=$1 and lease_owner=$2
         and lease_epoch=$3 and lease_expires_at>now() for update`,
          [id, owner, epoch],
        )
      ).rows[0];
      if (!row) return;
      const updated = await tx.query(
        `update public.sandboxes set
           expires_at=case when $2 then least(clock_timestamp()+effective_ttl_seconds*interval '1 second',
             coalesce($3::timestamptz-$4::integer*interval '1 second','infinity'::timestamptz)) else expires_at end,
           activity_until=case when $2 then now()+interval '2 minutes' else null end,
           activity_lease_id=case when $2 then activity_lease_id else null end,
           status=case when $2 then status else 'failed'::public.sandbox_status end,
           status_reason=case when $2 then status_reason else 'Modal allocation did not complete.' end,
           reconcile_after=now()
         where id=$1 and status='starting' and stop_requested_at is null returning id`,
        [id, succeeded, bootExpiry ?? null, SANDBOX_STOP_MARGIN_SECONDS],
      );
      if (succeeded && !updated.rows.length) {
        // An earlier stop may have observed absence before the boot returned.
        // Keep the fence and let the existing lifecycle observe the allocated ID.
        keepFence = true;
        outcome = { reason: "cancelled_during_boot" };
      }
      await tx.query(
        `update public.provider_launch_requests set phase=$2,outcome=$3::jsonb,request_enc=null,
          lease_owner=null,lease_expires_at=null,fence_id=case when $4 then fence_id else null end
         where sandbox_id=$1`,
        [id, "expiresAt" in outcome ? "succeeded" : "failed", JSON.stringify(outcome), keepFence],
      );
      if (!keepFence && row.fence_id)
        await tx.query("delete from public.golden_operation_fences where id=$1", [row.fence_id]);
    });
    if ("expiresAt" in outcome) {
      await recordLaunchStageSql(sql, id, "provider_claimed").catch(() => {});
      await recordLaunchStageSql(sql, id, "machine_started").catch(() => {});
    }
  }

  async function runClaim(claim: Claim, signal: AbortSignal) {
    const { sandbox_id: id, lease_epoch: epoch } = claim;
    const token = [id, owner, epoch];
    const reschedule = () =>
      sql.query(
        `update public.provider_launch_requests set lease_owner=null,lease_expires_at=null,next_attempt_at=now()+interval '2 seconds'
       where sandbox_id=$1 and lease_owner=$2 and lease_epoch=$3 and lease_expires_at>now()`,
        token,
      );
    const timer = setInterval(() => {
      void sql
        .query(
          `update public.provider_launch_requests set lease_expires_at=now()+interval '45 seconds'
         where sandbox_id=$1 and lease_owner=$2 and lease_epoch=$3 and lease_expires_at>now()`,
          token,
        )
        .catch(() => {});
    }, 10_000);
    timer.unref();
    try {
      const live = (
        await sql.query<{ role: MemberRole | null; allowed: boolean }>(
          `select m.role,(
           e.epoch=r.actor_epoch and r.dispatch_deadline>now() and ${BOOT_ALLOWED}
         ) is true as allowed
         from public.provider_launch_requests r join public.sandboxes s on s.id=r.sandbox_id
         left join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
         left join public.mcp_actor_epochs e on e.org_id=m.org_id and e.user_id=m.user_id
         where s.id=$1`,
          [id],
        )
      ).rows[0];
      if (!live?.role || !live.allowed) {
        await settle(claim, { reason: "admission_expired_or_revoked" }, claim.phase === "booting");
        return;
      }
      const pinned = JSON.parse(await decryptSecret(claim.request_enc, encryptionKey)) as PinnedFork;
      const provider = await resolve(
        pinned.target,
        {
          userId: claim.owner_id,
          orgs: [{ orgId: claim.org_id, role: live.role }],
          via: "service",
        },
        pinned.runtime,
      );
      const management = await provider.managementIdentity?.();
      if (
        provider.id !== "modal" ||
        (await provider.backendIdentity?.())?.id !== pinned.backendId ||
        management?.scope !== pinned.management.scope ||
        management.ownerId !== pinned.management.ownerId
      ) {
        await settle(claim, { reason: "provider_authority_changed" }, claim.phase === "booting");
        return;
      }
      if (!accepting || signal.aborted) {
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
           and lease_owner=$2 and lease_epoch=$3 and lease_expires_at>now() and dispatch_deadline>now()
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
      let machine: Machine;
      try {
        machine = await provider.fork(pinned.request);
      } catch (error) {
        if (error instanceof ProviderError && isNonMutatingProviderRefusal(error) && claim.phase === "queued") {
          if (error.providerCode === "fork_source_busy") {
            await sql.query(
              `update public.provider_launch_requests set phase='queued' where sandbox_id=$1
               and lease_owner=$2 and lease_epoch=$3 and lease_expires_at>now()`,
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
      if (machine.id !== claim.provider_sandbox_id) {
        await settle(claim, { reason: "provider_identity_mismatch" }, true);
        return;
      }
      await settle(
        claim,
        machine.state === "ready" || machine.state === "running"
          ? { expiresAt: machine.expiresAt?.toISOString() ?? null }
          : { reason: "provider_boot_not_ready" },
        false,
      );
    } finally {
      clearInterval(timer);
    }
  }

  return {
    admit,
    waitForBoot,
    async reconcileOne(signal: AbortSignal) {
      if (!accepting || signal.aborted) return false;
      const claim = (
        await sql.query<Claim>(
          `with due as (
           select r.sandbox_id,s.org_id,s.owner_id,s.provider_sandbox_id
           from public.provider_launch_requests r join public.sandboxes s on s.id=r.sandbox_id
           where s.provider='modal' and r.phase in ('queued','booting') and r.next_attempt_at<=now()
           and (r.lease_expires_at is null or r.lease_expires_at<=now())
           order by r.next_attempt_at,r.created_at,r.sandbox_id limit 1 for update of r skip locked
         ) update public.provider_launch_requests r set lease_owner=$1,lease_epoch=r.lease_epoch+1,
           lease_expires_at=now()+interval '45 seconds' from due where r.sandbox_id=due.sandbox_id
           returning r.sandbox_id,r.lease_epoch::text,r.phase,r.request_enc,due.org_id,due.owner_id,due.provider_sandbox_id`,
          [owner],
        )
      ).rows[0];
      if (!claim) return false;
      await runClaim(claim, signal);
      return true;
    },
    stopAdmission() {
      accepting = false;
    },
    async drain() {},
  };
}
