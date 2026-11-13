import {
  type AgentEvent,
  buildEventPage,
  type EventPage,
  type EventsRequest,
  eventPageOptions,
  ProviderError,
} from "@armada/core";
import { decryptSecret, type Sql } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { createSqlData } from "./data.ts";

/** Durable journal reads, never live host/native-agent observations. */
export function createRuntimeHistory(
  sql: Sql,
  key: string,
  trusted?: {
    provider: "docker";
    authorize(caller: Caller, sandboxId: string): Promise<{ status: string; statusReason: string | null }>;
  },
) {
  const provider = trusted?.provider ?? "boat";
  const data = createSqlData(sql);
  return async (caller: Caller, sandboxId: string, request: Omit<EventsRequest, "sandboxId">): Promise<EventPage> => {
    const denied = () =>
      new ProviderError({
        provider,
        code: "not_found",
        message: "No runtime history for this sandbox.",
        retryable: false,
      });
    const authorize = async () => {
      if (trusted) return trusted.authorize(caller, sandboxId);
      const row = await data(caller).sandboxes.get(sandboxId);
      if (row?.boatRuntime !== true && row?.runtimeTransport !== "dialout") throw denied();
      return row;
    };
    await authorize();
    const { limit, backward } = eventPageOptions(request, provider);
    const prefix = `ar1_${sandboxId}_`;
    let boundary: string | undefined;
    if (request.cursor !== undefined) {
      boundary = request.cursor.startsWith(prefix) ? request.cursor.slice(prefix.length) : undefined;
      if (boundary === undefined || !/^(0|[1-9][0-9]{0,15})$/.test(boundary) || !Number.isSafeInteger(Number(boundary)))
        throw new ProviderError({
          provider,
          code: "invalid_request",
          message: "Invalid runtime history cursor.",
          retryable: false,
        });
    }
    request.signal?.throwIfAborted();
    const rows = (
      await sql.query<{ sequence: string; event_enc: Uint8Array<ArrayBuffer> }>(
        `select sequence::text,event_enc from public.runtime_events where sandbox_id=$1
       and ($2::bigint is null or sequence ${backward ? "<" : ">"} $2)
       order by runtime_events.sequence ${backward ? "desc" : "asc"} limit $3`,
        [sandboxId, boundary ?? (backward ? null : "0"), limit + 1],
      )
    ).rows;
    let entries: { cursor: string; event: AgentEvent }[];
    try {
      entries = await Promise.all(
        rows.slice(0, limit).map(async (row) => ({
          cursor: `${prefix}${row.sequence}`,
          event: JSON.parse(await decryptSecret(row.event_enc, key)) as AgentEvent,
        })),
      );
    } catch {
      throw new ProviderError({
        provider,
        code: "unavailable",
        message: "Runtime history is unavailable.",
        retryable: false,
      });
    }
    request.signal?.throwIfAborted();
    const page = buildEventPage(entries, request, rows.length > limit, provider);
    // Scope is revalidated after decryption, not merely before the archive query.
    const latest = await authorize();
    request.signal?.throwIfAborted();
    return {
      ...(latest.status === "failed"
        ? { runtimeFailure: { status: "failed" as const, reason: latest.statusReason ?? "Armada runtime failed." } }
        : {}),
      ...page,
      // Raw cursor/limit anchors include inspected unrelated conversation entries.
      // Filter after bounding to preserve forward progress on empty filtered pages.
      events:
        request.conversationId === undefined
          ? page.events
          : page.events.filter((event) => event.conversationId === request.conversationId),
      source: "armada-runtime",
    };
  };
}
