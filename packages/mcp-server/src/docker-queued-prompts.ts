import { createHash, randomUUID } from "node:crypto";
import {
  DOCKER_IMAGE_UNAVAILABLE_MESSAGE,
  DOCKER_LAUNCH_FAILURE_MESSAGES,
  type DockerQueuedPromptReceipt,
  ProviderError,
  type Sql,
} from "@armada/core";
import { decryptSecret, encryptSecret } from "@armada/core/server";
import type { Caller } from "./caller.ts";

export function queuedFailure(reason: string | null): string {
  return reason === DOCKER_IMAGE_UNAVAILABLE_MESSAGE ||
    Object.values(DOCKER_LAUNCH_FAILURE_MESSAGES).some((v) => v === reason)
    ? reason!
    : "Docker sandbox stopped or failed before the queued prompt could run.";
}
export type QueuedDockerPrompt = {
  sandbox_id: string;
  request_id: string;
  prompt_id: string;
  conversation_id: string | null;
  owner_id: string;
  actor_epoch: string;
  lifecycle_generation: string;
  input_enc: Uint8Array<ArrayBuffer>;
  input_hash: string;
  status: "queued" | "dispatching" | "admitted" | "failed";
  failure_reason: string | null;
};
export function createDockerQueuedPrompts(sql: Sql, key: string) {
  async function resolveConversation(tx: Sql, sandboxId: string, actual: readonly string[]): Promise<string> {
    if (actual[0]) return actual[0];
    const launch = (
      await tx.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
        "select request_enc from public.docker_launch_requests where sandbox_id=$1",
        [sandboxId],
      )
    ).rows[0];
    if (!launch)
      throw new ProviderError({
        provider: "docker",
        code: "unavailable",
        message: "Launch conversation is unavailable.",
        retryable: true,
      });
    const manifest = JSON.parse(await decryptSecret(launch.request_enc, key));
    const conversationId = manifest.conversationId ?? manifest.promptId;
    if (typeof conversationId !== "string" || !/^[a-f0-9-]{36}$/.test(conversationId))
      throw Error("invalid launch conversation");
    // An old runtime command without a reserved identity must reconcile its genuine receipt first.
    if (
      manifest.conversationId === undefined &&
      (
        await tx.query(
          "select 1 from public.runtime_commands where sandbox_id=$1 and starts_with(request_id,'docker_prompt_') and result_enc is null",
          [sandboxId],
        )
      ).rows.length
    )
      throw new ProviderError({
        provider: "docker",
        code: "unavailable",
        message: "Legacy launch conversation is still reconciling. Inspect its status before retrying.",
        retryable: true,
      });
    return conversationId;
  }
  return {
    async accept(
      caller: Caller,
      sandboxId: string,
      orgId: string,
      input: { request_id: string; prompt: string; conversation_id?: string },
    ): Promise<DockerQueuedPromptReceipt | null> {
      const payload = JSON.stringify({ prompt: input.prompt, conversationId: input.conversation_id ?? null });
      const hash = createHash("sha256").update(payload).digest("hex");
      if (!sql.transaction) throw Error("transaction required");
      return sql.transaction(async (tx) => {
        const member = (
          await tx.query<{ epoch: string }>(
            `select e.epoch::text from public.members m join public.mcp_actor_epochs e using(org_id,user_id)
          where m.org_id=$1 and m.user_id=$2 for share of m`,
            [orgId, caller.userId],
          )
        ).rows[0];
        if (!member)
          throw new ProviderError({
            provider: "docker",
            code: "not_found",
            message: "Sandbox not found.",
            retryable: false,
          });
        const row = (
          await tx.query<{
            status: string;
            lifecycle_generation: string;
            stop_requested_at: unknown;
            expired: boolean;
            conversation_ids: string[];
          }>(
            `select status,lifecycle_generation::text,stop_requested_at,conversation_ids,expires_at<=now() as expired from public.sandboxes
          where id=$1 and owner_id=$2 and org_id=$3 and provider='docker' for update`,
            [sandboxId, caller.userId, orgId],
          )
        ).rows[0];
        if (!row)
          throw new ProviderError({
            provider: "docker",
            code: "not_found",
            message: "Sandbox not found.",
            retryable: false,
          });
        let queued = (
          await tx.query<QueuedDockerPrompt>(
            "select * from public.docker_queued_prompts where sandbox_id=$1 and request_id=$2",
            [sandboxId, input.request_id],
          )
        ).rows[0];
        if (
          queued &&
          (queued.owner_id !== caller.userId ||
            String(queued.actor_epoch) !== member.epoch ||
            queued.input_hash !== hash)
        )
          throw new ProviderError({
            provider: "docker",
            code: "conflict",
            message: "Queued prompt request conflicts with its original input.",
            retryable: false,
          });
        if (!queued) {
          const pending =
            (
              await tx.query(
                `select 1 from public.docker_launch_requests where sandbox_id=$1 and result_enc is null
            union all select 1 from public.docker_queued_prompts where sandbox_id=$1 and status in ('queued','dispatching') limit 1`,
                [sandboxId],
              )
            ).rows.length > 0;
          if (!pending) return null;
          if (!["starting", "ready", "running"].includes(row.status) || row.stop_requested_at !== null || row.expired)
            throw new ProviderError({
              provider: "docker",
              code: "unavailable",
              message: "Sandbox stopped or failed before the prompt could be queued.",
              retryable: false,
            });
          const conversationId = await resolveConversation(tx, sandboxId, row.conversation_ids);
          if (input.conversation_id !== undefined && input.conversation_id !== conversationId)
            throw new ProviderError({
              provider: "docker",
              code: "conflict",
              message: "Conversation does not match the admitted launch.",
              retryable: false,
            });
          queued = (
            await tx.query<QueuedDockerPrompt>(
              `insert into public.docker_queued_prompts(sandbox_id,request_id,prompt_id,owner_id,actor_epoch,lifecycle_generation,input_enc,input_hash,conversation_id)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
              [
                sandboxId,
                input.request_id,
                randomUUID(),
                caller.userId,
                member.epoch,
                row.lifecycle_generation,
                await encryptSecret(payload, key),
                hash,
                conversationId,
              ],
            )
          ).rows[0]!;
        }
        if (!queued.conversation_id) {
          const conversationId = await resolveConversation(tx, sandboxId, row.conversation_ids);
          await tx.query(
            "update public.docker_queued_prompts set conversation_id=$3 where sandbox_id=$1 and request_id=$2 and conversation_id is null",
            [sandboxId, input.request_id, conversationId],
          );
          queued.conversation_id = conversationId;
        }
        return {
          id: sandboxId,
          requestId: input.request_id,
          promptId: queued.prompt_id,
          conversationId: queued.conversation_id,
          status: "queued" as const,
        };
      });
    },
    async failCancelled() {
      // No native journal events are invented: this terminalizes the server's accepted queue fact.
      const rows = (
        await sql.query<{
          sandbox_id: string;
          request_id: string;
          status_reason: string | null;
        }>(`select q.sandbox_id,q.request_id,s.status_reason from public.docker_queued_prompts q
        join public.sandboxes s on s.id=q.sandbox_id left join public.members m on m.user_id=q.owner_id and m.org_id=s.org_id
        left join public.mcp_actor_epochs e on e.user_id=m.user_id and e.org_id=m.org_id
        where q.status in ('queued','dispatching') and (s.owner_id<>q.owner_id or s.status in ('failed','stopping','stopped','deleted') or s.stop_requested_at is not null
          or s.expires_at<=now() or m.user_id is null or e.epoch is distinct from q.actor_epoch or s.lifecycle_generation<>q.lifecycle_generation)`)
      ).rows;
      for (const row of rows)
        await sql.query(
          "update public.docker_queued_prompts set status='failed',failure_reason=$3,failure_native_sequence=(select coalesce(max(c.sequence),0) from public.runtime_commands c where c.sandbox_id=public.docker_queued_prompts.sandbox_id and starts_with(c.request_id,'docker_prompt_')),worker_id=null,worker_expires_at=null where sandbox_id=$1 and request_id=$2 and status in ('queued','dispatching')",
          [row.sandbox_id, row.request_id, queuedFailure(row.status_reason)],
        );
    },
  };
}
