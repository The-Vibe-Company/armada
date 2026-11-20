import { sha256Hex } from "@armada/auth";
import { type PromptReceipt, type Sql, sandboxActivity, VaultError } from "@armada/core/server";
import { BoatRetentionUnconfirmed } from "@armada/provider-boat";
import { CONFIRMED_WAKE_WITHOUT_TICKET } from "./account-turn-dispatch.ts";
import type { Caller } from "./caller.ts";
import { createSqlData, type SandboxView } from "./data.ts";
import { createGoldenRuntimeEnvironment } from "./golden-runtime-environment.ts";
import type { JobContext } from "./jobs/runner.ts";
import { recordLaunchStageQuietly, recordResumeAcceptedAt } from "./launch-stage-record.ts";
import { runtimeBridgeTarget } from "./provider-runtime-admission.ts";
import { lockRuntimeAccount } from "./runtime-account-admission.ts";
import { runtimeAgentFor } from "./runtime-agent.ts";
import type { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import type { RuntimeGitHub } from "./runtime-github.ts";
import type { RuntimeMcp } from "./runtime-mcp.ts";
import type { RestoreScopedRuntimeAccess } from "./sandbox-armada-access.ts";
import { refuseConversationSelector, SINGLE_CONVERSATION_GUIDANCE } from "./sandbox-conversation.ts";
import {
  confirmRuntimeResumeActivation,
  deferAmbiguousBoatResume,
  publishRuntimeWake,
  requestFailedRuntimeResumeStop,
  restoreModalResumeSchedule,
  transitionSandbox,
} from "./sandbox-lifecycle.ts";

export interface RuntimeResumeInput {
  id: string;
  request_id: string;
  runtimeVersion: 1;
  prompt: string;
}
/** Shared runner authority for an exact queued send. */
export type RuntimeTurnClaim = Pick<JobContext, "canDispatch" | "handoffGeneration">;

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
export class BoatResumeActivationUncertain extends Error {
  constructor(cause: unknown) {
    super("Boat runtime activation outcome is uncertain.", { cause });
  }
}

export interface RuntimeResumePlacement {
  start(
    signal: AbortSignal,
    restore: { epoch: string; watermark: number; conversationId: string | null },
    confirmActivation?: () => Promise<void>,
    assertDispatch?: (tx?: Sql) => Promise<void>,
    assertBeforeTicket?: (tx: Sql) => Promise<void>,
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
  restoreScopedAccess?: RestoreScopedRuntimeAccess,
) {
  const authority = createRuntimeEnrolments(sql, key);
  const environment = createGoldenRuntimeEnvironment(sql, key);
  const read = async (tx: Sql, id: string, request: string) =>
    (
      await tx.query<Operation>(
        `select source_epoch::text,target_epoch::text,watermark::text,request_hash,conversation_id,empty_checkpoint,model,reasoning_effort,phase,verified_at::text,receipt
    from public.runtime_resumes where sandbox_id=$1 and request_id=$2`,
        [id, request],
      )
    ).rows[0];
  return async (caller: Caller, input: RuntimeResumeInput, claim?: RuntimeTurnClaim): Promise<RuntimeResumeReceipt> => {
    refuseConversationSelector(input);
    const requestId = input.request_id.toLowerCase();
    if (input.runtimeVersion !== 1 || !uuid.test(input.id) || !uuid.test(requestId) || !input.prompt.trim())
      throw new VaultError("invalid", "Runtime resume v1 requires UUIDs and a nonempty instruction.");
    const store = createSqlData(sql)(caller).sandboxes;
    const found = await store.get(input.id);
    if (!found || found.ownerId !== caller.userId || !runtimeBridgeTarget(found) || found.deletedAt)
      throw new VaultError("not_found", "No owned runtime resume target.");
    const prior = await read(sql, found.id, requestId);
    const empty = prior?.empty_checkpoint ?? (found.conversationIds.length === 0 && !found.taskPromptId);
    const conversation =
      prior?.conversation_id ?? found.conversationIds.at(-1) ?? (empty ? `first_${requestId}` : undefined);
    if (!conversation)
      throw new VaultError("invalid", "Resume an existing conversation or a verified empty checkpoint.");
    const hash = await sha256Hex(JSON.stringify({ id: found.id, requestId, conversation, prompt: input.prompt }));
    if (prior?.request_hash !== undefined && prior.request_hash !== hash)
      throw new VaultError("conflict", "Reuse the original resume request_id with identical input.");
    if (prior?.receipt) {
      if (!(await store.get(found.id))) throw new VaultError("not_found", "Runtime membership was revoked.");
      return prior.receipt;
    } // Historical accepted outcome, not a new activation.
    if (!empty && conversation !== found.conversationIds.at(-1))
      throw new VaultError("conflict", SINGLE_CONVERSATION_GUIDANCE);
    const actor = { userId: caller.userId, orgId: found.orgId };
    if (!prior && (found.provider === "modal" || found.provider === "boat"))
      await environment.validate(found.provider, actor, found.id);
    if (!sql.transaction) throw new VaultError("unavailable", "Runtime resume requires transactional admission.");
    const pricingContext = await store.captureUsagePricingContext?.(found.id);
    const lockAccount = (tx: Sql) =>
      lockRuntimeAccount(tx, caller, found, "Pinned runtime account is no longer authorized.");
    const assertClaim = async (tx?: Sql) => {
      if (claim && !(await claim.canDispatch(tx)))
        throw new VaultError("conflict", "Queued runtime turn lease is no longer current.");
    };
    const canBootstrap = async (tx: Sql) =>
      (
        await tx.query(
          `select 1 from public.account_turn_queue q join public.sandboxes s on s.id=q.sandbox_id
           join public.credentials c on c.id=s.credential_id and c.version=s.credential_version
           join public.mcp_actor_epochs e on e.org_id=q.org_id and e.user_id=q.owner_id
           where q.sandbox_id=$1 and q.request_id=$2 and ${CONFIRMED_WAKE_WITHOUT_TICKET}
             and q.org_id=s.org_id and q.owner_id=s.owner_id and e.epoch=q.actor_epoch
             and q.account_id=c.id and q.credential_version=c.version and c.status='active'
             and (c.expires_at is null or c.expires_at>now())
             and ((c.scope='user' and c.owner_id=q.owner_id) or (c.scope='org' and c.owner_id=q.org_id))`,
          [found.id, requestId],
        )
      ).rows.length > 0;
    const firstWakeClaim = prior ? undefined : claim;
    const admit = async (tx: Sql) => {
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
        current.credentialVersion !== found.credentialVersion
      )
        throw new VaultError("conflict", "Runtime resume target changed or cannot retain secrets safely.");
      if (
        empty
          ? current.conversationIds.length !== 0 || Boolean(current.taskPromptId)
          : current.conversationIds.at(-1) !== conversation
      )
        throw new VaultError("conflict", SINGLE_CONVERSATION_GUIDANCE);
      const epoch = (
        await tx.query<{ epoch: string; live: boolean }>(
          "select epoch::text,(runtime_hash is not null) as live from public.runtime_enrolments where sandbox_id=$1 for update",
          [found.id],
        )
      ).rows[0];
      const existing = await read(tx, found.id, requestId);
      if (existing) {
        if (firstWakeClaim) throw new VaultError("conflict", "Runtime resume intent changed during queued admission.");
        if (existing.request_hash !== hash) throw new VaultError("conflict", "Resume request input changed.");
        await assertClaim(tx);
        if (existing.receipt) return { current, op: existing, first: false, bootstrap: false };
        const bootstrap = Boolean(claim && prepare && (await canBootstrap(tx)));
        if (
          existing.phase !== "dispatched" ||
          (!bootstrap && (!epoch?.live || epoch.epoch !== existing.target_epoch)) ||
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
        await assertClaim(tx);
        return { current, op: existing, first: false, bootstrap };
      }
      if (claim && !firstWakeClaim) throw new VaultError("conflict", "Runtime resume intent disappeared.");
      if (!prepare)
        throw new VaultError("unavailable", "Trusted runtime resume policy is unavailable; no compute was activated.");
      if (
        current.status !== "stopped" ||
        !current.stoppedAt ||
        current.stopRequestedAt ||
        fence.lease ||
        !epoch ||
        current.lifecycleGeneration === undefined
      )
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
      const transition = await transitionSandbox(tx, {
        sandboxId: found.id,
        expectedGeneration: current.lifecycleGeneration,
        fromStates: ["stopped"],
        toState: "starting",
        actor: "resume_admission",
        code: "runtime_resume_admitted",
        effects: [],
        settlement: {
          lease: null,
          statusReason: null,
          stopRequestedAt: null,
          stoppedAt: null,
          activityLease: requestId,
        },
      });
      if (transition.kind === "conflict")
        throw new VaultError("conflict", "Runtime resume admission lost its retained stop or dispatch authority.");
      await recordResumeAcceptedAt(tx, found.id, requestId);
      const active = await createSqlData(tx)(caller).sandboxes.get(found.id);
      if (!active) throw new VaultError("not_found", "Runtime resume admission disappeared.");
      return { current: active, op, first: true, bootstrap: false };
    };
    let admission: Awaited<ReturnType<typeof admit>> | undefined;
    if (firstWakeClaim) {
      await firstWakeClaim.handoffGeneration({
        lockPrerequisites: lockAccount,
        async advance(tx, job) {
          const { payload } = job;
          if (
            job.sandbox_id !== found.id ||
            !payload ||
            typeof payload !== "object" ||
            !("requestId" in payload) ||
            payload.requestId !== requestId
          )
            throw new VaultError("conflict", "Queued wake does not match the claimed turn job.");
          admission = await admit(tx);
        },
      });
    } else {
      admission = await sql.transaction(async (tx) => {
        await lockAccount(tx);
        return admit(tx);
      });
    }
    const admitted = admission;
    if (!admitted) throw new Error("Runtime wake handoff did not admit a resume.");
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
        if (patch.renewActivity && claim) {
          return sql.transaction!(async (tx) => {
            await tx.query("select id from public.sandboxes where id=$1 for update", [id]);
            await assertClaim(tx);
            await createSqlData(tx)(caller).sandboxes.update(id, patch);
            await assertClaim(tx);
          });
        }
        if (!patch.finishActivity) return store.update(id, patch);
        await authority.withOwner(found.id, caller.userId, async (tx, scope) => {
          if (scope.epoch !== admitted.op.target_epoch || !receipt || patch.expectedGeneration === undefined)
            throw new VaultError("conflict", "Resume epoch changed before publication.");
          await assertClaim(tx);
          await publishRuntimeWake(
            tx,
            id,
            patch.expectedGeneration,
            requestId,
            receipt.promptId,
            admitted.op.empty_checkpoint ? [conversation] : admitted.current.conversationIds,
          );
          if (found.runtimeTransport === "dialout") await restoreModalResumeSchedule(tx, id);
          const saved = await tx.query(
            "update public.runtime_resumes set phase='complete',receipt=$3::jsonb where sandbox_id=$1 and request_id=$2 and phase='dispatched' returning request_id",
            [found.id, requestId, JSON.stringify(receipt)],
          );
          if (!saved.rows.length) throw new VaultError("conflict", "Resume publication changed.");
          await assertClaim(tx);
        });
      },
    };
    try {
      return await sandboxActivity(
        publishing,
        admitted.current,
        {},
        async (signal) => {
          if (admitted.first || admitted.bootstrap) {
            placement = await prepare!(caller, admitted.current);
            const confirmActivation = async () => {
              if (
                !(await confirmRuntimeResumeActivation(sql, found.id, requestId, admitted.current.lifecycleGeneration))
              )
                throw new VaultError("conflict", "Resume activation authority changed.");
            };
            const ready = await placement.start(
              signal,
              restore,
              confirmActivation,
              claim ? assertClaim : undefined,
              admitted.bootstrap
                ? async (tx) => {
                    if (!(await canBootstrap(tx)))
                      throw new VaultError("conflict", "Confirmed resume bootstrap authority changed.");
                  }
                : undefined,
            );
            if (ready.epoch !== admitted.op.target_epoch) throw new VaultError("conflict", "Unexpected resume epoch.");
          }
          const commandGuard = claim ? assertClaim : undefined;
          // Reconciliation also needs live proof that the checkpoint was restored.
          await agent.health(
            signal,
            restore,
            commandGuard ? { expectedEpoch: admitted.op.target_epoch, assertClaim: commandGuard } : undefined,
          );
          await authority.withOwner(found.id, caller.userId, async (tx, scope) => {
            if (scope.epoch !== admitted.op.target_epoch) throw new VaultError("conflict", "Resume epoch changed.");
            await assertClaim(tx);
            await tx.query(
              "update public.runtime_resumes set verified_at=coalesce(verified_at,now()) where sandbox_id=$1 and request_id=$2",
              [found.id, requestId],
            );
            await assertClaim(tx);
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
            if (!admitted.first && !admitted.bootstrap && (found.provider === "modal" || found.provider === "boat"))
              await environment.deliver(
                found.provider,
                actor,
                found.id,
                admitted.op.target_epoch,
                signal,
                commandGuard,
              );
            await prepareGitHub?.(caller, found.id, commandGuard);
            await prepareMcp?.(caller, found.id, signal, commandGuard);
            if (found.runtimeTransport === "dialout")
              await restoreScopedAccess?.(
                caller.userId,
                found.id,
                admitted.op.target_epoch,
                String(admitted.current.lifecycleGeneration),
                signal,
                commandGuard,
              );
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
            commandGuard,
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
            patch: {},
          };
        },
        { initialLeaseId: requestId, deadlineMs: 600_000 },
      );
    } catch (error) {
      const preActivationArchive = error instanceof BoatRetentionUnconfirmed;
      const completed = await read(sql, found.id, requestId).catch(() => undefined);
      if (completed?.receipt && (await store.get(found.id))) return completed.receipt;
      const cleanup = await sql
        .transaction(async (tx) => {
          const member = await tx.query(
            "select user_id from public.members where user_id=$1 and org_id=$2 for update",
            [caller.userId, found.orgId],
          );
          if (!member.rows.length) return;
          await tx.query("select id from public.sandboxes where id=$1 for update", [found.id]);
          const runtime = (
            await tx.query<{ epoch: string; live: boolean; ticket_issued: boolean; activation_confirmed: boolean }>(
              `select epoch::text,(runtime_hash is not null) as live,
                  (enrolment_hash is not null and lifecycle_generation=$2) as ticket_issued,
                  exists(
                    select 1 from public.runtime_resumes where sandbox_id=$1 and request_id=$3
                      and phase='dispatched' and activated_at is not null
                  ) as activation_confirmed
               from public.runtime_enrolments where sandbox_id=$1 for update`,
              [found.id, admitted.current.lifecycleGeneration, requestId],
            )
          ).rows[0];
          if (runtime?.live && runtime.epoch === admitted.op.target_epoch) return;
          const boatSourceEpoch =
            found.provider === "boat" && runtime && !runtime.live && runtime.epoch === admitted.op.source_epoch;
          const retained = Boolean(
            (boatSourceEpoch && (runtime.ticket_issued || runtime.activation_confirmed || preActivationArchive)) ||
              (found.runtimeTransport === "dialout" &&
                runtime?.activation_confirmed &&
                !runtime.live &&
                runtime.epoch === admitted.op.source_epoch),
          );
          await assertClaim(tx);
          if (boatSourceEpoch && !retained && error instanceof BoatResumeActivationUncertain) {
            await deferAmbiguousBoatResume(tx, found.id, requestId, admitted.current.lifecycleGeneration);
            await assertClaim(tx);
            return;
          }
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
