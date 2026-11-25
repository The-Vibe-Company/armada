import { isSandboxProvider } from "@armada/core";
import {
  modalLaunchSetupKeySql,
  ProviderError,
  retainFailureDiagnostic,
  type Sql,
  sandboxActivity,
  VaultError,
} from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { createSqlData } from "./data.ts";
import { createGoldenRuntimeEnvironment } from "./golden-runtime-environment.ts";
import { assertModalLaunchSetup, ModalLaunchSetupConflict } from "./jobs/modal-launch-setup.ts";
import type { createResumeJob } from "./jobs/resume.ts";
import { unresolvedResume } from "./modal-launch-handoff.ts";
import { canRepeatPinnedRuntimeSettings, runtimeBridgeTarget } from "./provider-runtime-admission.ts";
import { lockRuntimeAccount } from "./runtime-account-admission.ts";
import { runtimeAgentFor } from "./runtime-agent.ts";
import type { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments, runtimeTransaction } from "./runtime-enrolment.ts";
import type { RuntimeMcp } from "./runtime-mcp.ts";
import { RuntimeReconciliationConflict } from "./runtime-reconciliation-conflict.ts";
import type { RuntimeTurnClaim } from "./runtime-resume.ts";
import { historicalRuntimeResumeReceipt } from "./runtime-resume-receipts.ts";
import { appendConversation } from "./sandbox-activity.ts";
import type { RestoreScopedRuntimeAccess } from "./sandbox-armada-access.ts";
import { refuseConversationSelector } from "./sandbox-conversation.ts";

export interface RuntimeFollowupInput {
  id: string;
  prompt: string;
  request_id?: string | undefined;
  model?: string | undefined;
  reasoning_effort?: string | undefined;
}
export type RuntimeFollowup = ReturnType<typeof createRuntimeFollowup>;
export class RuntimeFollowupConflict extends VaultError {
  constructor(
    readonly reason:
      | "sandbox_not_ready"
      | "runtime_binding_missing"
      | "runtime_prompt_running"
      | "runtime_reconciliation_active"
      | "runtime_admission_changed"
      | "runtime_activity_busy",
    message: string,
  ) {
    super("conflict", message);
  }
}

/** Running, owner-scoped, model-only continuation. No host, native credential
 * hooks, model switching or arbitrary new conversations. Idle Boat workers
 * open their first conversation using a request-derived identity. Stopped workers use the existing
 * checkpointed resume path when supplied. Commands are durable;
 * the client MUST reuse request_id and identical input on uncertain delivery.
 */
