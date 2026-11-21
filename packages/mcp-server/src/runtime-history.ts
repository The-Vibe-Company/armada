import {
  type AgentEvent,
  buildEventPage,
  type EventPage,
  type EventsRequest,
  eventPageOptions,
  isFinalPromptStatus,
  type Provider,
  ProviderError,
} from "@armada/core";
import { decryptSecret, type Sql } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { createSqlData, type SandboxView } from "./data.ts";
import { SANDBOX_VISIBLE } from "./sandbox-visibility.ts";

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

export type SandboxLogReader = Pick<Provider, "events" | "get" | "getPrompt">;

export function createModalJobReader(sql: Sql, key: string) {
  const history = createRuntimeHistory(sql, key);
  const data = createSqlData(sql);
  return async (sandbox: SandboxView, caller: Caller) => {
    if (sandbox.runtimeTransport !== "dialout" || sandbox.lifecycleGeneration === undefined) return null;
    const current = async () => {
      const row = await data(caller).sandboxes.get(sandbox.id);
      if (!row || row.lifecycleGeneration !== sandbox.lifecycleGeneration)
        throw new ProviderError({
          provider: sandbox.provider,
          code: "conflict",
          message: "The sandbox binding changed during observation.",
          retryable: true,
        });
      return row;
    };
    const { rows } = await sql.query(
      `select 1 from public.sandboxes s join public.jobs j on j.sandbox_id=s.id
       where ${SANDBOX_VISIBLE} and s.id=$3 and s.provider='modal' and j.kind='launch'
         and s.lifecycle_generation=$4 and j.generation=s.lifecycle_generation`,
      [caller.orgs.map((org) => org.orgId), caller.userId, sandbox.id, sandbox.lifecycleGeneration],
    );
    if (!rows.length) return null;
    const events: Provider["events"] = async ({ sandboxId: _placement, ...pagination }) => {
      const page = await history(caller, sandbox.id, pagination);
      await current();
      return page;
    };
    const reader: SandboxLogReader & Pick<Provider, "id"> = {
      id: sandbox.provider,
      events,
      async get() {
        const row = await current();
        return {
          id: row.providerSandboxId,
          name: row.id,
          state: row.stopRequestedAt ? "stopping" : row.status === "deleted" ? "stopped" : row.status,
          providerState: "recorded",
          labels: {},
        } satisfies Awaited<ReturnType<Provider["get"]>>;
      },
      async getPrompt({ promptId, signal }: Parameters<Provider["getPrompt"]>[0]) {
        let cursor: string | undefined;
        for (let page = 0; page < 50; page++) {
          const read = await events({
            sandboxId: sandbox.providerSandboxId,
            direction: "backward",
            limit: 200,
            ...(cursor ? { cursor } : {}),
            ...(signal ? { signal } : {}),
          });
          const last = read.events.findLast((event) => event.kind === "prompt" && event.promptId === promptId);
          if (last?.kind === "prompt") {
            return { promptId, status: last.status, done: isFinalPromptStatus(last.status) };
          }
          if (!read.hasMore || !read.olderCursor || read.olderCursor === cursor) break;
          cursor = read.olderCursor;
        }
        const row = await current();
        if (row.taskPromptId === promptId && row.status === "running")
          return { promptId, status: "running", done: false };
        throw new ProviderError({
          provider: sandbox.provider,
          code: "not_found",
          message: "No recorded runtime prompt.",
          retryable: true,
        });
      },
    };
    return reader;
  };
}

export function createModalLogReader(
  sql: Sql,
  key: string,
  resolveProvider: (sandbox: SandboxView, caller: Caller) => Promise<Provider>,
) {
  const history = createRuntimeHistory(sql, key);
  const jobReader = createModalJobReader(sql, key);
  const read: (sandbox: SandboxView, caller: Caller) => Promise<SandboxLogReader> = async (sandbox, caller) => {
    if (sandbox.runtimeTransport !== "dialout") return resolveProvider(sandbox, caller);

    let observation: Promise<SandboxLogReader> | undefined;
    const current = () =>
      (observation ??= jobReader(sandbox, caller).then((reader) => reader ?? resolveProvider(sandbox, caller)));
    return {
      events: ({ sandboxId: _placement, ...pagination }) => history(caller, sandbox.id, pagination),
      get: async (...args) => (await current()).get(...args),
      getPrompt: async (request) => (await current()).getPrompt(request),
    };
  };
  return read;
}
