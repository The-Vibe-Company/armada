import {
  type AgentEvent,
  type Harness,
  type MemberRole,
  PROMPT_STATUSES,
  reportedTurnUsage,
  type Sql,
  VaultError,
} from "@armada/core";
import { decryptSecret, encryptSecret } from "@armada/core/server";
import { createSqlData } from "./data.ts";
import type { Route } from "./http.ts";
import { type createRuntimeEnrolments, RuntimeEnrolmentDenied } from "./runtime-enrolment.ts";
import { runtimeHttpFailure } from "./runtime-http-failure.ts";
import type { RuntimeNativePublication } from "./runtime-native-auth.ts";
import { logRuntimeStage } from "./runtime-progress.ts";
import { admittedTurnContexts } from "./turn-pricing.ts";

class InvalidEvents extends Error {}
class ConflictingEvent extends Error {}
class OversizedEvents extends Error {}
class UnsupportedNativeAuth extends Error {}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && !v.includes("\0");
function event(value: unknown): value is AgentEvent {
  if (
    !record(value) ||
    !id(value.id) ||
    !Number.isSafeInteger(value.at) ||
    (value.at as number) < 0 ||
    (value.promptId !== undefined && !id(value.promptId)) ||
    (value.conversationId !== undefined && !id(value.conversationId))
  )
    return false;
  if (value.kind === "prompt")
    return typeof value.text === "string" && PROMPT_STATUSES.some((status) => status === value.status);
  if (value.kind === "steer") return typeof value.text === "string";
  if (value.kind === "other") return id(value.type);
  return (
    value.kind === "message" &&
    typeof value.text === "string" &&
    typeof value.partial === "boolean" &&
    Array.isArray(value.tools) &&
    value.tools.every(
      (tool) =>
        record(tool) &&
        id(tool.id) &&
        id(tool.name) &&
        (tool.server === undefined || id(tool.server)) &&
        (tool.result === undefined || (record(tool.result) && typeof tool.result.isError === "boolean")),
    )
  );
}
/** JSON object key order is not producer identity. Preserve array order and all values. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
async function body(request: Request): Promise<unknown> {
  if (!request.body) throw new InvalidEvents();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of request.body) {
    bytes += chunk.byteLength;
    if (bytes > 1048576) throw new OversizedEvents();
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidEvents();
  }
}

/** ACK only after both encrypted archive and the existing usage projection commit. */
export function createRuntimeEvents(
  authority: ReturnType<typeof createRuntimeEnrolments>,
  key: string,
  publishNativeAuth?: (input: RuntimeNativePublication) => Promise<{ authRevision: number; committed: boolean }>,
) {
  async function append(
    token: string,
    epoch: string,
    value: unknown,
  ): Promise<{ acknowledgedSequence: number } | { authRevision: number; committed: boolean }> {
    if (!record(value)) throw new InvalidEvents();
    if (value.nativeAuth !== undefined && publishNativeAuth) {
      if (
        typeof value.sandboxId !== "string" ||
        typeof value.generation !== "string" ||
        !Array.isArray(value.events) ||
        value.events.length ||
        !record(value.nativeAuth) ||
        Object.keys(value).some((k) => !["sandboxId", "generation", "events", "nativeAuth"].includes(k)) ||
        Object.keys(value.nativeAuth).some((k) => !["authJson", "expectedRevision"].includes(k)) ||
        typeof value.nativeAuth.authJson !== "string" ||
        Buffer.byteLength(value.nativeAuth.authJson) > 65536 ||
        !Number.isSafeInteger(value.nativeAuth.expectedRevision) ||
        (value.nativeAuth.expectedRevision as number) < 0
      )
        throw new InvalidEvents();
      // Publisher owns its credential/source lock order; never wrap it in an outer
      // sandbox-first transaction or publish on a separate connection after admission.
      return publishNativeAuth({
        token,
        epoch,
        sandboxId: value.sandboxId,
        generation: value.generation,
        authJson: value.nativeAuth.authJson,
        expectedRevision: value.nativeAuth.expectedRevision as number,
      });
    }
    let first: { sandboxId: string; epoch: string } | undefined;
    const result = await authority.withSession(token, epoch, async (tx, scope) => {
      if (value.sandboxId !== scope.sandboxId || value.generation !== scope.epoch) throw new RuntimeEnrolmentDenied();
      if (value.nativeAuth !== undefined) throw new UnsupportedNativeAuth();
      if (
        Object.keys(value).some((k) => !["sandboxId", "generation", "events"].includes(k)) ||
        !Array.isArray(value.events) ||
        value.events.length > 1000
      )
        throw new InvalidEvents();
      let items: { sequence: number; event: AgentEvent; serialized: string }[];
      try {
        items = value.events
          .map((item: unknown) => {
            if (
              !record(item) ||
              !Number.isSafeInteger(item.sequence) ||
              (item.sequence as number) < 1 ||
              !event(item.event)
            )
              throw new InvalidEvents();
            const serialized = JSON.stringify(canonical(item.event));
            if (serialized.length > 262144) throw new OversizedEvents();
            return { sequence: item.sequence as number, event: item.event, serialized };
          })
          .sort((a, b) => a.sequence - b.sequence);
      } catch (error) {
        if (error instanceof OversizedEvents) throw error;
        throw new InvalidEvents();
      }
      let ack = Number(
        (
          await tx.query<{ ack: string }>(
            "select coalesce(max(sequence),0)::text as ack from public.runtime_events where sandbox_id=$1",
            [scope.sandboxId],
          )
        ).rows[0]?.ack ?? "0",
      );
      const initialAck = ack;
      const references = [...new Set(items.flatMap((item) => (item.event.promptId ? [item.event.promptId] : [])))];
      const known = new Set(
        (references.length
          ? (
              await tx.query<{ id: string }>(
                "select counted_prompt_id as id from public.runtime_events where sandbox_id=$1 and counted_prompt_id=any($2::text[])",
                [scope.sandboxId, references],
              )
            ).rows
          : []
        ).map((row) => row.id),
      );
      const existing = new Map(
        (items.length
          ? (
              await tx.query<{ sequence: string; event_enc: Uint8Array<ArrayBuffer> }>(
                "select sequence::text,event_enc from public.runtime_events where sandbox_id=$1 and sequence=any($2::bigint[])",
                [scope.sandboxId, [...new Set(items.map((item) => item.sequence))]],
              )
            ).rows
          : []
        ).map((row) => [Number(row.sequence), row.event_enc]),
      );
      let addedPrompt = false;
      const fresh: AgentEvent[] = [];
      const pending = new Map<number, string>();
      const sequences: number[] = [];
      const markers: (string | null)[] = [];
      const encrypted: string[] = [];
      for (const item of items) {
        if (item.sequence > ack + 1) break; // Commit only the contiguous prefix, never an event beyond a gap.
        const previous = existing.get(item.sequence);
        const serialized = pending.get(item.sequence);
        if (previous || serialized !== undefined) {
          if ((serialized ?? (await decryptSecret(previous!, key))) !== item.serialized) throw new ConflictingEvent();
        } else {
          // A missing row below the high-water mark is corruption, not permission to rewrite history.
          if (item.sequence <= ack) throw new ConflictingEvent();
          const marker = item.event.promptId && !known.has(item.event.promptId) ? item.event.promptId : null;
          sequences.push(item.sequence);
          markers.push(marker);
          // bytea array elements must be PostgreSQL hex input, not Uint8Array's decimal string.
          encrypted.push(`\\x${Buffer.from(await encryptSecret(item.serialized, key)).toString("hex")}`);
          pending.set(item.sequence, item.serialized);
          if (marker) {
            known.add(marker);
            addedPrompt = true;
          }
          fresh.push(item.event);
        }
        ack = Math.max(ack, item.sequence);
      }
      if (sequences.length)
        await tx.query(
          `insert into public.runtime_events(sandbox_id,sequence,epoch,counted_prompt_id,event_enc)
           select $1,sequence,$2,marker,event_enc
           from unnest($3::bigint[],$4::text[],$5::bytea[]) as batch(sequence,marker,event_enc)`,
          [scope.sandboxId, scope.epoch, sequences, markers, encrypted],
        );
      const usage = reportedTurnUsage(fresh);
      if (addedPrompt || usage.turns.length) {
        // recordUsage merges cumulative snapshots, not per-batch deltas. Prompt-only
        // failures/unknown turns must remain in the coverage denominator as well.
        usage.turnCount = Number(
          (
            await tx.query<{ count: string }>(
              "select count(*)::text as count from public.runtime_events where sandbox_id=$1 and counted_prompt_id is not null",
              [scope.sandboxId],
            )
          ).rows[0]?.count ?? "0",
        );
        const owner = (
          await tx.query<{ owner_id: string; org_id: string; role: MemberRole; harness: Harness }>(
            `select s.owner_id,s.org_id,m.role,s.harness::text as harness from public.sandboxes s join public.members m
           on m.org_id=s.org_id and m.user_id=s.owner_id where s.id=$1`,
            [scope.sandboxId],
          )
        ).rows[0];
        if (!owner) throw new RuntimeEnrolmentDenied();
        // Stay inside the epoch/archive transaction. A query-only tx would take
        // recordUsage's legacy unpriced fallback and silently lose admission.
        const local: Sql = {
          ...tx,
          query: tx.query.bind(tx),
          transaction: async (work) => work(tx),
        };
        const data = createSqlData(local)({
          userId: owner.owner_id,
          orgs: [{ orgId: owner.org_id, role: owner.role }],
          via: "service",
        });
        if (!data.sandboxes.recordUsage) throw Error("runtime_usage_projection_unavailable");
        const admission = (
          await tx.query<{ context: unknown; captured: boolean }>(
            "select pricing_context as context,pricing_context is not null as captured from public.runtime_enrolments where sandbox_id=$1 and epoch=$2",
            [scope.sandboxId, scope.epoch],
          )
        ).rows[0];
        await data.sandboxes.recordUsage(scope.sandboxId, usage, {
          observations: usage.turns,
          ...(admission?.captured
            ? { contexts: admittedTurnContexts(admission.context, usage.turns, owner.harness) }
            : {}),
        });
      }
      if (initialAck === 0 && fresh.length) first = scope;
      return { acknowledgedSequence: ack };
    });
    if (first) logRuntimeStage(first, "first_event"); // Only after encrypted archive/usage commit.
    return result;
  }
  const route: Route = async (request) => {
    if (new URL(request.url).pathname !== "/api/runtime/events") return null;
    const headers = { "cache-control": "no-store" };
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, allow: "POST" } });
    const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "";
    const epoch = request.headers.get("x-armada-runtime-epoch") ?? "";
    try {
      return Response.json(await append(token, epoch, await body(request)), { headers });
    } catch (error) {
      const status =
        error instanceof RuntimeEnrolmentDenied ||
        (error instanceof VaultError && ["not_found", "forbidden"].includes(error.code))
          ? 401
          : error instanceof ConflictingEvent
            ? 409
            : error instanceof OversizedEvents
              ? 413
              : error instanceof InvalidEvents || (error instanceof VaultError && error.code === "invalid")
                ? 400
                : error instanceof UnsupportedNativeAuth
                  ? 501
                  : 503;
      return runtimeHttpFailure(
        status,
        status === 501
          ? "runtime_native_auth_not_supported"
          : status === 401 || status === 503
            ? undefined
            : "invalid_runtime_events",
      );
    }
  };
  return { append, route };
}
