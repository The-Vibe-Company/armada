import {
  type AgentEvent,
  buildEventPage,
  type EventPage,
  type EventsRequest,
  eventPageOptions,
  isFinalPromptStatus,
  type Provider,
  ProviderError,
  type SandboxStatus,
} from "@armada/core";
import { decryptSecret, modalLaunchSetupKeySql, type Sql, VaultError } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { createSqlData, type SandboxView } from "./data.ts";
import { modalSetupFailureReason } from "./jobs/modal-launch-setup.ts";
import { publicSandboxStatusSql } from "./sandbox-readiness.ts";
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
      if (row?.boatRuntime !== true && row?.modalTransport !== "dialout") throw denied();
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

export type SandboxLogReader = Pick<Provider, "events" | "get" | "getPrompt"> & {
  followSettled?(fenceEvents?: boolean): Promise<boolean | undefined>;
};

export function createModalJobReader(sql: Sql, key: string) {
  const history = createRuntimeHistory(sql, key);
  const data = createSqlData(sql);
  return async (sandbox: SandboxView, caller: Caller) => {
    if (sandbox.modalTransport !== "dialout" || sandbox.lifecycleGeneration === undefined) return null;
    const current = async () => {
      const row = await data(caller).sandboxes.get(sandbox.id);
      if (!row) throw new VaultError("not_found", "No visible runtime sandbox.");
      if (row.lifecycleGeneration !== sandbox.lifecycleGeneration)
        throw new VaultError("conflict", "The sandbox binding changed during observation.");
      return row;
    };
    const scope = [caller.orgs.map((org) => org.orgId), caller.userId, sandbox.id, sandbox.lifecycleGeneration];
    const evidence = async () =>
      (
        await sql.query<{
          job_owned: boolean;
          enrolled_status: SandboxStatus | null;
          setup_reason: string | null;
          settled: boolean;
          active_prompt: string | null;
        }>(
          `select exists(select 1 from public.jobs j where j.sandbox_id=s.id and j.kind='launch' and j.payload_enc is not null
            and j.generation<=s.lifecycle_generation
            and j.org_id=s.org_id and j.request_owner_id=s.owner_id) as job_owned,
          case when s.status in ('ready','running') then ${publicSandboxStatusSql} end as enrolled_status,
          setup.outcome->>'reason' as setup_reason,
          case
            when s.stop_requested_at is not null or s.status in ('starting','stopping') then false
            when s.status='running' and nullif(s.task_prompt_id,'') is null then false
            when s.status in ('stopped','deleted','failed') then true
            else coalesce(setup.state not in ('leased','queued'),true)
              and not exists(select 1 from public.account_turn_queue q where q.sandbox_id=s.id
                and q.queued_generation=s.lifecycle_generation and q.state in ('queued','dispatching'))
              and not exists(select 1 from public.runtime_idle_turns t where t.sandbox_id=s.id and not t.settled)
              and (nullif(s.task_prompt_id,'') is null or coalesce(turn.settled,false))
          end as settled,
          case when s.status in ('ready','running') and not coalesce(turn.settled,false)
            then s.task_prompt_id end as active_prompt
         from public.sandboxes s
         left join public.jobs setup on setup.idem_key=${modalLaunchSetupKeySql()}
         left join public.runtime_idle_turns turn on turn.sandbox_id=s.id and turn.prompt_id=s.task_prompt_id
         where ${SANDBOX_VISIBLE} and s.id=$3 and s.lifecycle_generation=$4 and s.provider='modal' and s.runtime_transport='dialout'`,
          scope,
        )
      ).rows[0];
    const observed = await evidence();
    if (!observed?.job_owned) {
      await current();
      return null;
    }
    const events: Provider["events"] = async ({ sandboxId: _placement, ...pagination }) => {
      try {
        return await history(caller, sandbox.id, pagination);
      } finally {
        await current();
      }
    };
    const reader = {
      id: sandbox.provider,
      events,
      enrolledStatus: observed.enrolled_status,
      settled: observed.settled,
      setupFailure: modalSetupFailureReason(observed.setup_reason),
      verify: current,
      async followSettled() {
        const latest = await evidence();
        if (!latest) throw new VaultError("conflict", "The sandbox binding changed during observation.");
        return latest.settled;
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
        const latest = await evidence();
        if (!latest) throw new VaultError("conflict", "The sandbox binding changed during observation.");
        if (latest.active_prompt === promptId) return { promptId, status: "running", done: false };
        throw new ProviderError({
          provider: sandbox.provider,
          code: "not_found",
          message: "No recorded runtime prompt.",
          retryable: true,
        });
      },
    } satisfies Pick<SandboxLogReader, "events" | "getPrompt" | "followSettled"> &
      Pick<Provider, "id"> & {
        enrolledStatus: SandboxStatus | null;
        settled: boolean;
        setupFailure: string;
        verify: typeof current;
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
    if (sandbox.modalTransport !== "dialout") return resolveProvider(sandbox, caller);

    let observation: Promise<Provider> | undefined;
    let followed: Awaited<ReturnType<typeof jobReader>> = null;
    const observe = () => (observation ??= resolveProvider(sandbox, caller));
    return {
      events: (request) => followed?.events(request) ?? history(caller, sandbox.id, request),
      async followSettled(fenceEvents = true) {
        const job = await jobReader(sandbox, caller);
        if (fenceEvents) followed = job;
        return job?.settled;
      },
      get: async (...args) => (await observe()).get(...args),
      getPrompt: async (request) => (await observe()).getPrompt(request),
    };
  };
  return read;
}
