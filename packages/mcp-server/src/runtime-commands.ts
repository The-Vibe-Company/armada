import type { RunnerRequest } from "@armada/agent-runtime";
import { decryptSecret, encryptSecret } from "@armada/core/server";
import type { Route } from "./http.ts";
import { type createRuntimeEnrolments, RuntimeEnrolmentDenied } from "./runtime-enrolment.ts";

const MAX_COMMAND = 1048576;
const MAX_REPLY = MAX_COMMAND * 2;
export class RuntimeCommandConflict extends Error {
  constructor() {
    super("runtime_command_conflict");
  }
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
  async function enqueue(ownerId: string, request: RunnerRequest) {
    if (request.version !== 1 || !requestId(request.requestId) || typeof request.op !== "string")
      throw new RuntimeCommandConflict();
    const serialized = JSON.stringify(request);
    if (Buffer.byteLength(serialized) > MAX_COMMAND) throw new RuntimeCommandConflict();
    const sealed = await encryptSecret(serialized, key);
    return authority.withOwner(request.sandboxId, ownerId, async (tx, scope) => {
      // Include BOTH published wire envelopes, not merely the inner RunnerRequest.
      // A head-of-line command must always fit the client's 1 MiB JSON/frame cap.
      const overhead =
        Math.max(
          Buffer.byteLength(JSON.stringify({ epoch: scope.epoch, command: null })),
          Buffer.byteLength(JSON.stringify({ type: "command", epoch: scope.epoch, request: null })),
        ) - 4; // Replace the JSON null with the already serialized command.
      if (Buffer.byteLength(serialized) + overhead > MAX_COMMAND) throw new RuntimeCommandConflict();
      const previous = (
        await tx.query<{ epoch: string; request_enc: Uint8Array<ArrayBuffer> }>(
          "select epoch::text,request_enc from public.runtime_commands where sandbox_id=$1 and request_id=$2",
          [scope.sandboxId, request.requestId],
        )
      ).rows[0];
      if (previous) {
        if (previous.epoch !== scope.epoch || (await decryptSecret(previous.request_enc, key)) !== serialized)
          throw new RuntimeCommandConflict();
      } else {
        await tx.query(
          "insert into public.runtime_commands(sandbox_id,request_id,epoch,request_enc) values($1,$2,$3,$4)",
          [scope.sandboxId, request.requestId, scope.epoch, sealed],
        );
      }
      return { epoch: scope.epoch, requestId: request.requestId };
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
          `select request_enc from public.runtime_commands where sandbox_id=$1 and epoch=$2 and result_enc is null order by sequence limit 1`,
          [scope.sandboxId, scope.epoch],
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
    const sealed = await encryptSecret(serialized, key);
    return authority.withSession(token, epoch, async (tx, scope) => {
      const row = (
        await tx.query(
          `update public.runtime_commands set result_enc=coalesce(result_enc,$4)
         where sandbox_id=$1 and request_id=$2 and epoch=$3 returning request_id`,
          [scope.sandboxId, value.requestId, scope.epoch, sealed],
        )
      ).rows[0];
      if (!row) throw new RuntimeCommandConflict();
      return { epoch: scope.epoch, requestId: value.requestId };
    });
  }
  async function result(ownerId: string, sandboxId: string, id: string) {
    if (!requestId(id)) throw new RuntimeCommandConflict();
    return authority.withOwner(sandboxId, ownerId, async (tx, scope) => {
      const row = (
        await tx.query<{ epoch: string; result_enc: Uint8Array<ArrayBuffer> | null }>(
          "select epoch::text,result_enc from public.runtime_commands where sandbox_id=$1 and request_id=$2",
          [sandboxId, id],
        )
      ).rows[0];
      if (!row) return { state: "missing" as const };
      if (row.result_enc)
        return { state: "finished" as const, reply: JSON.parse(await decryptSecret(row.result_enc, key)) as unknown };
      return { state: row.epoch === scope.epoch ? ("pending" as const) : ("superseded" as const) };
    });
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
      return Response.json(
        {
          error:
            status === 401
              ? "runtime_enrolment_denied"
              : status === 409
                ? "runtime_command_conflict"
                : "runtime_unavailable",
        },
        { status, headers },
      );
    }
  };
  return { enqueue, next, withNext, complete, result, route };
}
