import { PROTOCOL_VERSION, type RunnerRequest } from "@armada/agent-runtime";
import { PROMPT_STATUSES, type Sql } from "@armada/core";
import { decryptSecret, encryptSecret } from "@armada/core/server";
import { UUID } from "./control-input.ts";
import type { Route } from "./http.ts";
import { dockerStopPending } from "./jobs/store.ts";
import {
  currentRequestId,
  noteAdmission,
  observeProviderCall,
  recordOperatorDiagnostic,
} from "./request-observability.ts";
import {
  authorityExtensionPrefix,
  dispatchableRuntimeCommand,
  liveAuthorityExtension,
} from "./runtime-authority-extension.ts";
import { type createRuntimeEnrolments, RuntimeEnrolmentDenied, type RuntimeOwnerScope } from "./runtime-enrolment.ts";
import { runtimeHttpFailure } from "./runtime-http-failure.ts";
import { logWorkspaceCommand } from "./runtime-workspace-diagnostics.ts";
import { recordDockerPromptAccepted, settleRuntimeTurn } from "./sandbox-lifecycle.ts";
import { deferTransactionWake, runtimeWakes, waitForTimeout } from "./wake-bus.ts";

const MAX_COMMAND = 1048576;
const MAX_REPLY = MAX_COMMAND * 2;

export class RuntimeCommandConflict extends Error {
  constructor() {
    super("runtime_command_conflict");
  }
}
/** Refused before admission: no row exists for this request ID, so nothing can execute. */
export class RuntimeCommandRefused extends RuntimeCommandConflict {}
export class RuntimeCommandPending extends Error {
  constructor() {
    super("runtime_command_pending");
  }
}
async function assertAdmittedClaim(tx: Sql, assertClaim?: (tx: Sql) => Promise<void>) {
  try {
    await assertClaim?.(tx);
  } catch (error) {
    if (error instanceof RuntimeCommandRefused) throw new RuntimeCommandConflict();
    throw error;
  }
}

interface RuntimeCommandReply {
  epoch: string;
  requestId: string;
  status: number;
  body: Record<string, unknown>;
}
interface Clock {
  now(): number;
  wait(ms: number, signal: AbortSignal): Promise<void>;
}
const clock: Clock = {
  now: () => Date.now(),
  wait: waitForTimeout,
};
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function readRuntimeCommandSuccess(reply: RuntimeCommandReply, epoch: string, requestId: string) {
  if (
    reply.epoch === epoch &&
    reply.requestId === requestId &&
    reply.status === 200 &&
    reply.body.version === 1 &&
    reply.body.requestId === requestId &&
    record(reply.body.result) &&
    !Object.hasOwn(reply.body, "error")
  )
    return reply.body.result;
}

export function readDockerPromptReceipt(reply: RuntimeCommandReply, epoch: string, requestId: string) {
  const result = readRuntimeCommandSuccess(reply, epoch, requestId);
  if (!result) return;
  const { promptId, conversationId } = result;
  const status = PROMPT_STATUSES.find((candidate) => candidate === result.status);
  if (
    typeof promptId === "string" &&
    UUID.test(promptId) &&
    promptId === promptId.toLowerCase() &&
    typeof conversationId === "string" &&
    UUID.test(conversationId) &&
    conversationId === conversationId.toLowerCase() &&
    status
  )
    return { promptId, conversationId, status };
}

/** Read-only output samples (`outputs_<deadline ms>_<nonce>`) expire at the deadline in their id.
 * An expired read is never dispatched and never makes the runtime look busy: nobody awaits its
 * reply, so it must not hold the ordered queue ahead of later commands or idle checks. Its row
 * stays until the runtime can no longer acknowledge it (see `docker-outputs.ts`): a read is never
 * dispatched once a later command has an answer, whatever each process's clock says. */
export function expiredOutputRead(column: string, now: string): string {
  return `(case when ${column} ~ '^outputs_[0-9]{1,16}_' then split_part(${column},'_',2)::bigint<=${now}::bigint else false end)`;
}
function requestId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
async function body(request: Request): Promise<unknown> {
  if (!request.body) throw new RuntimeCommandConflict();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request.body) {
    length += chunk.byteLength;
    if (length > MAX_REPLY) throw new RuntimeCommandConflict();
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RuntimeCommandConflict();
  }
}

