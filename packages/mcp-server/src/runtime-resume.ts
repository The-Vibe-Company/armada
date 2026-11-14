import { sha256Hex } from "@armada/auth";
import { type PromptReceipt, type Sql, sandboxActivity, VaultError } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { createSqlData, type SandboxView } from "./data.ts";
import { lockRuntimeAccount } from "./runtime-account-admission.ts";
import { runtimeAgentFor } from "./runtime-agent.ts";
import type { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import type { RuntimeGitHub } from "./runtime-github.ts";
import type { RuntimeMcp } from "./runtime-mcp.ts";

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
  sourceCheckpoint: { epoch: string; watermark: number };
}
interface Operation {
  source_epoch: string;
  target_epoch: string;
  watermark: string;
  request_hash: string;
  conversation_id: string;
  model: string;
  reasoning_effort: string;
  phase: string;
  verified_at: string | null;
  receipt: RuntimeResumeReceipt | null;
}
export interface RuntimeResumePlacement {
  start(
    signal: AbortSignal,
    restore: { epoch: string; watermark: number; conversationId: string },
  ): Promise<{ epoch: string }>;
  /** Exact previously authorized compute identity; no activation/reissue on failure. */
  stop(): Promise<void>;
}
export type RuntimeResume = ReturnType<typeof createRuntimeResume>;
export type RuntimeResumePrepare = (caller: Caller, sandbox: SandboxView) => Promise<RuntimeResumePlacement>;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

/** Explicit stopped -> fresh epoch + same-conversation instruction. One dispatch,
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
  const read = async (tx: Sql, id: string, request: string) =>
    (
      await tx.query<Operation>(
        `select source_epoch::text,target_epoch::text,watermark::text,request_hash,conversation_id,model,reasoning_effort,phase,verified_at::text,receipt
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
    if (
      !found ||
      found.ownerId !== caller.userId ||
      !(
        (found.provider === "boat" && found.boatRuntime) ||
        (found.provider === "modal" && found.runtimeTransport === "dialout")
      ) ||
      (found.harness !== "codex" && found.harness !== "claude") ||
      found.deletedAt
    )
      throw new VaultError("not_found", "No owned runtime resume target.");
    const conversation = input.conversation_id ?? found.conversationIds.at(-1);
    if (!conversation || !found.conversationIds.includes(conversation))
      throw new VaultError("invalid", "Resume the existing conversation, never a new one.");
    const hash = await sha256Hex(JSON.stringify({ id: found.id, requestId, conversation, prompt: input.prompt }));
    const prior = await read(sql, found.id, requestId);
    if (prior?.request_hash !== undefined && prior.request_hash !== hash)
      throw new VaultError("conflict", "Reuse the original resume request_id with identical input.");
    if (prior?.receipt) {
      if (!(await store.get(found.id))) throw new VaultError("not_found", "Runtime membership was revoked.");
      return prior.receipt;
    } // Historical accepted outcome, not a new activation.
    if (!sql.transaction) throw new VaultError("unavailable", "Runtime resume requires transactional admission.");
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
        !current.conversationIds.includes(conversation)
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
        model: current.model,
        reasoning_effort: current.reasoningEffort,
        phase: "dispatched",
        verified_at: null,
        receipt: null,
      };
      await tx.query(
        `insert into public.runtime_resumes(sandbox_id,request_id,source_epoch,target_epoch,watermark,request_hash,conversation_id,model,reasoning_effort) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
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
        ],
      );
      await createSqlData(tx)(caller).sandboxes.update(found.id, {
        status: "starting",
        stoppedAt: null,
        stopRequested: false,
        advanceGeneration: true,
        activityToken: requestId,
        clearTaskOutcome: true,
        ...(current.lifecycleGeneration !== undefined ? { expectedGeneration: current.lifecycleGeneration } : {}),
      });
      const active = await createSqlData(tx)(caller).sandboxes.get(found.id);
      if (!active) throw new VaultError("not_found", "Runtime resume admission disappeared.");
      return { current: active, op, first: true };
    });
    if (admitted.op.receipt) return admitted.op.receipt;
    const restore = {
      epoch: admitted.op.source_epoch,
      watermark: Number(admitted.op.watermark),
      conversationId: conversation,
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
            const ready = await placement.start(signal, restore);
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
            if (found.provider === "boat") await prepareGitHub?.(caller, found.id);
            await prepareMcp?.(caller, found.id, signal);
          }
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
          );
          if (accepted.conversationId !== conversation || !accepted.promptId)
            throw new VaultError("conflict", "Runtime did not continue the restored conversation.");
          receipt = {
            id: found.id,
            requestId,
            promptId: accepted.promptId,
            conversationId: conversation,
            status: accepted.status,
            resumed: true,
            runtime: { kind: "armada", epoch: admitted.op.target_epoch },
            sourceCheckpoint: { epoch: restore.epoch, watermark: restore.watermark },
          };
          try {
            await store.recordTurnModel?.(found.id, accepted.promptId, admitted.op.model);
          } catch {
            /* Accepted work continues. */
          }
          return {
            result: receipt,
            patch: {
              status: "running",
              statusReason: null,
              taskPromptId: accepted.promptId,
              conversationIds: admitted.current.conversationIds,
            },
          };
        },
        { initialLeaseId: requestId, deadlineMs: 600_000 },
      );
    } catch {
      const completed = await read(sql, found.id, requestId).catch(() => undefined);
      if (completed?.receipt && (await store.get(found.id))) return completed.receipt;
      // Preserve recoverable live-epoch uncertainty. Never re-activate or reissue a ticket.
      const owned = await sql
        .transaction(async (tx) => {
          await tx.query("select user_id from public.members where user_id=$1 and org_id=$2 for update", [
            caller.userId,
            found.orgId,
          ]);
          await tx.query("select id from public.sandboxes where id=$1 for update", [found.id]);
          const live = (
            await tx.query<{ epoch: string; live: boolean }>(
              "select epoch::text,(runtime_hash is not null) as live from public.runtime_enrolments where sandbox_id=$1 for update",
              [found.id],
            )
          ).rows[0];
          if (live?.live && live.epoch === admitted.op.target_epoch) return false;
          const changed = await tx.query(
            `update public.sandboxes set status='failed',status_reason='Runtime resume failed before a restored worker was confirmed; cleanup requested.',stop_requested_at=coalesce(stop_requested_at,now()),activity_lease_id=null,activity_until=null,lifecycle_generation=lifecycle_generation+1,reconcile_after=now()
          where id=$1 and activity_lease_id=$2 and lifecycle_generation=$3 and stop_requested_at is null returning id`,
            [found.id, requestId, admitted.current.lifecycleGeneration],
          );
          if (changed.rows.length)
            await tx.query(
              "update public.runtime_resumes set phase='failed' where sandbox_id=$1 and request_id=$2 and receipt is null",
              [found.id, requestId],
            );
          return changed.rows.length > 0;
        })
        .catch(() => false);
      if (owned && placement) await placement.stop().catch(() => {});
      throw new VaultError(
        "conflict",
        "Runtime resume outcome is uncertain; retain the original request_id, inspect status/stop, and do not launch or activate again.",
      );
    }
  };
}
