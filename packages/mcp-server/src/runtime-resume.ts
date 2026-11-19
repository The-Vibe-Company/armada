import { sha256Hex } from "@armada/auth";
import { type PromptReceipt, type Sql, sandboxActivity, VaultError } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { createSqlData, type SandboxView } from "./data.ts";
import { recordLaunchStageQuietly } from "./launch-stage-record.ts";
import { createModalRuntimeEnvironment } from "./modal-runtime-environment.ts";
import { runtimeBridgeTarget } from "./provider-runtime-admission.ts";
import { lockRuntimeAccount } from "./runtime-account-admission.ts";
import { runtimeAgentFor } from "./runtime-agent.ts";
import type { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import type { RuntimeGitHub } from "./runtime-github.ts";
import type { RuntimeMcp } from "./runtime-mcp.ts";
import { requestFailedRuntimeResumeStop } from "./sandbox-lifecycle.ts";

export interface RuntimeResumeInput {
  id: string;
  request_id: string;
  runtimeVersion: 1;
  prompt: string;
  conversation_id?: string | undefined;
}
export interface RuntimeResumeReceipt {
  id: string;
  requestId: string;
  promptId: string;
  conversationId: string;
  status: PromptReceipt["status"];
  resumed: true;
  runtime: { kind: "armada"; epoch: string };
  sourceCheckpoint: { epoch: string; watermark: number; empty?: true };
}
interface Operation {
  source_epoch: string;
  target_epoch: string;
  watermark: string;
  request_hash: string;
  conversation_id: string;
  empty_checkpoint: boolean;
  model: string;
  reasoning_effort: string;
  phase: string;
  verified_at: string | null;
  receipt: RuntimeResumeReceipt | null;
}
export class BoatResumeRetentionUnconfirmed extends Error {}

export interface RuntimeResumePlacement {
  start(
    signal: AbortSignal,
    restore: { epoch: string; watermark: number; conversationId: string | null },
    confirmActivation?: () => Promise<void>,
  ): Promise<{ epoch: string }>;
  /** Exact previously authorized compute identity; no activation/reissue on failure. */
  stop(): Promise<void>;
}
export type RuntimeResume = ReturnType<typeof createRuntimeResume>;
export type RuntimeResumePrepare = (caller: Caller, sandbox: SandboxView) => Promise<RuntimeResumePlacement>;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

/** Explicit stopped -> fresh epoch, with retained conversation or verified empty journal. One dispatch,
 * durable request identity, no blind activation/bootstrap retry after uncertainty. */
export function createRuntimeResume(
  sql: Sql,
  key: string,
  commands: ReturnType<typeof createRuntimeCommands>,
  prepare?: RuntimeResumePrepare,
  prepareMcp?: RuntimeMcp["prepare"],
  prepareGitHub?: RuntimeGitHub["prepareLaunch"],
) {
  const authority = createRuntimeEnrolments(sql, key);
  const modalEnvironment = createModalRuntimeEnvironment(sql, key);
  const read = async (tx: Sql, id: string, request: string) =>
    (
      await tx.query<Operation>(
        `select source_epoch::text,target_epoch::text,watermark::text,request_hash,conversation_id,empty_checkpoint,model,reasoning_effort,phase,verified_at::text,receipt
    from public.runtime_resumes where sandbox_id=$1 and request_id=$2`,
        [id, request],
      )
    ).rows[0];
  return async (caller: Caller, input: RuntimeResumeInput): Promise<RuntimeResumeReceipt> => {
    const requestId = input.request_id.toLowerCase();
    if (input.runtimeVersion !== 1 || !uuid.test(input.id) || !uuid.test(requestId) || !input.prompt.trim())
      throw new VaultError("invalid", "Runtime resume v1 requires UUIDs and a nonempty instruction.");
    const store = createSqlData(sql)(caller).sandboxes;
    const found = await store.get(input.id);
    if (!found || found.ownerId !== caller.userId || !runtimeBridgeTarget(found) || found.deletedAt)
      throw new VaultError("not_found", "No owned runtime resume target.");
    const prior = await read(sql, found.id, requestId);
    const empty =
      prior?.empty_checkpoint ??
      (found.conversationIds.length === 0 && !found.taskPromptId && input.conversation_id === undefined);
    const conversation =
      input.conversation_id ??
      prior?.conversation_id ??
      found.conversationIds.at(-1) ??
      (empty ? `first_${requestId}` : undefined);
    if (!conversation || (!empty && !found.conversationIds.includes(conversation)))
      throw new VaultError("invalid", "Resume an existing conversation or a verified empty checkpoint.");
    const hash = await sha256Hex(JSON.stringify({ id: found.id, requestId, conversation, prompt: input.prompt }));
    if (prior?.request_hash !== undefined && prior.request_hash !== hash)
      throw new VaultError("conflict", "Reuse the original resume request_id with identical input.");
    if (prior?.receipt) {
      if (!(await store.get(found.id))) throw new VaultError("not_found", "Runtime membership was revoked.");
      return prior.receipt;
    } // Historical accepted outcome, not a new activation.
    const actor = { userId: caller.userId, orgId: found.orgId };
    if (!prior && found.provider === "modal") await modalEnvironment.validate(actor, found.id);
    if (!sql.transaction) throw new VaultError("unavailable", "Runtime resume requires transactional admission.");
    const pricingContext = await store.captureUsagePricingContext?.(found.id);
    const admitted = await sql.transaction(async (tx) => {
      await lockRuntimeAccount(tx, caller, found, "Pinned runtime account is no longer authorized.");
      const fence = (
        await tx.query<{ tainted: boolean; lease: string | null; busy: boolean; unexpired: boolean }>(
          "select expires_at>now() as unexpired,application_secret_tainted as tainted,activity_lease_id::text as lease,(reconcile_lease_until>now()) as busy from public.sandboxes where id=$1 and owner_id=$2 for update",
          [found.id, caller.userId],
        )
      ).rows[0];
      const current = await createSqlData(tx)(caller).sandboxes.get(found.id);
      if (
        !fence ||
        !current ||
        fence.tainted ||
        !fence.unexpired ||
        fence.busy ||
        !current.model ||
        !current.reasoningEffort ||
        current.deletedAt ||
        current.credentialId !== found.credentialId ||
        current.credentialVersion !== found.credentialVersion ||
        (empty
          ? current.conversationIds.length !== 0 || Boolean(current.taskPromptId)
          : !current.conversationIds.includes(conversation))
      )
        throw new VaultError("conflict", "Runtime resume target changed or cannot retain secrets safely.");
      const epoch = (
        await tx.query<{ epoch: string; live: boolean }>(
          "select epoch::text,(runtime_hash is not null) as live from public.runtime_enrolments where sandbox_id=$1 for update",
          [found.id],
        )
      ).rows[0];
      const existing = await read(tx, found.id, requestId);
      if (existing) {
        if (existing.request_hash !== hash) throw new VaultError("conflict", "Resume request input changed.");
        if (existing.receipt) return { current, op: existing, first: false };
        if (
          existing.phase !== "dispatched" ||
          !epoch?.live ||
          epoch.epoch !== existing.target_epoch ||
          fence.lease !== requestId ||
          !["starting", "ready", "running"].includes(current.status) ||
          current.stopRequestedAt ||
          current.model !== existing.model ||
          current.reasoningEffort !== existing.reasoning_effort
        )
          throw new VaultError(
            "conflict",
            "Resume activation outcome is uncertain. Inspect/stop; no activation or ticket was retried.",
          );
        await createSqlData(tx)(caller).sandboxes.update(found.id, {
          renewActivity: true,
          activityToken: requestId,
          ...(current.lifecycleGeneration !== undefined ? { expectedGeneration: current.lifecycleGeneration } : {}),
        });
        return { current, op: existing, first: false };
      }
      if (!prepare)
        throw new VaultError("unavailable", "Trusted runtime resume policy is unavailable; no compute was activated.");
      if (current.status !== "stopped" || !current.stoppedAt || current.stopRequestedAt || fence.lease || !epoch)
        throw new VaultError("conflict", "Resume requires a confirmed retained stop and no unresolved admission.");
      const proof = (
        await tx.query<{ watermark: string }>(
          `select watermark::text from public.runtime_checkpoints where sandbox_id=$1 and epoch=$2 and watermark is not null
        and watermark=(select coalesce(max(sequence),0) from public.runtime_events where sandbox_id=$1)`,
          [found.id, epoch.epoch],
        )
      ).rows[0];
      if (!proof)
        throw new VaultError(
          "conflict",
          "No current synchronized checkpoint; a fresh conversation will not be substituted.",
        );
      const op: Operation = {
        source_epoch: epoch.epoch,
        target_epoch: String(BigInt(epoch.epoch) + 1n),
        watermark: proof.watermark,
        request_hash: hash,
        conversation_id: conversation,
        empty_checkpoint: empty,
        model: current.model,
        reasoning_effort: current.reasoningEffort,
        phase: "dispatched",
        verified_at: null,
        receipt: null,
      };
      await tx.query(
        `insert into public.runtime_resumes(sandbox_id,request_id,source_epoch,target_epoch,watermark,request_hash,conversation_id,model,reasoning_effort,empty_checkpoint) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          found.id,
          requestId,
          op.source_epoch,
          op.target_epoch,
          op.watermark,
          hash,
          conversation,
          op.model,
          op.reasoning_effort,
          op.empty_checkpoint,
        ],
      );
      await createSqlData(tx)(caller).sandboxes.update(found.id, {
        status: "starting",
        stoppedAt: null,
        stopRequested: false,
        advanceGeneration: true,
        queueRequestId: requestId,
        activityToken: requestId,
        clearTaskOutcome: true,
        ...(current.lifecycleGeneration !== undefined ? { expectedGeneration: current.lifecycleGeneration } : {}),
      });
      await tx.query(
        `update public.sandbox_launch_stages l set at=least(l.at,r.created_at)
           from public.runtime_resumes r
          where l.sandbox_id=$1 and l.stage='accepted'
            and l.activation=(select max(a.activation) from public.sandbox_launch_stages a where a.sandbox_id=$1)
            and r.sandbox_id=l.sandbox_id and r.request_id=$2`,
        [found.id, requestId],
      );
      const active = await createSqlData(tx)(caller).sandboxes.get(found.id);
      if (!active) throw new VaultError("not_found", "Runtime resume admission disappeared.");
      return { current: active, op, first: true };
    });
    if (admitted.op.receipt) return admitted.op.receipt;
    const restore = {
      epoch: admitted.op.source_epoch,
      watermark: Number(admitted.op.watermark),
      conversationId: admitted.op.empty_checkpoint ? null : conversation,
    };
    const agent = runtimeAgentFor(commands, caller.userId, found, {
      model: admitted.op.model,
      reasoningEffort: admitted.op.reasoning_effort,
    });
    let placement: RuntimeResumePlacement | undefined, receipt: RuntimeResumeReceipt | undefined;
    const publishing = {
      ...store,
      async update(id: string, patch: Parameters<typeof store.update>[1]) {
        if (!patch.finishActivity) return store.update(id, patch);
        await authority.withOwner(found.id, caller.userId, async (tx, scope) => {
          if (scope.epoch !== admitted.op.target_epoch || !receipt)
            throw new VaultError("conflict", "Resume epoch changed before publication.");
          await createSqlData(tx)(caller).sandboxes.update(id, patch);
          const saved = await tx.query(
            "update public.runtime_resumes set phase='complete',receipt=$3::jsonb where sandbox_id=$1 and request_id=$2 and phase='dispatched' returning request_id",
            [found.id, requestId, JSON.stringify(receipt)],
          );
          if (!saved.rows.length) throw new VaultError("conflict", "Resume publication changed.");
        });
      },
    };
    try {
      return await sandboxActivity(
        publishing,
        admitted.current,
        {},
        async (signal) => {
          if (admitted.first) {
            placement = await prepare!(caller, admitted.current);
            const confirmActivation =
              found.provider === "boat"
                ? async () => {
                    const saved = await sql.query(
                      `with active as (
                  select id from public.sandboxes where id=$1 and status='starting'
                    and activity_lease_id=$2 and lifecycle_generation=$3 and activity_until>clock_timestamp()
                    and (reconcile_lease_until is null or reconcile_lease_until<=clock_timestamp())
                    and stop_requested_at is null and deleted_at is null for update
                )
                update public.runtime_resumes r set activated_at=coalesce(r.activated_at,clock_timestamp())
                from active where r.sandbox_id=active.id and r.request_id=$2 and r.phase='dispatched'
                returning r.request_id`,
                      [found.id, requestId, admitted.current.lifecycleGeneration],
                    );
                    if (!saved.rows.length) throw new VaultError("conflict", "Resume activation authority changed.");
                  }
                : undefined;
            const ready = await placement.start(signal, restore, confirmActivation);
            if (ready.epoch !== admitted.op.target_epoch) throw new VaultError("conflict", "Unexpected resume epoch.");
          }
          await agent.health(signal, restore); // Also required on reconciliation; old binaries cannot echo an unverified restore.
          await authority.withOwner(found.id, caller.userId, async (tx, scope) => {
            if (scope.epoch !== admitted.op.target_epoch) throw new VaultError("conflict", "Resume epoch changed.");
            await tx.query(
              "update public.runtime_resumes set verified_at=coalesce(verified_at,now()) where sandbox_id=$1 and request_id=$2",
              [found.id, requestId],
            );
          });
          const existing = await commands.result(
            caller.userId,
            found.id,
            `resume_${requestId}`,
            admitted.op.target_epoch,
          );
          if (existing.state === "missing") {
            // Restored disk state carries revoked epoch authority. Reauthorize before
            // inference, never on a replay of an already dispatched prompt.
            if (!admitted.first && found.provider === "modal")
              await modalEnvironment.deliver(actor, found.id, admitted.op.target_epoch, signal);
            await prepareGitHub?.(caller, found.id);
            await prepareMcp?.(caller, found.id, signal);
          }
          // #2560: restored, verified and reauthorized; the resume prompt's dispatch is not launch time.
          await recordLaunchStageQuietly(sql, found.id, "harness_ready", admitted.current.lifecycleGeneration);
          const accepted = await agent.prompt(
            {
              sandboxId: found.providerSandboxId,
              harness: found.harness,
              conversationId: conversation,
              text: input.prompt,
              signal,
            },
            `resume_${requestId}`,
            admitted.op.target_epoch,
            (receipt) => {
              if (receipt.conversationId !== conversation || !receipt.promptId)
                throw new VaultError("conflict", "Runtime did not acknowledge the admitted conversation.");
            },
          );
          receipt = {
            id: found.id,
            requestId,
            promptId: accepted.promptId,
            conversationId: conversation,
            status: accepted.status,
            resumed: true,
            runtime: { kind: "armada", epoch: admitted.op.target_epoch },
            sourceCheckpoint: {
              epoch: restore.epoch,
              watermark: restore.watermark,
              ...(admitted.op.empty_checkpoint ? { empty: true as const } : {}),
            },
          };
          try {
            await store.recordTurnModel?.(found.id, accepted.promptId, admitted.op.model, pricingContext);
          } catch {
            /* Accepted work continues. */
          }
          return {
            result: receipt,
            patch: {
              status: "running",
              statusReason: null,
              taskPromptId: accepted.promptId,
              conversationIds: admitted.op.empty_checkpoint ? [conversation] : admitted.current.conversationIds,
            },
          };
        },
        { initialLeaseId: requestId, deadlineMs: 600_000 },
      );
    } catch (error) {
      const preActivationArchive = error instanceof BoatResumeRetentionUnconfirmed;
      const completed = await read(sql, found.id, requestId).catch(() => undefined);
      if (completed?.receipt && (await store.get(found.id))) return completed.receipt;
      // Preserve recoverable live-epoch uncertainty. Never re-activate or reissue a ticket.
      const cleanup = await sql
        .transaction(async (tx) => {
          const member = await tx.query(
            "select user_id from public.members where user_id=$1 and org_id=$2 for update",
            [caller.userId, found.orgId],
          );
          if (!member.rows.length) return;
          await tx.query("select id from public.sandboxes where id=$1 for update", [found.id]);
          const runtime = (
            await tx.query<{ epoch: string; live: boolean; activation_confirmed: boolean }>(
              `select epoch::text,(runtime_hash is not null) as live,
                  ((enrolment_hash is not null and lifecycle_generation=$2) or exists(
                    select 1 from public.runtime_resumes where sandbox_id=$1 and request_id=$3
                      and phase='dispatched' and activated_at is not null
                  )) as activation_confirmed
               from public.runtime_enrolments where sandbox_id=$1 for update`,
              [found.id, admitted.current.lifecycleGeneration, requestId],
            )
          ).rows[0];
          if (runtime?.live && runtime.epoch === admitted.op.target_epoch) return;
          const retained = Boolean(
            found.provider === "boat" &&
              runtime &&
              (runtime.activation_confirmed || preActivationArchive) &&
              !runtime.live &&
              runtime.epoch === admitted.op.source_epoch,
          );
          const status = await requestFailedRuntimeResumeStop(
            tx,
            found.id,
            requestId,
            admitted.current.lifecycleGeneration,
            retained,
          );
          if (status)
            await tx.query(
              "update public.runtime_resumes set phase=$3 where sandbox_id=$1 and request_id=$2 and receipt is null",
              [found.id, requestId, status === "stopping" ? "abandoned" : "failed"],
            );
          return status;
        })
        .catch(() => undefined);
      if (cleanup === "failed" && placement && !preActivationArchive) await placement.stop().catch(() => {});
      if (cleanup === "stopping")
        throw new VaultError(
          "conflict",
          preActivationArchive
            ? "Boat retained data has not been verified. Wait for a confirmed retained stop before resuming with a new request_id."
            : "Runtime did not enrol. Wait for a confirmed retained stop before resuming with a new request_id.",
        );
      throw new VaultError(
        "conflict",
        "Runtime resume outcome is uncertain; retain the original request_id, inspect status/stop, and do not launch or activate again.",
      );
    }
  };
}
