import type { Sql } from "@armada/core";
import { HARNESS_KINDS, isRecord as object } from "@armada/core";
import { decryptSecret } from "@armada/core/server";
import { admitAccountCapacity } from "./account-capacity.ts";
import { createSqlData } from "./data.ts";
import { createDockerSandboxService } from "./docker-sandbox-service.ts";
import { createRuntimeCommands, readDockerPromptReceipt, readRuntimeCommandSuccess } from "./runtime-commands.ts";
import { createRuntimeEnrolments, scopedRuntimeSql } from "./runtime-enrolment.ts";
import { clearDockerTaskOutcome, recordDockerPromptProjection } from "./sandbox-lifecycle.ts";

type Actor = { userId: string; orgId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class DockerRuntimeDenied extends Error {
  constructor() {
    super("Docker runtime denied");
    this.name = "DockerRuntimeDenied";
  }
}
function deny(): never {
  throw new DockerRuntimeDenied();
}
function identity(actor: Actor, sandboxId: string) {
  if (
    !actor ||
    Object.keys(actor).sort().join() !== "orgId,userId" ||
    !uuid.test(actor.userId) ||
    !uuid.test(actor.orgId) ||
    !uuid.test(sandboxId)
  )
    deny();
}
export async function projectDockerPromptReceipt(
  tx: Sql,
  actor: Actor,
  sandboxId: string,
  model: string,
  id: string,
  epoch: string,
  receipt: NonNullable<ReturnType<typeof readDockerPromptReceipt>>,
  saveConversation: boolean,
) {
  const pricing = (
    await tx.query<{ context: unknown; captured: boolean }>(
      "select pricing_context as context,pricing_context is not null as captured from public.runtime_enrolments where sandbox_id=$1 and epoch=$2",
      [sandboxId, epoch],
    )
  ).rows[0];
  await createSqlData(tx)({
    userId: actor.userId,
    orgs: [{ orgId: actor.orgId, role: "member" }],
    via: "service",
  }).sandboxes.recordTurnModel!(sandboxId, receipt.promptId, model, pricing?.captured ? pricing.context : null);
  await recordDockerPromptProjection(
    tx,
    sandboxId,
    receipt.promptId,
    id,
    epoch,
    saveConversation ? receipt.conversationId : undefined,
  );
}

/** One native conversation per allocation. No provider projection or network/waiting in this service. */
export function createDockerRuntimeLifecycle(sql: Sql, key: string) {
  async function transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> {
    try {
      if (!sql.transaction) deny();
      return await sql.transaction(work);
    } catch {
      return deny();
    }
  }
  async function admitted<T>(
    actor: Actor,
    sandboxId: string,
    work: (
      tx: Sql,
      authority: ReturnType<typeof createRuntimeEnrolments>,
      sandbox: Awaited<ReturnType<ReturnType<typeof createDockerSandboxService>["get"]>>,
      epoch: string,
      generation: string,
    ) => Promise<T>,
    allowPending = false,
    reserveTurn = false,
    expectedLifecycleGeneration?: string,
    assertClaim?: (tx: Sql) => Promise<void>,
  ) {
    return transaction(async (tx) => {
      identity(actor, sandboxId);
      const scoped = scopedRuntimeSql(tx);
      const authority = createRuntimeEnrolments(scoped, key);
      const snapshot = await createDockerSandboxService(scoped).get(actor, sandboxId);
      if (snapshot.ownerId !== actor.userId) deny();
      // Same order as bootstrap, native publication and source revocation: membership,
      // then account, then host/sandbox/runtime. withOwner reuses this transaction.
      const source = await authority.lockSourceMembers(tx, sandboxId, actor.userId);
      const credential = await tx.query(
        `select id from public.credentials where id=$1 and version=$2 and kind = any($5::public.credential_kind[])
         and status='active' and (expires_at is null or expires_at>now())
         and ((scope='user' and owner_id=$3) or (scope='org' and owner_id=$4)) ${reserveTurn ? "for update" : "for share"}`,
        [snapshot.credentialId, snapshot.credentialVersion, actor.userId, actor.orgId, HARNESS_KINDS[snapshot.harness]],
      );
      if (!credential.rows.length) deny();
      if (reserveTurn && snapshot.credentialId) await admitAccountCapacity(tx, snapshot.credentialId, sandboxId);
      if (allowPending) {
        const host = await tx.query(
          `select h.id from public.docker_hosts h join public.members m on m.org_id=h.org_id and m.user_id=h.owner_id
           where h.id=$1 and h.org_id=$2 and h.installation_id=$3 and h.hash is not null
           and h.registration_hash is null and h.revoked_at is null and h.owner_id=$4 for share of h`,
          [snapshot.hostId, actor.orgId, snapshot.installationId, source.issuer_id],
        );
        if (!host.rows.length) deny();
        const live = await tx.query(
          `select id from public.sandboxes where id=$1 and status in ('starting','ready','running')
           and stop_requested_at is null and deleted_at is null and expires_at>now()
           and ($2::bigint is null or lifecycle_generation=$2) for update`,
          [sandboxId, expectedLifecycleGeneration ?? null],
        );
        if (!live.rows.length) deny();
      }
      const phases = await tx.query(
        `select 1 from public.docker_host_jobs j join public.mcp_actor_epochs e
         on e.org_id=$3 and e.user_id=$2 and e.epoch=j.bound_actor_epoch
         where j.bound_sandbox_id=$1 and j.bound_actor_id=$2 and j.host_id=$4
         and j.bound_operation='create' and j.outcome='completed'
         and exists(select 1 from public.docker_host_jobs b where b.bound_sandbox_id=$1
           and b.bound_operation='bootstrap' and b.bound_actor_id=$2 and b.host_id=$4
           and b.bound_actor_epoch=e.epoch and b.outcome is distinct from 'failed')`,
        [sandboxId, actor.userId, actor.orgId, snapshot.hostId],
      );
      if (!phases.rows.length) deny();
      if (allowPending) {
        const pending = await tx.query(
          `select 1 from public.runtime_enrolments r join public.sandboxes s on s.id=r.sandbox_id
           where r.sandbox_id=$1 and r.lifecycle_generation=s.lifecycle_generation and r.runtime_hash is null
           and r.enrolment_hash is not null and r.enrolment_expires_at>now()
           and r.docker_issuer_fence=$2 for update of r`,
          [sandboxId, source.docker_issuer_fence],
        );
        if (pending.rows.length) return { state: "pending" as const };
      }
      return authority.withOwner(sandboxId, actor.userId, async (_fenced, scope) => {
        const current = await createDockerSandboxService(scoped).get(actor, sandboxId);
        const enrolledDuringReady = allowPending && snapshot.status === "starting" && current.status === "ready";
        const expected = enrolledDuringReady ? { ...snapshot, status: "ready" } : snapshot;
        if (JSON.stringify(current) !== JSON.stringify(expected)) deny();
        await assertClaim?.(scoped);
        const result = await work(scoped, authority, current, scope.epoch, scope.lifecycleGeneration);
        await assertClaim?.(scoped);
        return result;
      });
    });
  }
  return {
    ready(
      actor: Actor,
      sandboxId: string,
      requestId: string,
      expectedLifecycleGeneration?: string,
      assertClaim?: (tx: Sql) => Promise<void>,
    ) {
      if (!uuid.test(requestId)) return Promise.reject(new DockerRuntimeDenied());
      return admitted(
        actor,
        sandboxId,
        async (tx, authority, sandbox, epoch, generation) => {
          const id = `docker_ready_${requestId}`;
          const commands = createRuntimeCommands(authority, key);
          await commands.enqueue(actor.userId, { version: 1, requestId: id, sandboxId, op: "health" }, epoch);
          const response = await commands.result(actor.userId, sandboxId, id, epoch);
          if (response.state === "pending") return { state: "pending" as const };
          if (response.state !== "finished") deny();
          const health = readRuntimeCommandSuccess(response.reply, epoch, id);
          const publication = await authority.confirmDockerRestore(tx, { sandboxId, epoch }, generation, health);
          if (publication === "unverified" || (sandbox.status === "starting" && publication !== "applied")) deny();
          return { state: "ready" as const, epoch };
        },
        true,
        false,
        expectedLifecycleGeneration,
        assertClaim,
      );
    },
    prompt(
      actor: Actor,
      sandboxId: string,
      input: { requestId: string; text: string; conversationId?: string },
      preparedLaunchEpoch?: string,
      assertClaim?: (tx: Sql) => Promise<void>,
    ) {
      return admitted(
        actor,
        sandboxId,
        async (tx, authority, sandbox, epoch) => {
          if (
            !object(input) ||
            Object.keys(input).some((field) => !["requestId", "text", "conversationId"].includes(field)) ||
            (Object.hasOwn(input, "conversationId") &&
              (typeof input.conversationId !== "string" || !uuid.test(input.conversationId))) ||
            !uuid.test(input.requestId) ||
            typeof input.text !== "string" ||
            !input.text.trim() ||
            Buffer.byteLength(input.text) > 262144 ||
            !["ready", "running"].includes(sandbox.status)
          )
            deny();
          if (preparedLaunchEpoch !== undefined && preparedLaunchEpoch !== epoch) deny();
          const refused = await tx.query(
            "select 1 from public.account_turn_queue where sandbox_id=$1 and request_id=$2 and state='failed'",
            [sandboxId, input.requestId],
          );
          if (refused.rows.length) deny();
          // The launch reserves a conversation before any native admission or queued receipt.
          const launch = (
            await tx.query<{ request_enc: Uint8Array<ArrayBuffer>; result_enc: Uint8Array<ArrayBuffer> | null }>(
              "select request_enc,result_enc from public.docker_launch_manifests where sandbox_id=$1",
              [sandboxId],
            )
          ).rows[0];
          let plannedConversation: string | undefined;
          let repositoryDir: string | undefined;
          if (launch) {
            const manifest = JSON.parse(await decryptSecret(launch.request_enc, key));
            plannedConversation = manifest.conversationId ?? manifest.promptId;
            repositoryDir = manifest.request.repos?.[0]?.dir;
            if (
              !launch.result_enc &&
              (preparedLaunchEpoch === undefined ||
                manifest.promptId !== input.requestId ||
                manifest.request?.prompt !== input.text ||
                (input.conversationId !== plannedConversation &&
                  !(manifest.conversationId === undefined && input.conversationId === undefined)))
            )
              deny();
          }
          const id = `docker_prompt_${input.requestId}`;
          // Exact retries keep their original canonical payload, including the first
          // request's absent conversationId, even after its receipt is reconciled.
          const previous = await tx.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
            `select request_enc from public.runtime_commands where sandbox_id=$1 and request_id=$2`,
            [sandboxId, id],
          );
          const previousCwd = previous.rows[0]
            ? JSON.parse(await decryptSecret(previous.rows[0].request_enc, key)).input.cwd
            : undefined;
          const saved =
            (
              await tx.query<{ conversation_ids: string[] }>(
                `select conversation_ids from public.sandboxes where id=$1 and org_id=$2 and owner_id=$3`,
                [sandboxId, actor.orgId, actor.userId],
              )
            ).rows[0]?.conversation_ids ?? deny();
          if (!previous.rows.length) {
            if (saved.length > 1 || saved.some((conversationId) => !uuid.test(conversationId))) deny();
            if (
              saved.length
                ? input.conversationId !== saved[0]
                : input.conversationId !== undefined && input.conversationId !== plannedConversation
            )
              deny();
            const blocked = await tx.query(
              `select 1 from public.runtime_commands where sandbox_id=$1
             and starts_with(request_id,'docker_prompt_')
             and ((epoch=$3::bigint and result_enc is null) or $2::boolean) limit 1`,
              [sandboxId, saved.length === 0, epoch],
            );
            // An unresolved RPC has not established native admission yet. Once it
            // replies, the runner alone owns busy/refusal; no journal scheduler here.
            if (blocked.rows.length) deny();
          }
          if (!previous.rows.length)
            // A reported outcome belongs to the turn it names; the report history stays in pull_request_reports.
            await clearDockerTaskOutcome(tx, sandboxId);
          const commands = createRuntimeCommands(authority, key);
          const queued = await commands.enqueue(actor.userId, {
            version: 1,
            requestId: id,
            sandboxId,
            op: "prompt",
            input: {
              sandboxId,
              harness: sandbox.harness,
              text: input.text,
              ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
              model: sandbox.model,
              reasoningEffort: sandbox.reasoningEffort,
              cwd: previous.rows.length ? previousCwd : repositoryDir ? `/home/user/${repositoryDir}` : "/home/user",
            },
          });
          const response = await commands.result(actor.userId, sandboxId, id, queued.epoch);
          if (response.state === "pending") return { state: "pending" as const };
          if (response.state !== "finished") deny();
          const receipt = readDockerPromptReceipt(response.reply, queued.epoch, id);
          if (
            !receipt ||
            (input.conversationId !== undefined && receipt.conversationId !== input.conversationId) ||
            saved.length > 1 ||
            (saved.length === 1 && receipt.conversationId !== saved[0])
          )
            deny();
          await projectDockerPromptReceipt(
            tx,
            actor,
            sandboxId,
            sandbox.model,
            id,
            queued.epoch,
            receipt,
            !saved.length,
          );
          return {
            state: "admitted" as const,
            epoch: queued.epoch,
            receipt,
          };
        },
        false,
        true,
        undefined,
        assertClaim,
      );
    },
  };
}