export function createRuntimeFollowup(
  sql: Sql,
  key: string,
  commands: ReturnType<typeof createRuntimeCommands>,
  prepareMcp?: RuntimeMcp["prepare"],
  restoreScopedAccess?: RestoreScopedRuntimeAccess,
  wakeResume?: ReturnType<typeof createResumeJob>["wake"],
) {
  const authority = createRuntimeEnrolments(sql, key);
  const environment = createGoldenRuntimeEnvironment(sql, key);
  return async (caller: Caller, input: RuntimeFollowupInput, claim?: RuntimeTurnClaim, { fromQueue = false } = {}) => {
    refuseConversationSelector(input);
    const requestId = input.request_id?.toLowerCase();
    if (!requestId || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(requestId) || !input.prompt.trim())
      throw new VaultError("invalid", "Runtime send requires a request_id UUID and nonempty prompt.");
    const store = createSqlData(sql)(caller).sandboxes;
    const found = await store.get(input.id);
    if (!found || found.ownerId !== caller.userId || !runtimeBridgeTarget(found))
      throw new VaultError("not_found", "No owned runtime sandbox.");
    // Redundant pinned settings stay out of durable command/resume identity.
    const repeatPinned = canRepeatPinnedRuntimeSettings(found.provider);
    if (
      (input.model !== undefined && (!repeatPinned || input.model !== found.model)) ||
      (input.reasoning_effort !== undefined && (!repeatPinned || input.reasoning_effort !== found.reasoningEffort))
    )
      throw new VaultError("invalid", "Runtime follow-up uses the launch model and effort.");
    const assertDirectLaunchReady = async () => {
      if (claim) return;
      const {
        rows: [setup],
      } = await sql.query<{ state: string | null; prompt_pending: boolean }>(
        `select j.state, exists (
           select 1 from public.account_turn_queue q
           where q.sandbox_id=s.id and q.request_id=j.id and q.state in ('queued','dispatching')
             and (q.request_id is distinct from $5::uuid or q.state<>'dispatching')
         ) as prompt_pending
         from public.sandboxes s left join public.jobs j on j.idem_key=${modalLaunchSetupKeySql()}
         where s.id=$1 and s.owner_id=$2 and s.org_id=$3 and s.lifecycle_generation=$4
           and not ${unresolvedResume("s")}`,
        [found.id, caller.userId, found.orgId, found.lifecycleGeneration, fromQueue ? requestId : null],
      );
      if (!setup)
        throw new RuntimeFollowupConflict(
          "runtime_admission_changed",
          "Runtime admission changed; inspect status before retrying.",
        );
      assertModalLaunchSetup(setup.state);
      if (setup.prompt_pending) throw new ModalLaunchSetupConflict("modal_launch_prompt_pending");
    };
    if (fromQueue && found.boatRuntime) {
      const historical = await historicalRuntimeResumeReceipt(sql, caller, {
        id: found.id,
        requestId,
        prompt: input.prompt,
      });
      if (historical) return historical;
    }
    if (found.status === "stopped") {
      if (found.stopRequestedAt || found.deletedAt)
        throw new VaultError("conflict", "Resume requires the admitted retained stop.");
      const previous = (
        await sql.query("select request_id from public.runtime_commands where sandbox_id=$1 and request_id=$2", [
          found.id,
          `follow_${requestId}`,
        ])
      ).rows[0];
      if (previous)
        throw new VaultError("conflict", "This request_id belongs to an earlier follow-up; use a new ID for new work.");
      await assertDirectLaunchReady();
      if (!wakeResume) throw new VaultError("unavailable", "Runtime resume jobs are unavailable.");
      return wakeResume(caller, found, requestId, claim);
    }
    if (
      !found.model ||
      !found.reasoningEffort ||
      !found.credentialId ||
      !found.credentialVersion ||
      !["ready", "running"].includes(found.status) ||
      found.stopRequestedAt ||
      found.deletedAt
    )
      throw new RuntimeFollowupConflict(
        ["ready", "running"].includes(found.status) && !found.stopRequestedAt && !found.deletedAt
          ? "runtime_binding_missing"
          : "sandbox_not_ready",
        "Runtime send requires an already-running, bound sandbox.",
      );
    // A stable server-owned first-conversation ID keeps uncertain first-send
    // payloads identical even after publication adds that conversation to SQL.
    const firstConversation = `first_${requestId}`;
    const conversation = found.conversationIds.at(-1) ?? firstConversation;
    const idleFirst = found.conversationIds.length === 0 && !found.taskPromptId;
    if (!found.conversationIds.length && !idleFirst)
      throw new VaultError("invalid", "Continue an existing runtime conversation.");
    const commandId = `follow_${requestId}`;
    const agent = runtimeAgentFor(commands, caller.userId, found, {
      model: found.model,
      reasoningEffort: found.reasoningEffort,
    });
    const assertClaim = async (tx: Sql) => {
      if (claim && !(await claim.canDispatch(tx)))
        throw new VaultError("conflict", "Queued runtime turn lease is no longer current.");
    };
    const commandGuard = claim ? assertClaim : undefined;
    // Read-only probe before admission. Runner still owns the final busy check.
    const previous = await commands.result(caller.userId, found.id, commandId);
    if (previous.state === "missing") await assertDirectLaunchReady();
    const preflight =
      previous.state === "missing"
        ? (
            await sql.query<{
              turn_settled: boolean;
              has_template: boolean;
              epoch: string | null;
              env_delivered: boolean;
            }>(
              `select
                 ($2::text is not null
                   and exists(select 1 from public.runtime_idle_turns where sandbox_id=$1 and prompt_id=$2 and settled)
                   and not exists(select 1 from public.runtime_idle_turns where sandbox_id=$1 and not settled)
                 ) as turn_settled,
                 exists(select 1 from public.template_launch_requests r where r.sandbox_id=$1) as has_template,
                 e.epoch::text as epoch,
                 (e.epoch is not null and exists(
                   select 1 from public.runtime_commands c
                   where c.sandbox_id=$1 and c.epoch=e.epoch and c.request_id=$3 || e.epoch::text and c.result_enc is not null
                 )) as env_delivered
               from public.sandboxes s
               left join public.runtime_enrolments e on e.sandbox_id=s.id and e.runtime_hash is not null
               where s.id=$1`,
              [found.id, found.taskPromptId ?? null, `${found.provider}_variables_${found.id}_`],
            )
          ).rows[0]
        : undefined;
    if (previous.state === "missing" && found.taskPromptId && !preflight?.turn_settled) {
      const last = await agent.getPrompt({ sandboxId: found.providerSandboxId, promptId: found.taskPromptId });
      if (!last.done)
        throw new RuntimeFollowupConflict("runtime_prompt_running", "Wait for the current runtime prompt to finish.");
    }
    let configuredEpoch: string | undefined;
    if (previous.state === "missing" && isSandboxProvider(found.provider) && preflight?.has_template) {
      const envRequestId = preflight.epoch ? `${found.provider}_variables_${found.id}_${preflight.epoch}` : undefined;
      const cachedEnv =
        envRequestId && preflight.env_delivered
          ? await commands.result(caller.userId, found.id, envRequestId, preflight.epoch!)
          : undefined;
      if (
        cachedEnv?.state === "finished" &&
        cachedEnv.reply.status === 200 &&
        cachedEnv.reply.body.version === 1 &&
        cachedEnv.reply.body.requestId === envRequestId &&
        cachedEnv.reply.body.error === undefined &&
        (cachedEnv.reply.body.result as { acknowledged?: boolean } | undefined)?.acknowledged === true
      ) {
        await environment.validate(found.provider, { userId: caller.userId, orgId: found.orgId }, found.id);
        configuredEpoch = preflight.epoch!;
      } else {
        configuredEpoch = await environment.deliver(
          found.provider,
          { userId: caller.userId, orgId: found.orgId },
          found.id,
          undefined,
          undefined,
          commandGuard,
        );
      }
    }
    if (!sql.transaction) throw new VaultError("unavailable", "Runtime send requires transactional admission.");
    const admitted = await sql.transaction(async (tx) => {
      await lockRuntimeAccount(tx, caller, found, "The pinned runtime account is no longer authorized.");
      // Reuse this transaction; never hold its locks across a second connection or runtime I/O.
      const local = runtimeTransaction(tx);
      return createRuntimeEnrolments(local, key).withOwner(found.id, caller.userId, async (locked, scope) => {
        await assertClaim(locked);
        const current = await createSqlData(locked)(caller).sandboxes.get(found.id);
        const lease = (
          await locked.query<{
            activity_lease_id: string | null;
            reconciling: boolean;
            extending: boolean;
            mcp_unchanged: boolean;
          }>(
            `select s.activity_lease_id,(s.reconcile_lease_until>now()) as reconciling,
               (s.provider='boat' and s.boat_runtime and exists (
                 select 1 from public.jobs j where j.sandbox_id=s.id and j.kind='boat_runtime_extend'
                   and j.state='leased' and j.lease_until>clock_timestamp()
               )) as extending,
               (exists(
                 select 1 from public.mcp_bootstraps b
                 where b.sandbox_id=s.id and b.configured and b.physical_generation='runtime:' || $2::text
               ) and not exists(
                 select 1 from public.mcp_invalidations mi where mi.org_id=s.org_id and mi.created_at>=s.created_at
               ) and not exists(
                 select 1 from public.mcp_leases l
                 where l.sandbox_id=s.id and l.runtime_epoch=$2::bigint and l.revoked_at is not null
               ) and not exists(
                 select 1 from public.mcp_bindings mb
                 join public.mcp_connections c on c.id=mb.connection_id
                 join public.mcp_grants g on g.id=mb.grant_id and g.connection_id=c.id
                 where mb.sandbox_id=s.id and (
                   c.transport='stdio' or c.disabled
                   or public.mcp_grant_effective_status(g.status,g.revoked_at,g.refresh_consumed,g.refresh_until)<>'connected'
                   or not exists(
                     select 1 from public.mcp_leases l
                     where l.sandbox_id=s.id and l.connection_id=mb.connection_id
                       and l.runtime_epoch=$2::bigint and l.generation=g.generation
                       and l.sandbox_generation=s.mcp_generation and l.revoked_at is null and l.expires_at>now()
                   )
                 )
               )) as mcp_unchanged
             from public.sandboxes s where s.id=$1`,
            [found.id, scope.epoch],
          )
        ).rows[0];
        if (
          !current ||
          current.lifecycleGeneration === undefined ||
          current.lifecycleGeneration !== found.lifecycleGeneration ||
          !lease ||
          !["ready", "running"].includes(current.status) ||
          current.credentialId !== found.credentialId ||
          current.credentialVersion !== found.credentialVersion ||
          current.model !== found.model ||
          current.reasoningEffort !== found.reasoningEffort ||
          !(
            current.conversationIds.at(-1) === conversation ||
            (idleFirst && current.conversationIds.length === 0 && !current.taskPromptId)
          )
        )
          throw new RuntimeFollowupConflict(
            "runtime_admission_changed",
            "Runtime admission changed; inspect status before retrying.",
          );
        // The durable command identity decides first: an admitted turn may have executed, so the
        // checkpoint fence below refuses only new work and never hides a stored reply.
        const saved = (
          await locked.query<{ epoch: string; finished: boolean }>(
            "select epoch::text,result_enc is not null as finished from public.runtime_commands where sandbox_id=$1 and request_id=$2",
            [found.id, commandId],
          )
        ).rows[0];
        if (lease.reconciling) {
          if (saved || previous.state !== "missing" || lease.activity_lease_id === requestId)
            throw new RuntimeFollowupConflict(
              "runtime_reconciliation_active",
              "Runtime admission changed; inspect status before retrying.",
            );
          throw new RuntimeReconciliationConflict();
        }
        const checkpoint =
          !saved &&
          (
            await locked.query("select 1 from public.runtime_checkpoints where sandbox_id=$1 and epoch=$2", [
              found.id,
              scope.epoch,
            ])
          ).rows[0];
        if (checkpoint)
          throw new VaultError(
            "conflict",
            "Runtime checkpoint is pending or complete; stop it before a fresh enrolment.",
          );
        if (!saved && current.taskPromptId !== found.taskPromptId)
          throw new VaultError(
            "conflict",
            "Another runtime turn was admitted; inspect status before sending new work.",
          );
        if (saved && saved.epoch !== scope.epoch)
          throw new VaultError("conflict", "Runtime command belongs to an older epoch.");
        if (!saved && configuredEpoch !== undefined && configuredEpoch !== scope.epoch)
          throw new VaultError("conflict", "Runtime environment epoch changed; retry the same request.");
        if (saved?.finished && lease.activity_lease_id !== requestId)
          return { current, epoch: scope.epoch, replay: true, mcpUnchanged: lease.mcp_unchanged };
        if (lease.extending || (lease.activity_lease_id !== requestId && (lease.activity_lease_id || saved)))
          throw new RuntimeFollowupConflict(
            "runtime_activity_busy",
            "Runtime admission is busy or uncertain; reuse the original request_id.",
          );
        if (lease.activity_lease_id === requestId) {
          await createSqlData(locked)(caller).sandboxes.update(found.id, {
            renewActivity: true,
            activityToken: requestId,
            expectedGeneration: current.lifecycleGeneration,
          });
          await assertClaim(locked);
          return { current, epoch: scope.epoch, replay: false, mcpUnchanged: lease.mcp_unchanged };
        }
        await createSqlData(locked)(caller).sandboxes.update(found.id, {
          turnActivity: "claim",
          clearTaskOutcome: true,
          queueRequestId: requestId,
          activityToken: requestId,
          expectedGeneration: current.lifecycleGeneration,
        });
        const active = await createSqlData(locked)(caller).sandboxes.get(found.id);
        if (!active) throw new VaultError("not_found", "Runtime admission disappeared.");
        await assertClaim(locked);
        return { current: active, epoch: scope.epoch, replay: false, mcpUnchanged: lease.mcp_unchanged };
      });
    });
    const pricingContext = await store.captureUsagePricingContext?.(found.id);
    const submit = (signal?: AbortSignal) =>
      agent.prompt(
        {
          sandboxId: found.providerSandboxId,
          harness: found.harness,
          text: input.prompt,
          conversationId: conversation,
          ...(signal ? { signal } : {}),
        },
        commandId,
        admitted.epoch,
        undefined,
        commandGuard,
      );
    const receipt = (value: Awaited<ReturnType<typeof submit>>) => ({
      id: found.id,
      ...value,
      requestId,
      runtime: { kind: "armada" as const, epoch: admitted.epoch },
    });
    if (admitted.replay) return receipt(await submit()); // Validates identical payload; never rewrites a newer task.
    const publishingStore = {
      ...store,
      update: (id: string, { finishActivity, ...patch }: Parameters<typeof store.update>[1]) =>
        authority.withOwner(found.id, caller.userId, async (tx, scope) => {
          if (scope.epoch !== admitted.epoch)
            throw new VaultError("conflict", "Runtime epoch changed before publication.");
          await assertClaim(tx);
          await createSqlData(runtimeTransaction(tx))(caller).sandboxes.update(id, {
            ...patch,
            ...(finishActivity ? { turnActivity: "finish" } : {}),
          });
          await assertClaim(tx);
        }),
    };
    return sandboxActivity(
      publishingStore,
      admitted.current,
      {},
      async (signal) => {
        const existing = await commands.result(caller.userId, found.id, commandId, admitted.epoch);
        if (existing.state === "missing") {
          if (!admitted.mcpUnchanged) await prepareMcp?.(caller, found.id, signal, commandGuard);
          if (found.boatRuntime || found.modalTransport === "dialout")
            await restoreScopedAccess?.(
              caller.userId,
              found.id,
              admitted.epoch,
              String(admitted.current.lifecycleGeneration),
              signal,
              commandGuard,
            );
        }
        const accepted = await submit(signal);
        try {
          await store.recordTurnModel?.(found.id, accepted.promptId, found.model, pricingContext);
        } catch {
          /* Accepted work continues. */
        }
        return {
          result: receipt(accepted),
          patch: {
            taskPromptId: accepted.promptId,
            conversationIds: appendConversation(admitted.current.conversationIds, conversation),
            statusReason: null,
          },
        };
      },
      { initialLeaseId: requestId, deadlineMs: 150_000 },
    ).catch((error) => {
      // Unknown work retains its lease; only identical request_id/input can reconcile it.
      if (error instanceof ProviderError || error instanceof VaultError) throw error;
      throw retainFailureDiagnostic(
        new VaultError(
          "conflict",
          "Runtime send outcome is uncertain; reuse the original request_id and identical input.",
        ),
        error,
      );
    });
  };
}
