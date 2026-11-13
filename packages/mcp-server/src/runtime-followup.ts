import { ProviderError, type Sql, sandboxActivity, VaultError } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { createSqlData } from "./data.ts";
import { createRuntimeAgent } from "./runtime-agent.ts";
import type { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";

export interface RuntimeFollowupInput {
  id: string;
  prompt: string;
  request_id?: string | undefined;
  conversation_id?: string | undefined;
  model?: string | undefined;
  reasoning_effort?: string | undefined;
}
export type RuntimeFollowup = ReturnType<typeof createRuntimeFollowup>;
/** Running, owner-scoped, model-only continuation. No host, native credential
 * hooks, resume, model switching or new conversation. Commands are durable;
 * the client MUST reuse request_id and identical input on uncertain delivery.
 */
export function createRuntimeFollowup(sql: Sql, key: string, commands: ReturnType<typeof createRuntimeCommands>) {
  const authority = createRuntimeEnrolments(sql, key);
  return async (caller: Caller, input: RuntimeFollowupInput) => {
    const requestId = input.request_id?.toLowerCase();
    if (!requestId || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(requestId) || !input.prompt.trim())
      throw new VaultError("invalid", "Runtime send requires a request_id UUID and nonempty prompt.");
    const store = createSqlData(sql)(caller).sandboxes;
    const found = await store.get(input.id);
    if (
      !found ||
      found.ownerId !== caller.userId ||
      !found.boatRuntime ||
      found.harness !== "codex" ||
      found.provider !== "boat"
    )
      throw new VaultError("not_found", "No owned runtime sandbox.");
    if (
      !found.model ||
      !found.reasoningEffort ||
      !found.credentialId ||
      !found.credentialVersion ||
      !["ready", "running"].includes(found.status) ||
      found.stopRequestedAt ||
      found.deletedAt
    )
      throw new VaultError("conflict", "Runtime send requires an already-running, bound sandbox.");
    if (input.model !== undefined || input.reasoning_effort !== undefined)
      throw new VaultError("invalid", "Runtime follow-up uses the launch model and effort.");
    const conversation = input.conversation_id ?? found.conversationIds.at(-1);
    if (!conversation || !found.conversationIds.includes(conversation))
      throw new VaultError("invalid", "Continue an existing runtime conversation.");
    const commandId = `follow_${requestId}`;
    const agent = createRuntimeAgent(commands, {
      ownerId: caller.userId,
      sandboxId: found.id,
      providerSandboxId: found.providerSandboxId,
      cwd: found.repositoryDir ? `/home/user/${found.repositoryDir}` : "/home/user",
      defaults: { model: found.model, reasoningEffort: found.reasoningEffort },
    });
    // Read-only probe before admission. Runner still owns the final busy check.
    const previous = await commands.result(caller.userId, found.id, commandId);
    if (previous.state === "missing" && found.taskPromptId) {
      const last = await agent.getPrompt({ sandboxId: found.providerSandboxId, promptId: found.taskPromptId });
      if (!last.done) throw new VaultError("conflict", "Wait for the current runtime prompt to finish.");
    }
    if (!sql.transaction) throw new VaultError("unavailable", "Runtime send requires transactional admission.");
    const admitted = await sql.transaction(async (tx) => {
      // Same lock order as account publication: membership -> credential -> sandbox -> epoch.
      const member = (
        await tx.query("select user_id from public.members where user_id=$1 and org_id=$2 for update", [
          caller.userId,
          found.orgId,
        ])
      ).rows[0];
      if (!member) throw new VaultError("not_found", "Runtime membership was revoked.");
      const account = (
        await tx.query(
          `select id from public.credentials where id=$1 and version=$2
        and status='active' and kind in ('openai','codex_auth') and (expires_at is null or expires_at>now())
        and ((scope='user' and owner_id=$3) or (scope='org' and owner_id=$4)) for update`,
          [found.credentialId, found.credentialVersion, caller.userId, found.orgId],
        )
      ).rows[0];
      if (!account) throw new VaultError("not_found", "The pinned runtime account is no longer authorized.");
      // Reuse this transaction; never hold its locks across a second connection or runtime I/O.
      const local = {
        ...tx,
        query: tx.query.bind(tx),
        transaction: async <T>(work: (tx: Sql) => Promise<T>) => work(tx),
      };
      return createRuntimeEnrolments(local, key).withOwner(found.id, caller.userId, async (locked, scope) => {
        const current = await createSqlData(locked)(caller).sandboxes.get(found.id);
        const lease = (
          await locked.query<{ activity_lease_id: string | null; reconciling: boolean }>(
            "select activity_lease_id,(reconcile_lease_until>now()) as reconciling from public.sandboxes where id=$1",
            [found.id],
          )
        ).rows[0];
        if (
          !current ||
          current.lifecycleGeneration === undefined ||
          !lease ||
          lease.reconciling ||
          !["ready", "running"].includes(current.status) ||
          current.credentialId !== found.credentialId ||
          current.credentialVersion !== found.credentialVersion ||
          current.model !== found.model ||
          current.reasoningEffort !== found.reasoningEffort ||
          !current.conversationIds.includes(conversation)
        )
          throw new VaultError("conflict", "Runtime admission changed; inspect status before retrying.");
        const saved = (
          await locked.query<{ epoch: string; finished: boolean }>(
            "select epoch::text,result_enc is not null as finished from public.runtime_commands where sandbox_id=$1 and request_id=$2",
            [found.id, commandId],
          )
        ).rows[0];
        if (!saved && current.taskPromptId !== found.taskPromptId)
          throw new VaultError(
            "conflict",
            "Another runtime turn was admitted; inspect status before sending new work.",
          );
        if (saved && saved.epoch !== scope.epoch)
          throw new VaultError("conflict", "Runtime command belongs to an older epoch.");
        if (saved?.finished && lease.activity_lease_id !== requestId)
          return { current, epoch: scope.epoch, replay: true };
        if (lease.activity_lease_id === requestId) {
          await createSqlData(locked)(caller).sandboxes.update(found.id, {
            renewActivity: true,
            activityToken: requestId,
            expectedGeneration: current.lifecycleGeneration,
          });
          return { current, epoch: scope.epoch, replay: false };
        }
        if (lease.activity_lease_id || saved)
          throw new VaultError("conflict", "Runtime admission is busy or uncertain; reuse the original request_id.");
        await createSqlData(locked)(caller).sandboxes.update(found.id, {
          status: "running",
          clearTaskOutcome: true,
          advanceGeneration: true,
          activityToken: requestId,
          expectedGeneration: current.lifecycleGeneration,
        });
        const active = await createSqlData(locked)(caller).sandboxes.get(found.id);
        if (!active) throw new VaultError("not_found", "Runtime admission disappeared.");
        return { current: active, epoch: scope.epoch, replay: false };
      });
    });
    const submit = (signal?: AbortSignal) =>
      agent.prompt(
        {
          sandboxId: found.providerSandboxId,
          harness: "codex",
          text: input.prompt,
          conversationId: conversation,
          ...(signal ? { signal } : {}),
        },
        commandId,
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
      update: (id: string, patch: Parameters<typeof store.update>[1]) =>
        authority.withOwner(found.id, caller.userId, async (tx, scope) => {
          if (scope.epoch !== admitted.epoch)
            throw new VaultError("conflict", "Runtime epoch changed before publication.");
          await createSqlData(tx)(caller).sandboxes.update(id, patch);
        }),
    };
    return sandboxActivity(
      publishingStore,
      admitted.current,
      {},
      async (signal) => {
        const accepted = await submit(signal);
        try {
          await store.recordTurnModel?.(found.id, accepted.promptId, found.model);
        } catch {
          /* Accepted work continues. */
        }
        return {
          result: receipt(accepted),
          patch: {
            status: "running",
            taskPromptId: accepted.promptId,
            conversationIds: admitted.current.conversationIds,
            statusReason: null,
          },
        };
      },
      { initialLeaseId: requestId, deadlineMs: 150_000 },
    ).catch((error) => {
      // Unknown work retains its lease; only identical request_id/input can reconcile it.
      if (error instanceof ProviderError || error instanceof VaultError) throw error;
      throw new VaultError(
        "conflict",
        "Runtime send outcome is uncertain; reuse the original request_id and identical input.",
      );
    });
  };
}
