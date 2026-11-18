import type { RunnerRequest } from "@armada/agent-runtime";
import { decryptSecret, encryptSecret } from "@armada/core/server";
import type { Route } from "./http.ts";
import { noteAdmission, observeProviderCall } from "./request-observability.ts";
import { type createRuntimeEnrolments, RuntimeEnrolmentDenied, type RuntimeOwnerScope } from "./runtime-enrolment.ts";
import { runtimeHttpFailure } from "./runtime-http-failure.ts";

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
  async wait(ms, signal) {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
    });
  },
};
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
  async function enqueue(ownerId: string, request: RunnerRequest, expectedEpoch?: string) {
    if (request.version !== 1 || !requestId(request.requestId) || typeof request.op !== "string")
      throw new RuntimeCommandRefused();
    const serialized = JSON.stringify(request);
    if (Buffer.byteLength(serialized) > MAX_COMMAND) throw new RuntimeCommandRefused();
    const sealed = await encryptSecret(serialized, key);
    return authority.withOwner(request.sandboxId, ownerId, async (tx, scope) => {
      if (expectedEpoch !== undefined && scope.epoch !== expectedEpoch) throw new RuntimeCommandRefused();
      // Application-secret taint forbids file egress: never admit an output read (row locked here).
      if (
        request.op === "readOutputs" &&
        (await tx.query("select 1 from public.sandboxes where id=$1 and application_secret_tainted", [scope.sandboxId]))
          .rows.length
      )
        throw new RuntimeCommandRefused();
      // Checkpoint intent fences every mutation entry point, including Docker.
      if (
        !["checkpoint", "events", "health", "getPrompt", "getExec", "observeOrchestrator", "readOutputs"].includes(
          request.op,
        ) &&
        (
          await tx.query("select 1 from public.runtime_checkpoints where sandbox_id=$1 and epoch=$2", [
            scope.sandboxId,
            scope.epoch,
          ])
        ).rows.length
      )
        throw new RuntimeCommandRefused();
      // Include BOTH published wire envelopes, not merely the inner RunnerRequest.
      // A head-of-line command must always fit the client's 1 MiB JSON/frame cap.
      const overhead =
        Math.max(
          Buffer.byteLength(JSON.stringify({ epoch: scope.epoch, command: null })),
          Buffer.byteLength(JSON.stringify({ type: "command", epoch: scope.epoch, request: null })),
        ) - 4; // Replace the JSON null with the already serialized command.
      if (Buffer.byteLength(serialized) + overhead > MAX_COMMAND) throw new RuntimeCommandRefused();
      const previous = (
        await tx.query<{ epoch: string; request_enc: Uint8Array<ArrayBuffer> }>(
          "select epoch::text,request_enc from public.runtime_commands where sandbox_id=$1 and request_id=$2",
          [scope.sandboxId, request.requestId],
        )
      ).rows[0];
      if (previous) {
        // A row with this ID already exists and may have executed: not a definite refusal.
        if (previous.epoch !== scope.epoch || (await decryptSecret(previous.request_enc, key)) !== serialized)
          throw new RuntimeCommandConflict();
      } else {
        await tx.query(
          "insert into public.runtime_commands(sandbox_id,request_id,epoch,request_enc) values($1,$2,$3,$4)",
          [scope.sandboxId, request.requestId, scope.epoch, sealed],
        );
        noteAdmission();
      }
      // `fresh`: this call inserted the command (see `call`'s `admitted`).
      return { epoch: scope.epoch, requestId: request.requestId, provider: scope.provider, fresh: !previous };
    });
  }
  /** Keep admission fenced through synchronous socket enqueue; never await network I/O here. */
  async function withNext<T>(
    token: string,
    epoch: string,
    use: (value: { epoch: string; command: RunnerRequest | null }) => Promise<T>,
  ) {
    return authority.withSession(token, epoch, async (tx, scope) => {
      const row = (
        await tx.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
          `select request_enc from public.runtime_commands c where sandbox_id=$1 and epoch=$2 and result_enc is null
           and not ${expiredOutputRead("request_id", "$3")}
           and not (starts_with(request_id,'outputs_') and exists(select 1 from public.sandboxes s
             where s.id=c.sandbox_id and s.application_secret_tainted))
           and not (starts_with(request_id,'outputs_') and exists(select 1 from public.runtime_commands later
             where later.sandbox_id=c.sandbox_id and later.epoch=c.epoch and later.sequence>c.sequence
             and later.result_enc is not null))
           order by sequence limit 1`,
          [scope.sandboxId, scope.epoch, String(time.now())],
        )
      ).rows[0];
      return use({
        epoch: scope.epoch,
        command: row ? (JSON.parse(await decryptSecret(row.request_enc, key)) as RunnerRequest) : null,
      });
    });
  }
  async function next(token: string, epoch: string) {
    return withNext(token, epoch, async (value) => value);
  }
  async function complete(token: string, epoch: string, value: unknown) {
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
    let sealed = await encryptSecret(serialized, key);
    return authority.withSession(token, epoch, async (tx, scope) => {
      // An output read issued before application-secret taint committed: the session holds the
      // sandbox row lock, so this sees committed taint. Acknowledge it (the runtime's ordered queue
      // advances) but never retain its file bytes.
      if (
        String(value.requestId).startsWith("outputs_") &&
        (await tx.query("select 1 from public.sandboxes where id=$1 and application_secret_tainted", [scope.sandboxId]))
          .rows.length
      )
        sealed = await encryptSecret(
          JSON.stringify({
            epoch: value.epoch,
            requestId: value.requestId,
            status: 410,
            body: { requestId: value.requestId, error: "application_secret_tainted" },
          }),
          key,
        );
      const row = (
        await tx.query<{ request_id: string; result_enc: Uint8Array<ArrayBuffer> }>(
          `update public.runtime_commands set result_enc=coalesce(result_enc,$4)
         where sandbox_id=$1 and request_id=$2 and epoch=$3 returning request_id,result_enc`,
          [scope.sandboxId, value.requestId, scope.epoch, sealed],
        )
      ).rows[0];
      if (!row) throw new RuntimeCommandConflict();
      // Use the first durable reply, including on replay. A stop may already
      // have cancelled the queue entry; it cannot erase accepted turn identity.
      const reply = JSON.parse(await decryptSecret(row.result_enc, key));
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
      return { epoch: scope.epoch, requestId: value.requestId };
    });
  }
  async function result(ownerId: string, sandboxId: string, id: string, expectedEpoch?: string) {
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
      if (row.result_enc)
        return {
          state: "finished" as const,
          reply: JSON.parse(await decryptSecret(row.result_enc, key)) as RuntimeCommandReply,
        };
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
   * A caller that enqueued in its own fenced transaction passes that enqueue's `fresh` as
   * `admitted`: the runner may answer before the first result read, so only the original insert
   * tells a fresh admission from a replay.
   */
  async function call(
    ownerId: string,
    request: RunnerRequest,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      expectedEpoch?: string;
      accept?: (reply: RuntimeCommandReply) => boolean;
      admitted?: boolean;
    } = {},
  ): Promise<RuntimeCommandReply> {
    let provider: RuntimeOwnerScope["provider"];
    return observeProviderCall(
      () => provider,
      `runtime.${request.op}`,
      async () => {
        const timeout = options.timeoutMs ?? 120_000;
        if (
          !Number.isSafeInteger(timeout) ||
          timeout < 1 ||
          timeout > (request.op === "workspaceExec" ? 610_000 : request.op === "exec" ? 630_000 : 120_000)
        )
          throw new RuntimeCommandRefused();
        const signal = options.signal ?? new AbortController().signal;
        signal.throwIfAborted();
        const deadline = time.now() + timeout;
        const admitted = await enqueue(ownerId, request, options.expectedEpoch);
        provider = admitted.provider;
        if (options.admitted) noteAdmission();
        while (true) {
          signal.throwIfAborted();
          const response = await result(ownerId, request.sandboxId, request.requestId, admitted.epoch);
          signal.throwIfAborted();
          if (response.state === "finished") return response.reply;
          if (response.state !== "pending") throw new RuntimeCommandConflict();
          // Waiting on a live reply is runtime work even for a retried ID; a stored reply is not.
          noteAdmission();
          const remaining = deadline - time.now();
          if (remaining <= 0) throw new RuntimeCommandPending();
          await time.wait(Math.min(250, remaining), signal);
        }
      },
      (reply) =>
        reply.status === 200 &&
        reply.body.version === 1 &&
        reply.body.requestId === request.requestId &&
        reply.body.error === undefined &&
        (options.accept?.(reply) ?? true),
      // A retried request ID whose reply is already stored is answered from the database.
      { replayable: true },
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
        const response = await next(token, epoch);
        if (response.command || time.now() >= deadline) return Response.json(response, { headers });
        await time.wait(Math.min(1000, Math.max(0, deadline - time.now())), request.signal);
      }
      return new Response(null, { status: 499, headers });
    } catch (error) {
      const status =
        error instanceof RuntimeEnrolmentDenied ? 401 : error instanceof RuntimeCommandConflict ? 409 : 503;
      return runtimeHttpFailure(status, status === 409 ? "runtime_command_conflict" : undefined);
    }
  };
  return { enqueue, next, withNext, complete, result, call, route };
}