/** All payload I/O is under the existing member -> sandbox -> epoch transaction fence. */
export function createRuntimeCommands(
  authority: ReturnType<typeof createRuntimeEnrolments>,
  key: string,
  time: Clock = clock,
) {
  async function enqueueCommand(
    ownerId: string,
    request: RunnerRequest,
    expectedEpoch?: string,
    assertClaim?: (tx: Sql) => Promise<void>,
    resolveSkillpackKey?: (tx: Sql) => Promise<string>,
    extensionLeaseEpoch?: string,
  ) {
    if (request.version !== 1 || !requestId(request.requestId) || typeof request.op !== "string")
      throw new RuntimeCommandRefused();
    if (
      request.op === "extendCommandAuthority"
        ? extensionLeaseEpoch === undefined
        : request.requestId.startsWith(authorityExtensionPrefix)
    )
      throw new RuntimeCommandRefused();
    if (resolveSkillpackKey && (request.op !== "installSkills" || request.input.key !== undefined))
      throw new RuntimeCommandRefused();
    const serialize = (skillpackKey?: string) =>
      JSON.stringify(
        request.op === "installSkills" && skillpackKey !== undefined
          ? { ...request, input: { ...request.input, key: skillpackKey } }
          : request,
      );
    const original = serialize();
    const encode = (command: string) =>
      extensionLeaseEpoch === undefined ? command : JSON.stringify({ command, extensionLeaseEpoch });
    if (Buffer.byteLength(original) > MAX_COMMAND) throw new RuntimeCommandRefused();
    const sealed = resolveSkillpackKey ? undefined : await encryptSecret(encode(original), key);
    const wakeKeys = [`socket:${request.sandboxId}`, `poll:${request.sandboxId}`];
    let deferred = false;
    const admitted = await authority.withOwner(request.sandboxId, ownerId, async (tx, scope) => {
      const isExtension = extensionLeaseEpoch !== undefined;
      if (!isExtension) await assertClaim?.(tx);
      // Application-secret taint forbids file egress: never admit or replay an output read (row
      // locked here). A stored reply may predate the taint, and a read has no effect to reconcile.
      if (
        request.op === "readOutputs" &&
        (await tx.query("select 1 from public.sandboxes where id=$1 and application_secret_tainted", [scope.sandboxId]))
          .rows.length
      )
        throw new RuntimeCommandRefused();
      // The durable request identity decides first. A row with this ID was admitted and may have
      // executed, so no fence below may report it as a definite refusal.
      const previous = (
        await tx.query<{ epoch: string; request_enc: Uint8Array<ArrayBuffer> }>(
          "select epoch::text,request_enc from public.runtime_commands where sandbox_id=$1 and request_id=$2",
          [scope.sandboxId, request.requestId],
        )
      ).rows[0];
      if (previous) {
        if (isExtension) await assertAdmittedClaim(tx, assertClaim);
        if (previous.epoch !== scope.epoch || (expectedEpoch !== undefined && scope.epoch !== expectedEpoch))
          throw new RuntimeCommandConflict();
        const encoded = await decryptSecret(previous.request_enc, key);
        const extension = extensionLeaseEpoch === undefined ? undefined : JSON.parse(encoded);
        const stored = extension ? extension.command : encoded;
        const storedKey = resolveSkillpackKey ? JSON.parse(stored).input?.key : undefined;
        if (resolveSkillpackKey && typeof storedKey !== "string") throw new RuntimeCommandConflict();
        if (stored !== serialize(storedKey)) throw new RuntimeCommandConflict();
        // An identical replay in the current epoch reconciles with the stored command: it adds no
        // work, so the checkpoint fence does not apply and the caller reads the stored reply.
        const rebound = extension && extension.extensionLeaseEpoch !== extensionLeaseEpoch;
        if (rebound) {
          const updated = await tx.query(
            `update public.runtime_commands set request_enc=$3
             where sandbox_id=$1 and request_id=$2 and result_enc is null returning request_id`,
            [scope.sandboxId, request.requestId, sealed],
          );
          if (updated.rows.length) {
            for (const wakeKey of wakeKeys) deferred = deferTransactionWake(tx, wakeKey);
          }
        }
        if (isExtension) await assertAdmittedClaim(tx, assertClaim);
        else await assertClaim?.(tx);
        return { epoch: scope.epoch, requestId: request.requestId, provider: scope.provider, fresh: Boolean(rebound) };
      }
      // Every fence below refuses new work before any row is written: a definite refusal.
      if (isExtension) await assertClaim?.(tx);
      if (expectedEpoch !== undefined && scope.epoch !== expectedEpoch) throw new RuntimeCommandRefused();
      // Checkpoint intent fences every mutation entry point, including Docker.
      if (
        ![
          "checkpoint",
          "scrubOrchestratorEpoch",
          "events",
          "health",
          "getPrompt",
          "getExec",
          "observeOrchestrator",
          "readOutputs",
        ].includes(request.op) &&
        (
          await tx.query("select 1 from public.runtime_checkpoints where sandbox_id=$1 and epoch=$2", [
            scope.sandboxId,
            scope.epoch,
          ])
        ).rows.length
      )
        throw new RuntimeCommandRefused();
      const serialized = resolveSkillpackKey ? serialize(await resolveSkillpackKey(tx)) : original;
      // Include BOTH published wire envelopes, not merely the inner RunnerRequest.
      // A head-of-line command must always fit the client's 1 MiB JSON/frame cap.
      const overhead =
        Math.max(
          Buffer.byteLength(JSON.stringify({ epoch: scope.epoch, command: null })),
          Buffer.byteLength(JSON.stringify({ type: "command", epoch: scope.epoch, request: null })),
        ) - 4; // Replace the JSON null with the already serialized command.
      if (Buffer.byteLength(serialized) + overhead > MAX_COMMAND) throw new RuntimeCommandRefused();
      await tx.query(
        "insert into public.runtime_commands(sandbox_id,request_id,epoch,request_enc,correlation_id) values($1,$2,$3,$4,$5)",
        [
          scope.sandboxId,
          request.requestId,
          scope.epoch,
          sealed ?? (await encryptSecret(serialized, key)),
          request.op === "prompt" ? (currentRequestId() ?? null) : null,
        ],
      );
      await assertClaim?.(tx);
      for (const wakeKey of wakeKeys) deferred = deferTransactionWake(tx, wakeKey);
      noteAdmission();
      return { epoch: scope.epoch, requestId: request.requestId, provider: scope.provider, fresh: true };
    });
    if (admitted.fresh && !deferred) for (const wakeKey of wakeKeys) runtimeWakes.notify(wakeKey);
    return admitted;
  }
  function enqueue(
    ownerId: string,
    request: RunnerRequest,
    expectedEpoch?: string,
    assertClaim?: (tx: Sql) => Promise<void>,
    resolveSkillpackKey?: (tx: Sql) => Promise<string>,
  ) {
    return enqueueCommand(ownerId, request, expectedEpoch, assertClaim, resolveSkillpackKey);
  }
  /** Keep admission fenced through synchronous socket enqueue; never await network I/O here. */
  async function withNext<T>(
    token: string,
    epoch: string,
    use: (value: { epoch: string; command: RunnerRequest | null }) => Promise<T>,
    onScope?: (sandboxId: string) => void,
  ) {
    return authority.withSession(token, epoch, async (tx, scope, generation) => {
      onScope?.(scope.sandboxId);
      const rows = (
        await tx.query<{ request_id: string; request_enc: Uint8Array<ArrayBuffer> }>(
          `select request_id,request_enc from public.runtime_commands c where sandbox_id=$1 and epoch=$2 and result_enc is null
           and not ${expiredOutputRead("request_id", "$3")}
           and not (starts_with(request_id,'outputs_') and exists(select 1 from public.sandboxes s
             where s.id=c.sandbox_id and s.application_secret_tainted))
           and not (starts_with(request_id,'outputs_') and exists(select 1 from public.runtime_commands later
             where later.sandbox_id=c.sandbox_id and later.epoch=c.epoch and later.sequence>c.sequence
             and later.result_enc is not null))
           and ${dispatchableRuntimeCommand("c.sandbox_id", "c.epoch", "c.request_id")}
           order by sequence limit 2`,
          [scope.sandboxId, scope.epoch, String(time.now())],
        )
      ).rows;
      // At most one row can match the pending job. A predecessor's command
      // yields to the successor's fresh health probe until re-admitted.
      for (const row of rows) {
        const encoded = JSON.parse(await decryptSecret(row.request_enc, key));
        if (encoded.op === "prompt" && row.request_id.startsWith("docker_prompt_")) {
          const receiptOnly = await tx.query(
            `select 1 from public.jobs j where j.sandbox_id=$1 and j.generation=$2 and j.kind='launch'
              and j.outcome ? 'docker_actor_epoch' and j.outcome->>'docker_receipt' is null
              and (j.deadline_at<=clock_timestamp() or j.attempts>j.max_attempts or j.state in ('failed','done')
                or ${dockerStopPending("j.sandbox_id", "j.generation")}
                or not exists(select 1 from public.mcp_actor_epochs e
                  where e.org_id=j.org_id and e.user_id=j.request_owner_id
                    and e.epoch::text=j.outcome->>'docker_actor_epoch'))`,
            [scope.sandboxId, generation],
          );
          if (receiptOnly.rows.length) {
            return use({
              epoch: scope.epoch,
              command: {
                version: 1,
                sandboxId: scope.sandboxId,
                requestId: row.request_id,
                op: "getPrompt",
                promptId: row.request_id,
              },
            });
          }
        }
        if (!row.request_id.startsWith(authorityExtensionPrefix)) return use({ epoch: scope.epoch, command: encoded });
        const current = await tx.query(
          `select 1 where ${liveAuthorityExtension("$1::uuid", "$2::bigint", "$3::text", "$4::bigint")}`,
          [scope.sandboxId, scope.epoch, row.request_id, encoded.extensionLeaseEpoch],
        );
        if (current.rows.length) return use({ epoch: scope.epoch, command: JSON.parse(encoded.command) });
      }
      return use({ epoch: scope.epoch, command: null });
    });
  }
  async function pendingHead(sandboxId: string, epoch: string) {
    const row = (
      await authority.query<{ request_id: string }>(
        `select c.request_id from public.runtime_commands c
         where c.sandbox_id=$1 and c.epoch=$2 and c.result_enc is null
           and not ${expiredOutputRead("c.request_id", "$3")}
           and not (starts_with(c.request_id,'outputs_') and exists(select 1 from public.sandboxes s
             where s.id=c.sandbox_id and s.application_secret_tainted))
           and not (starts_with(c.request_id,'outputs_') and exists(select 1 from public.runtime_commands later
             where later.sandbox_id=c.sandbox_id and later.epoch=c.epoch and later.sequence>c.sequence
             and later.result_enc is not null))
           and ${dispatchableRuntimeCommand("c.sandbox_id", "c.epoch", "c.request_id")}
         order by c.sequence limit 1`,
        [sandboxId, epoch, String(time.now())],
      )
    ).rows[0];
    return row?.request_id ?? null;
  }
  async function isResultPending(ownerId: string, sandboxId: string, id: string, expectedEpoch: string) {
    const row = (
      await authority.query<{
        command_epoch: string;
        has_result: boolean;
        current_epoch: string | null;
        live: boolean;
      }>(
        `select c.epoch::text as command_epoch,
                c.result_enc is not null as has_result,
                r.epoch::text as current_epoch,
                (r.runtime_hash is not null
                 and r.runtime_protocol_version > 0
                 and r.runtime_protocol_version in ($4, $5)
                 and s.owner_id = $3::uuid
                 and (s.provider in ('boat','docker') or (s.provider='modal' and s.runtime_transport='dialout'))
                 and s.status in ('starting','ready','running')
                 and s.stop_requested_at is null
                 and s.deleted_at is null
                 and s.expires_at > now()
                 and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=s.owner_id)
                 and (
                   (s.provider <> 'docker' and r.docker_issuer_fence is null)
                   or (s.provider = 'docker' and exists(
                     select 1
                     from public.docker_hosts h
                     join public.members hm on hm.org_id=h.org_id and hm.user_id=h.owner_id
                     join public.mcp_actor_epochs e on e.org_id=h.org_id and e.user_id=h.owner_id
                     where h.id=s.docker_host_id
                       and h.org_id=s.org_id
                       and h.installation_id=s.docker_installation_id
                       and h.hash is not null
                       and h.registration_hash is null
                       and h.revoked_at is null
                       and r.docker_issuer_fence is not distinct from (h.owner_id::text || ':' || e.epoch::text)
                   ))
                 )) as live
         from public.runtime_commands c
         join public.sandboxes s on s.id = c.sandbox_id
         left join public.runtime_enrolments r on r.sandbox_id = c.sandbox_id
           and r.lifecycle_generation = s.lifecycle_generation
         where c.sandbox_id = $1 and c.request_id = $2`,
        [sandboxId, id, ownerId, PROTOCOL_VERSION, PROTOCOL_VERSION - 1],
      )
    ).rows[0];
    return Boolean(
      row && !row.has_result && row.command_epoch === expectedEpoch && row.current_epoch === expectedEpoch && row.live,
    );
  }
  async function next(token: string, epoch: string) {
    return withNext(token, epoch, async (value) => value);
  }
  async function complete(token: string, epoch: string, value: unknown) {
    const started = time.now();
    if (
      !record(value) ||
      value.epoch !== epoch ||
      !requestId(value.requestId) ||
      typeof value.status !== "number" ||
      !Number.isInteger(value.status) ||
      value.status < 200 ||
      value.status > 599 ||
      !record(value.body) ||
      Object.keys(value).some((k) => !["epoch", "requestId", "status", "body"].includes(k))
    )
      throw new RuntimeCommandConflict();
    if (value.body.requestId !== undefined && value.body.requestId !== value.requestId)
      throw new RuntimeCommandConflict();
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > MAX_REPLY) throw new RuntimeCommandConflict();
    const candidate = record(value.body.result) ? value.body.result.promptId : undefined;
    let acceptedPromptId =
      value.status < 300 && typeof candidate === "string" && UUID.test(candidate) ? candidate : null;
    let sealed = await encryptSecret(serialized, key);
    const { sandboxId, ...receipt } = await authority.withSession(token, epoch, async (tx, scope, generation) => {
      // Keep the ordered acknowledgement even if the caller's deadline or the taint fence
      // invalidated the read. No reader can use these bytes now.
      const outputDeadline = /^outputs_(\d{1,16})_/.exec(String(value.requestId))?.[1];
      if (String(value.requestId).startsWith("outputs_")) {
        const tainted =
          (
            await tx.query("select 1 from public.sandboxes where id=$1 and application_secret_tainted", [
              scope.sandboxId,
            ])
          ).rows.length > 0;
        if (tainted || (outputDeadline !== undefined && Number(outputDeadline) <= time.now())) {
          acceptedPromptId = null;
          sealed = await encryptSecret(
            JSON.stringify({
              epoch: value.epoch,
              requestId: value.requestId,
              status: 410,
              body: { requestId: value.requestId, error: tainted ? "application_secret_tainted" : "output_timeout" },
            }),
            key,
          );
        }
      }
      let promptId: string | null = null;
      let requestedConversation: string | undefined;
      let dockerReadiness = false;
      if (acceptedPromptId || String(value.requestId).startsWith("docker_ready_")) {
        const command = (
          await tx.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
            `select request_enc from public.runtime_commands
             where sandbox_id=$1 and request_id=$2 and epoch=$3 and result_enc is null`,
            [scope.sandboxId, value.requestId, scope.epoch],
          )
        ).rows[0];
        if (command) {
          const request: RunnerRequest = JSON.parse(await decryptSecret(command.request_enc, key));
          dockerReadiness = request.op === "health" && request.requestId.startsWith("docker_ready_");
          if (request.op === "prompt") {
            promptId = acceptedPromptId;
            requestedConversation = request.input.conversationId;
          }
        }
      }
      const row = (
        await tx.query<{ request_id: string; result_enc: Uint8Array<ArrayBuffer> }>(
          `update public.runtime_commands set result_enc=coalesce(result_enc,$4),
           accepted_prompt_id=case when result_enc is null then $5::uuid else accepted_prompt_id end
         where sandbox_id=$1 and request_id=$2 and epoch=$3 returning request_id,result_enc`,
          [scope.sandboxId, value.requestId, scope.epoch, sealed, promptId],
        )
      ).rows[0];
      if (!row) throw new RuntimeCommandConflict();
      // Use the first durable reply, including on replay. A stop may already
      // have cancelled the queue entry; it cannot erase accepted turn identity.
      const reply = JSON.parse(await decryptSecret(row.result_enc, key));
      if (dockerReadiness) {
        await authority.confirmDockerRestore(
          tx,
          scope,
          generation,
          readRuntimeCommandSuccess(reply, scope.epoch, row.request_id),
        );
      }
      const result = reply.body?.result;
      const queued = /^(?:follow_|docker_prompt_|resume_)([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i.exec(
        row.request_id,
      );
      if (queued && typeof result?.promptId === "string" && reply.status >= 200 && reply.status < 300) {
        await tx.query(
          `update public.account_turn_queue set native_prompt_id=coalesce(native_prompt_id,$3)
           where sandbox_id=$1 and request_id=$2::uuid`,
          [scope.sandboxId, queued[1], result.promptId],
        );
      }
      if (row.request_id.startsWith("docker_prompt_")) {
        const accepted = promptId && readDockerPromptReceipt(reply, scope.epoch, row.request_id);
        if (accepted && (requestedConversation === undefined || requestedConversation === accepted.conversationId))
          await recordDockerPromptAccepted(tx, scope.sandboxId, generation, accepted);
        await settleRuntimeTurn(tx, scope.sandboxId, generation, key);
      }
      return { sandboxId: scope.sandboxId, epoch: scope.epoch, requestId: row.request_id };
    });
    const acknowledged = time.now();
    logWorkspaceCommand({ sandboxId, epoch: receipt.epoch }, receipt.requestId, "result_acknowledged", acknowledged, {
      durationMs: acknowledged - started,
    });
    runtimeWakes.notify(`reply:${sandboxId}:${receipt.epoch}:${receipt.requestId}`);
    runtimeWakes.notify(`reply:${sandboxId}:${receipt.requestId}`);
    runtimeWakes.notify(`socket:${sandboxId}`);
    return receipt;
  }
  async function result(
    ownerId: string,
    sandboxId: string,
    id: string,
    expectedEpoch?: string,
    assertReceiptClaim?: (tx: Sql) => Promise<void>,
  ) {
    if (!requestId(id)) throw new RuntimeCommandConflict();
    return authority.withOwner(sandboxId, ownerId, async (tx, scope) => {
      const row = (
        await tx.query<{ epoch: string; result_enc: Uint8Array<ArrayBuffer> | null }>(
          "select epoch::text,result_enc from public.runtime_commands where sandbox_id=$1 and request_id=$2",
          [sandboxId, id],
        )
      ).rows[0];
      if (!row) return { state: "missing" as const };
      if (expectedEpoch !== undefined && (scope.epoch !== expectedEpoch || row.epoch !== expectedEpoch))
        return { state: "superseded" as const };
      if (row.result_enc) {
        const reply = JSON.parse(await decryptSecret(row.result_enc, key)) as RuntimeCommandReply;
        if (assertReceiptClaim) await assertAdmittedClaim(tx, assertReceiptClaim);
        return { state: "finished" as const, reply };
      }
      return { state: row.epoch === scope.epoch ? ("pending" as const) : ("superseded" as const) };
    });
  }
  /** Await one durable identity; timeout/abort never cancel or replay admitted work.
   * The caller retains requestId and can reconcile with result (or call again
   * with the exact same request). No transaction is held across the wait.
   *
   * This is the shared request-correlated observation point for awaited runtime commands: one
   * `runtime.<op>` record per call, attributed to the provider of the locked sandbox, `ok` only
   * for a validated reply (`accept` adds a caller check), and none for a retry answered by a stored
   * reply. Callers keep their public fallbacks.
   * Docker launch, send, resume and preview runtime routes admit some commands in their own
   * transaction (enqueue + result); those are recorded by the enclosing Docker provider record.
   */
  type CallOptions = {
    signal?: AbortSignal;
    timeoutMs?: number;
    strictDeadline?: true;
    expectedEpoch?: string;
    assertClaim?: (tx: Sql) => Promise<void>;
    resolveSkillpackKey?: (tx: Sql) => Promise<string>;
    accept?: (reply: RuntimeCommandReply) => boolean;
  };

  function call(ownerId: string, request: RunnerRequest, options: CallOptions = {}): Promise<RuntimeCommandReply> {
    return callPrepared(ownerId, request.op, async () => ({ request, options }), undefined, request.sandboxId);
  }

  function callAuthorityExtension(
    ownerId: string,
    request: Extract<RunnerRequest, { op: "extendCommandAuthority" }>,
    options: CallOptions & {
      expectedEpoch: string;
      leaseEpoch: string;
      assertClaim: NonNullable<CallOptions["assertClaim"]>;
    },
  ) {
    const assertClaim = async (tx: Sql) => {
      await options.assertClaim(tx);
      const live = await tx.query(
        `select 1 where ${liveAuthorityExtension("$1::uuid", "$2::bigint", "$3::text", "$4::bigint")}`,
        [request.sandboxId, options.expectedEpoch, request.requestId, options.leaseEpoch],
      );
      if (!live.rows.length) throw new RuntimeCommandRefused();
    };
    return callCommand(
      ownerId,
      request.op,
      async () => ({ request, options: { ...options, assertClaim } }),
      undefined,
      request.sandboxId,
      options.leaseEpoch,
    );
  }

  function callPrepared(
    ownerId: string,
    operation: RunnerRequest["op"],
    prepare: () => Promise<{ request: RunnerRequest; options: CallOptions }>,
    knownProvider?: RuntimeOwnerScope["provider"],
    knownSandboxId?: string,
  ) {
    return callCommand(ownerId, operation, prepare, knownProvider, knownSandboxId);
  }

  /** Admit under the caller's authority transaction, then wait after it commits. */
  async function callCommand(
    ownerId: string,
    operation: RunnerRequest["op"],
    prepare: () => Promise<{ request: RunnerRequest; options: CallOptions }>,
    knownProvider?: RuntimeOwnerScope["provider"],
    knownSandboxId?: string,
    extensionLeaseEpoch?: string,
  ): Promise<RuntimeCommandReply> {
    let provider = knownProvider;
    let sandboxId = knownSandboxId;
    let acceptReply: (reply: RuntimeCommandReply) => boolean = () => false;
    return observeProviderCall(
      () => provider,
      `runtime.${operation}`,
      async () => {
        const { request, options } = await prepare();
        sandboxId = request.sandboxId;
        acceptReply = (reply) =>
          reply.status === 200 &&
          reply.body.version === 1 &&
          reply.body.requestId === request.requestId &&
          reply.body.error === undefined &&
          (options.accept?.(reply) ?? true);
        const timeout = options.timeoutMs ?? 120_000;
        if (
          !Number.isSafeInteger(timeout) ||
          timeout < 1 ||
          timeout > (request.op === "workspaceExec" ? 610_000 : request.op === "exec" ? 630_000 : 120_000)
        )
          throw new RuntimeCommandRefused();
        const signal = options.signal ?? new AbortController().signal;
        signal.throwIfAborted();
        const started = time.now();
        const deadline = started + timeout;
        const wake = runtimeWakes.watch(`reply:${request.sandboxId}:${request.requestId}`);
        let scope: { sandboxId: string; epoch: string } | undefined;
        let admittedAt = started;
        let resultReads = 0;
        let resultReadMs = 0;
        let observed = false;
        try {
          const admitted = await enqueueCommand(
            ownerId,
            request,
            options.expectedEpoch,
            options.assertClaim,
            options.resolveSkillpackKey,
            extensionLeaseEpoch,
          );
          provider = admitted.provider;
          scope = { sandboxId: request.sandboxId, epoch: admitted.epoch };
          admittedAt = time.now();
          logWorkspaceCommand(
            scope,
            request.requestId,
            admitted.fresh ? "admitted" : "admission_replayed",
            admittedAt,
            {
              durationMs: admittedAt - started,
            },
          );
          let waitFirst = admitted.fresh;
          const interval = request.op === "readOutputs" && request.part ? 100 : 250;
          const waitForReply = async () => {
            const remaining = deadline - time.now();
            if (remaining <= 0) throw new RuntimeCommandPending();
            await wake.wait(signal, Math.min(interval, remaining), time.wait.bind(time));
          };
          while (true) {
            signal.throwIfAborted();
            if (waitFirst) {
              waitFirst = false;
              await waitForReply();
              signal.throwIfAborted();
            }
            const readAt = time.now();
            if (await isResultPending(ownerId, request.sandboxId, request.requestId, admitted.epoch)) {
              resultReadMs += time.now() - readAt;
              signal.throwIfAborted();
              noteAdmission();
              await waitForReply();
              continue;
            }
            resultReads++;
            const response = await result(
              ownerId,
              request.sandboxId,
              request.requestId,
              admitted.epoch,
              request.op === "extendCommandAuthority" ? options.assertClaim : undefined,
            ).finally(() => {
              resultReadMs += time.now() - readAt;
            });
            signal.throwIfAborted();
            if (response.state === "finished") {
              if (options.strictDeadline && time.now() >= deadline) throw new RuntimeCommandPending();
              observed = true;
              return response.reply;
            }
            if (response.state !== "pending") throw new RuntimeCommandConflict();
            // Waiting on a live reply is runtime work even for a retried ID; a stored reply is not.
            noteAdmission();
            await waitForReply();
          }
        } finally {
          wake.close();
          if (scope) {
            const ended = time.now();
            logWorkspaceCommand(scope, request.requestId, observed ? "observed" : "wait_ended", ended, {
              durationMs: ended - admittedAt,
              resultReads,
              resultReadMs,
            });
          }
        }
      },
      (reply) => {
        if (acceptReply(reply)) return true;
        recordOperatorDiagnostic(
          `runtime.${operation}`,
          {
            errorClass: "RuntimeCommandReply",
            message: `Runtime reply rejected (HTTP ${reply.status})`,
            stack: [],
          },
          { sandboxId },
        );
        return false;
      },
      { replayable: true, sandboxId: () => sandboxId },
    );
  }
  const route: Route = async (request) => {
    const path = new URL(request.url).pathname;
    if (!["/api/runtime/poll", "/api/runtime/results"].includes(path)) return null;
    const headers = { "cache-control": "no-store" };
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, allow: "POST" } });
    const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "";
    const epoch = request.headers.get("x-armada-runtime-epoch") ?? "";
    try {
      const value = await body(request);
      if (path === "/api/runtime/results") return Response.json(await complete(token, epoch, value), { headers });
      if (!record(value) || value.epoch !== epoch || Object.keys(value).some((k) => k !== "epoch"))
        throw new RuntimeCommandConflict();
      const deadline = time.now() + 20000;
      while (!request.signal.aborted) {
        let wake: ReturnType<typeof runtimeWakes.watch> | undefined;
        try {
          const response = await withNext(
            token,
            epoch,
            async (value) => value,
            (sandboxId) => {
              wake = runtimeWakes.watch(`poll:${sandboxId}`);
            },
          );
          const remaining = deadline - time.now();
          if (response.command) {
            logWorkspaceCommand(
              { sandboxId: response.command.sandboxId, epoch: response.epoch },
              response.command.requestId,
              "sent_poll",
              time.now(),
            );
            return Response.json(response, { headers });
          }
          if (remaining <= 0) return Response.json(response, { headers });
          await wake?.wait(request.signal, Math.min(1000, remaining), time.wait.bind(time));
        } finally {
          wake?.close();
        }
      }
      return new Response(null, { status: 499, headers });
    } catch (error) {
      const status =
        error instanceof RuntimeEnrolmentDenied ? 401 : error instanceof RuntimeCommandConflict ? 409 : 503;
      return runtimeHttpFailure(status, status === 409 ? "runtime_command_conflict" : undefined);
    }
  };
  return { enqueue, pendingHead, next, withNext, complete, result, call, callPrepared, callAuthorityExtension, route };
}
