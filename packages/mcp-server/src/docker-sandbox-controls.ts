import { randomUUID } from "node:crypto";
import {
  type AgentEvent,
  DOCKER_IMAGE_UNAVAILABLE_MESSAGE,
  type DockerSandboxStatus,
  GoldenError,
  HARNESS_CAPABILITIES,
  HARNESS_KINDS,
  type Harness,
  idlePauseMessage,
  PROMPT_STATUSES,
  ProviderError,
  type SandboxRecord,
  type SandboxUsage,
  withUsageTotals,
} from "@armada/core";
import { decryptSecret, type Sql } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { createSqlData } from "./data.ts";
import type { createDockerBootstrapService } from "./docker-bootstrap-service.ts";
import { createDockerHostStore, DockerHostDenied } from "./docker-host-store.ts";
import { dockerHostSupportsResume } from "./docker-host-version.ts";
import { createDockerLaunchEnvironment } from "./docker-launch-environment.ts";
import type { createDockerNormalSend } from "./docker-normal-send.ts";
import { createDockerRuntimeLifecycle } from "./docker-runtime-lifecycle.ts";
import { isPrivateModelEvent } from "./model-usage.ts";
import { createRuntimeAgent } from "./runtime-agent.ts";
import { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import type { RuntimeGitHub } from "./runtime-github.ts";
import { createRuntimeHistory } from "./runtime-history.ts";
import type { RuntimeMcp } from "./runtime-mcp.ts";
import { withServerCost } from "./turn-pricing.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Row = {
  id: string;
  org_id: string;
  owner_id: string;
  role: string;
  provider: string;
  docker_host_id: string;
  docker_image: string;
  docker_snapshot_id: string | null;
  harness: Harness;
  status: SandboxRecord["status"];
  status_reason: string | null;
  stopped_at: string | Date | null;
  model: string | null;
  reasoning_effort: string | null;
  conversation_ids: string[];
  expires_at: string | Date | null;
  usage_turns: unknown;
  prompt_sequence: string;
  journal_sequence: string;
};
interface Clock {
  now(): number;
  wait(ms: number): Promise<void>;
}
const realClock: Clock = { now: Date.now, wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
function failure(code: "not_found" | "invalid_request" | "conflict" | "unavailable", message: string) {
  return new ProviderError({ provider: "docker", code, message, retryable: code === "unavailable" });
}
const denied = () => failure("not_found", "Sandbox not found.");
const invalid = () => failure("invalid_request", "Invalid Docker sandbox request.");
const terminal = (row: Row) => ["stopped", "deleted", "failed"].includes(row.status);
function reason(row: Row) {
  if (row.status_reason === "expired") return "expired";
  if (row.status_reason === "idle_paused" && ["stopping", "stopped"].includes(row.status)) return "idle_paused";
  if (row.status !== "failed") return null;
  return row.status_reason === DOCKER_IMAGE_UNAVAILABLE_MESSAGE ? row.status_reason : "Docker sandbox failed.";
}
function usage(value: unknown): SandboxUsage | null {
  if (!value || typeof value !== "object" || !("turnCount" in value) || !("turns" in value)) return null;
  const { turnCount, turns } = value;
  if (!Number.isSafeInteger(turnCount) || (turnCount as number) < 0 || !Array.isArray(turns)) return null;
  if (
    !turns.every(
      (turn) =>
        turn &&
        typeof turn === "object" &&
        typeof turn.promptId === "string" &&
        (typeof turn.model === "string" || turn.model === null) &&
        ["inputTokens", "outputTokens", "cachedTokens"].every(
          (field) => turn[field] === null || (Number.isSafeInteger(turn[field]) && turn[field] >= 0),
        ),
    )
  )
    return null;
  return withUsageTotals({ computeSeconds: null, turnCount: turnCount as number, turns });
}

/** Retained reads and bound host cleanup only: never opens a model or provider connection. */
export function createDockerSandboxControls(
  sql: Sql,
  key: string,
  options: {
    github?: Pick<RuntimeGitHub, "prepare" | "prepareTurn">;
    clock?: Clock;
    timeoutMs?: number;
    prepareMcp?: RuntimeMcp["prepare"];
    prepareSnapshotGitHub?: RuntimeGitHub["prepareLaunch"];
    send?: ReturnType<typeof createDockerNormalSend>;
    resume?: Pick<ReturnType<typeof createDockerBootstrapService>, "resume">;
  } = {},
) {
  const clock = options.clock ?? realClock;
  async function visible(caller: Caller, id: string): Promise<Row> {
    if (!UUID.test(id) || !UUID.test(caller.userId) || caller.orgs.some((org) => !UUID.test(org.orgId))) throw denied();
    const row = (
      await sql.query<Row>(
        `select s.id,s.org_id,s.owner_id,s.provider,s.docker_host_id,s.docker_image,s.docker_snapshot_id,s.harness,s.status,s.status_reason,
        s.stopped_at,s.model,s.reasoning_effort,s.conversation_ids,s.expires_at,s.usage_turns,m.role,
       (select coalesce(max(c.sequence),0)::text from public.runtime_commands c where c.sandbox_id=s.id and starts_with(c.request_id,'docker_prompt_')) as prompt_sequence,
       (select coalesce(max(e.sequence),0)::text from public.runtime_events e where e.sandbox_id=s.id) as journal_sequence
       from public.sandboxes s join public.members m on m.org_id=s.org_id and m.user_id=$2
       where s.id=$1 and s.org_id=any($3::uuid[])`,
        [id, caller.userId, caller.orgs.map((org) => org.orgId)],
      )
    ).rows[0];
    if (!row || (row.provider === "docker" && row.owner_id !== caller.userId && row.role !== "admin")) throw denied();
    return row;
  }
  const history = createRuntimeHistory(sql, key, {
    provider: "docker",
    async authorize(caller, id) {
      const row = await visible(caller, id);
      if (row.provider !== "docker") throw denied();
      return { status: row.status, statusReason: reason(row) };
    },
  });
  async function admission(sandboxId: string) {
    const commands = (
      await sql.query<{
        sequence: string;
        request_id: string;
        epoch: string;
        result_enc: Uint8Array<ArrayBuffer> | null;
      }>(
        `select sequence::text,request_id,epoch::text,result_enc from public.runtime_commands
       where sandbox_id=$1 and starts_with(request_id,'docker_prompt_') order by runtime_commands.sequence desc limit 100`,
        [sandboxId],
      )
    ).rows;
    const sequence = commands[0]?.sequence ?? "0";
    const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
    for (const command of commands) {
      if (!command.result_enc) return { sequence, known: false };
      const reply: unknown = JSON.parse(await decryptSecret(command.result_enc, key));
      if (
        !object(reply) ||
        reply.epoch !== command.epoch ||
        reply.requestId !== command.request_id ||
        !object(reply.body) ||
        reply.body.version !== 1 ||
        reply.body.requestId !== command.request_id
      )
        return { sequence, known: false };
      if (
        (reply.status === 400 || reply.status === 409) &&
        ["conversation_busy", "invalid_request"].includes(reply.body.error as string)
      )
        continue;
      const receipt = reply.body.result;
      if (
        reply.status !== 200 ||
        Object.hasOwn(reply.body, "error") ||
        !object(receipt) ||
        typeof receipt.promptId !== "string" ||
        !UUID.test(receipt.promptId) ||
        typeof receipt.conversationId !== "string" ||
        !UUID.test(receipt.conversationId) ||
        !PROMPT_STATUSES.some((status) => status === receipt.status)
      )
        return { sequence, known: false };
      return {
        sequence,
        known: true,
        receipt: {
          promptId: receipt.promptId,
          conversationId: receipt.conversationId,
          status: receipt.status as (typeof PROMPT_STATUSES)[number],
        },
      };
    }
    return { sequence, known: commands.length < 100 };
  }
  async function status(caller: Caller, initial: Row, promptId?: string): Promise<DockerSandboxStatus> {
    const admitted = await admission(initial.id);
    const selectedPrompt = promptId ?? admitted.receipt?.promptId;
    let cursor: string | undefined;
    const events: AgentEvent[] = [];
    let complete = false;
    let newestCursor: string | undefined;
    for (let count = 0; count < 100; count++) {
      const page = await history(caller, initial.id, {
        direction: "backward",
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      if (count === 0) newestCursor = page.cursor;
      events.unshift(...page.events);
      if (
        !page.hasMore ||
        page.events.some((event) => event.kind === "prompt" && (!selectedPrompt || event.promptId === selectedPrompt))
      ) {
        complete = true;
        break;
      }
      if (!page.olderCursor || page.olderCursor === cursor) break;
      cursor = page.olderCursor;
    }
    const row = await visible(caller, initial.id);
    const conversations = new Set(row.conversation_ids ?? []);
    for (const event of events) if (event.conversationId) conversations.add(event.conversationId);
    if (admitted.receipt) conversations.add(admitted.receipt.conversationId);
    const event = events.findLast(
      (event) => event.kind === "prompt" && (!selectedPrompt || event.promptId === selectedPrompt),
    );
    let prompt: DockerSandboxStatus["prompt"] = null;
    if (event?.kind === "prompt" && event.promptId) {
      let state: NonNullable<DockerSandboxStatus["prompt"]>["state"] =
        event.status === "queued" || event.status === "running" ? "running" : event.status;
      if (state === "running" && terminal(row)) state = row.status === "failed" ? "failed" : "interrupted";
      prompt = {
        promptId: event.promptId,
        conversationId: event.conversationId ?? null,
        state,
        reason: state === "failed" ? "The agent failed." : null,
      };
    }
    if (!prompt && admitted.receipt && (!promptId || promptId === admitted.receipt.promptId)) {
      const state = terminal(row) ? (row.status === "failed" ? "failed" : "interrupted") : "running";
      prompt = {
        promptId: admitted.receipt.promptId,
        conversationId: admitted.receipt.conversationId,
        state,
        reason: state === "failed" ? "The agent failed." : null,
      };
    }
    if (promptId && !prompt)
      throw failure(complete ? "not_found" : "unavailable", "Docker prompt history is unavailable.");
    // An explicit historical turn does not make a newer, still-running turn idle.
    const latest = events.findLast((event) => event.kind === "prompt");
    const idle = latest?.kind === "prompt" ? !["queued", "running"].includes(latest.status) : row.status === "ready";
    return {
      provider: "docker",
      hostId: row.docker_host_id,
      image: row.docker_image,
      id: row.id,
      golden: null,
      visibility: "private",
      harness: row.harness,
      repositoryDir: null,
      machineSize: null,
      model: row.model,
      reasoningEffort: row.reasoning_effort,
      status: row.status,
      statusReason: reason(row),
      statusMessage: idlePauseMessage(
        {
          status: row.status,
          statusReason: reason(row),
          expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
        },
        new Date(clock.now()),
      ),
      providerState:
        row.status === "deleted"
          ? null
          : row.stopped_at !== null
            ? "stopped"
            : ["ready", "running"].includes(row.status)
              ? "running"
              : null,
      conversationIds: [...conversations],
      expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
      usage: withServerCost(usage(row.usage_turns), row.harness),
      prompt,
      settled:
        terminal(row) ||
        (complete &&
          idle &&
          admitted.known &&
          admitted.sequence === row.prompt_sequence &&
          (!admitted.receipt || latest?.promptId === admitted.receipt.promptId) &&
          (newestCursor ?? `ar1_${row.id}_0`) === `ar1_${row.id}_${row.journal_sequence}`),
    };
  }
  async function logs(caller: Caller, row: Row, args: Record<string, unknown>) {
    if (
      (args.direction !== undefined && !["forward", "backward"].includes(args.direction as string)) ||
      (args.all !== undefined && typeof args.all !== "boolean") ||
      (args.limit !== undefined &&
        (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 500)) ||
      (args.coalesce !== undefined && typeof args.coalesce !== "boolean") ||
      (args.direction === "backward" && args.all) ||
      (args.since_cursor !== undefined && typeof args.since_cursor !== "string") ||
      (args.conversation_id !== undefined && (typeof args.conversation_id !== "string" || !args.conversation_id))
    )
      throw invalid();
    let cursor = args.since_cursor as string | undefined;
    let olderCursor: string | undefined;
    let hasMore = false;
    const events = new Map<string, AgentEvent>();
    for (let count = 0; count < (args.all ? 100 : 1); count++) {
      const page = await history(caller, row.id, {
        ...(cursor !== undefined ? { cursor } : {}),
        ...(args.conversation_id !== undefined ? { conversationId: args.conversation_id as string } : {}),
        ...(args.limit !== undefined ? { limit: args.limit as number } : {}),
        ...(args.direction !== undefined ? { direction: args.direction as "forward" | "backward" } : {}),
        ...(args.maxBytes !== undefined ? { maxBytes: args.maxBytes as number } : {}),
        ...(args.coalesce !== undefined ? { coalesce: args.coalesce as boolean } : {}),
      });
      for (const event of page.events) if (!isPrivateModelEvent(event)) events.set(event.id, event);
      olderCursor = page.olderCursor;
      hasMore = page.hasMore;
      const next = page.cursor ?? cursor;
      if (!hasMore || !next || next === cursor) {
        cursor = next;
        break;
      }
      cursor = next;
    }
    const summary = await status(caller, row);
    return {
      events: [...events.values()],
      cursor: cursor ?? null,
      ...(olderCursor ? { olderCursor } : {}),
      hasMore,
      source: "armada-runtime",
      settled: summary.settled,
      ...(summary.status === "failed"
        ? { runtimeFailure: { status: "failed" as const, reason: summary.statusReason ?? "Docker sandbox failed." } }
        : {}),
    };
  }
  async function assertDelete(caller: Caller, id: string, target: Sql = sql) {
    const store = createSqlData(target)(caller).sandboxes;
    if (!store.assertDeletionAllowed) throw failure("unavailable", "Docker sandbox deletion is unavailable.");
    try {
      await store.assertDeletionAllowed(id);
    } catch (error) {
      if (error instanceof GoldenError)
        throw failure(error.code === "conflict" ? "conflict" : "not_found", error.message);
      throw error;
    }
  }
  async function cleanup(caller: Caller, row: Row, operation: "stop" | "delete", requestId?: string) {
    if (requestId !== undefined && !UUID.test(requestId)) throw invalid();
    if (operation === "delete") await assertDelete(caller, row.id);
    const done = (current: Row) =>
      operation === "delete"
        ? current.status === "deleted"
        : current.status === "deleted" ||
          (["stopped", "failed"].includes(current.status) && current.stopped_at !== null);
    const result = (current: Row) => ({ id: current.id, status: current.status });
    if (done(row)) return result(row);
    if (operation === "delete" && !["stopped", "failed"].includes(row.status))
      throw failure("conflict", "Stop the Docker sandbox before deleting it.");
    // Serialize selection with existing store admission. Reuse unknown pending
    // intent; a new caller request may retry a known failure. Never wait under SQL locks.
    if (!sql.transaction) throw failure("unavailable", "Docker sandbox cleanup is unavailable.");
    const selected = await sql.transaction(async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [`docker-cleanup:${row.id}:${operation}`]);
      const pending = (
        await tx.query<{ request_id: string; bound_actor_id: string }>(
          `select request_id,bound_actor_id from public.docker_host_jobs where bound_sandbox_id=$1 and bound_operation=$2
         and outcome is null order by position limit 1`,
          [row.id, operation],
        )
      ).rows[0];
      if (
        pending &&
        (pending.bound_actor_id !== caller.userId || (requestId !== undefined && requestId !== pending.request_id))
      )
        throw failure("conflict", "Docker sandbox cleanup is pending. Retry the same request.");
      const id = requestId ?? pending?.request_id ?? randomUUID();
      const scoped: Sql = { query: tx.query.bind(tx), transaction: (work) => work(tx) };
      if (operation === "delete") await assertDelete(caller, row.id, scoped);
      await createDockerHostStore(scoped, key).enqueueSandbox({ userId: caller.userId, orgId: row.org_id }, row.id, {
        requestId: id,
        operation,
      });
      return id;
    });
    const deadline = clock.now() + (options.timeoutMs ?? 45_000);
    for (;;) {
      const current = await visible(caller, row.id);
      const job = (
        await sql.query<{ outcome: string | null }>(
          `select outcome from public.docker_host_jobs where request_id=$1 and bound_sandbox_id=$2 and bound_operation=$3`,
          [selected, row.id, operation],
        )
      ).rows[0];
      if (job?.outcome === "completed" && done(current)) return result(current);
      if (job?.outcome === "failed")
        throw failure("conflict", "Docker sandbox cleanup failed. Use a new request_id to retry.");
      if (clock.now() >= deadline)
        throw failure("conflict", "Docker sandbox cleanup is pending. Retry the same request.");
      await clock.wait(Math.min(250, deadline - clock.now()));
    }
  }
  async function resume(caller: Caller, row: Row, requestId?: string) {
    if (!options.resume) throw failure("unavailable", "Docker sandbox resume is unavailable.");
    if (row.owner_id !== caller.userId) throw denied();
    if (!requestId) throw invalid();
    const host = (
      await sql.query<{ daemon_version: string | null }>(
        "select daemon_version from public.docker_hosts where id=$1 and org_id=$2",
        [row.docker_host_id, row.org_id],
      )
    ).rows[0];
    if (!dockerHostSupportsResume(host?.daemon_version))
      throw failure(
        "conflict",
        "Update this Docker host daemon to Armada 2.28.0 or later before resuming. Keep its existing registration, then retry. No resume job was sent.",
      );
    const actor = { userId: caller.userId, orgId: row.org_id };
    await options.resume.resume(actor, row.id, requestId);
    const deadline = clock.now() + (options.timeoutMs ?? 45_000);
    const runtime = createDockerRuntimeLifecycle(sql, key, { enabled: true });
    for (;;) {
      // Host ACK is not runtime readiness.
      const state = (
        await sql.query<{ outcome: string | null }>(
          `select outcome from public.docker_host_jobs where request_id=$1 and bound_sandbox_id=$2 and bound_operation='resume'`,
          [requestId, row.id],
        )
      ).rows[0];
      if (state?.outcome === "failed") throw failure("conflict", "Docker resume failed.");
      if (state?.outcome === "completed") {
        const ready = await runtime.ready(actor, row.id, requestId);
        if (ready.state === "ready") {
          await createDockerLaunchEnvironment(sql, key, clock)(caller, row.id);
          await options.github?.prepareTurn(caller, row.id);
          if (row.docker_snapshot_id) await options.prepareSnapshotGitHub?.(caller, row.id);
          await options.prepareMcp?.(caller, row.id);
          return { id: row.id, status: "ready" as const };
        }
      }
      if (clock.now() >= deadline) throw failure("conflict", "Docker resume is pending. Retry the same request_id.");
      await clock.wait(Math.min(250, deadline - clock.now()));
    }
  }
  async function control(caller: Caller, row: Row, name: string, args: Record<string, unknown>) {
    if (row.owner_id !== caller.userId) throw denied();
    if (!["ready", "running"].includes(row.status)) throw failure("conflict", "Docker sandbox must be running.");
    const requestId = (args.request_id as string | undefined) ?? randomUUID();
    if (
      args.conversation_id !== undefined &&
      (typeof args.conversation_id !== "string" || !UUID.test(args.conversation_id))
    )
      throw invalid();
    let conversationId = (args.conversation_id as string | undefined) ?? row.conversation_ids.at(-1);
    if (name === "steer" && args.conversation_id === undefined) {
      const previous = (
        await sql.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
          "select request_enc from public.runtime_commands where sandbox_id=$1 and request_id=$2",
          [row.id, requestId],
        )
      ).rows[0];
      if (previous) {
        const saved = JSON.parse(await decryptSecret(previous.request_enc, key)) as {
          op?: unknown;
          conversationId?: unknown;
        };
        if (saved.op === "steer" && typeof saved.conversationId === "string") conversationId = saved.conversationId;
      }
    }
    if (conversationId && !row.conversation_ids.includes(conversationId))
      throw failure("not_found", "Conversation not found.");
    const authority = createRuntimeEnrolments(sql, key);
    const fenced = {
      ...authority,
      withOwner: ((id, owner, work, generation) => {
        if (!sql.transaction) throw failure("unavailable", "Docker runtime authorization is unavailable.");
        return sql.transaction(async (tx) => {
          const local: Sql = { query: tx.query.bind(tx), transaction: (work) => work(tx) };
          const current = createRuntimeEnrolments(local, key);
          await current.lockSourceMembers(tx, id, owner);
          const allowed = await tx.query(
            `select s.id from public.sandboxes s join public.credentials c on c.id=s.credential_id and c.version=s.credential_version
             where s.id=$1 and c.kind=any($4::public.credential_kind[]) and c.status='active' and (c.expires_at is null or c.expires_at>now())
             and ((c.scope='user' and c.owner_id=$2) or (c.scope='org' and c.owner_id=$3)) for share of c`,
            [id, owner, row.org_id, HARNESS_KINDS[row.harness]],
          );
          if (!allowed.rows.length) throw failure("conflict", "Docker runtime authorization is unavailable.");
          return current.withOwner(
            id,
            owner,
            async (fenced, scope) => {
              if (name === "exec") {
                const safe = await fenced.query(
                  `select id from public.sandboxes where id=$1 and application_secret_tainted=false`,
                  [id],
                );
                if (!safe.rows.length) throw failure("conflict", "Docker runtime execution is unavailable.");
              }
              return work(fenced, scope);
            },
            generation,
          );
        });
      }) as typeof authority.withOwner,
    };
    const agent = createRuntimeAgent(
      createRuntimeCommands(fenced, key, {
        now: clock.now,
        wait: (ms) => clock.wait(ms),
      }),
      {
        provider: "docker",
        harness: row.harness,
        ownerId: caller.userId,
        sandboxId: row.id,
        providerSandboxId: row.id,
        cwd: "/home/user",
        defaults: { model: row.model ?? "", reasoningEffort: row.reasoning_effort ?? "" },
      },
    );
    if (name === "interrupt") {
      await agent.interrupt(
        { sandboxId: row.id, ...(args.conversation_id ? { conversationId: args.conversation_id as string } : {}) },
        requestId,
      );
      return { id: row.id, interrupted: true };
    }
    if (name === "steer") {
      if (typeof args.text !== "string" || !args.text.trim() || !conversationId) throw invalid();
      const receipt = await agent.steer({ sandboxId: row.id, text: args.text, conversationId }, requestId);
      return { id: row.id, ...receipt, delivery: HARNESS_CAPABILITIES[row.harness].steer, mode: receipt.mode ?? null };
    }
    if (
      typeof args.command !== "string" ||
      !args.command.trim() ||
      (args.cwd !== undefined && (typeof args.cwd !== "string" || !args.cwd || args.cwd.includes("\0"))) ||
      (args.timeout_seconds !== undefined && typeof args.timeout_seconds !== "number")
    )
      throw invalid();
    const result = await agent.exec(
      {
        sandboxId: row.id,
        command: args.command,
        ...(args.cwd === undefined ? {} : { cwd: args.cwd as string }),
        ...(args.timeout_seconds === undefined ? {} : { timeoutSeconds: args.timeout_seconds as number }),
      },
      requestId,
    );
    if (result.detached) throw failure("conflict", "Runtime command outcome is unknown. Retry the same request_id.");
    return {
      id: row.id,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      truncated: result.truncated,
    };
  }
  return {
    async invoke(
      caller: Caller,
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ handled: false } | { handled: true; result: object }> {
      if (
        ![
          "status",
          "logs",
          "stop",
          "delete",
          "send",
          "resume",
          "steer",
          "interrupt",
          "exec",
          "github_refresh",
        ].includes(name)
      )
        return { handled: false };
      try {
        if (typeof args.id !== "string" || !UUID.test(args.id)) throw denied();
        if (
          args.prompt_id !== undefined &&
          (typeof args.prompt_id !== "string" || !args.prompt_id || args.prompt_id.length > 256)
        )
          throw invalid();
        if (args.request_id !== undefined && (typeof args.request_id !== "string" || !UUID.test(args.request_id)))
          throw invalid();
        const row = await visible(caller, args.id);
        if (row.provider !== "docker") return { handled: false };
        if (name === "github_refresh") {
          if (!options.github) throw failure("unavailable", "Docker GitHub refresh is unavailable.");
          return { handled: true, result: await options.github.prepare(caller, row.id) };
        }
        if (["steer", "interrupt", "exec"].includes(name))
          return { handled: true, result: await control(caller, row, name, args) };
        if (name === "send") {
          if (!options.send) throw failure("unavailable", "Docker send is unavailable.");
          return {
            handled: true,
            result: await options.send.send(caller, args, row, async () => {
              await resume(caller, row, args.request_id as string | undefined);
              return visible(caller, row.id);
            }),
          };
        }
        if (name === "resume")
          return { handled: true, result: await resume(caller, row, args.request_id as string | undefined) };
        const result =
          name === "status"
            ? await status(caller, row, args.prompt_id as string | undefined)
            : name === "logs"
              ? await logs(caller, row, args)
              : await cleanup(caller, row, name as "stop" | "delete", args.request_id as string | undefined);
        return { handled: true, result };
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (error instanceof DockerHostDenied) throw failure("conflict", "Docker sandbox cleanup is unavailable.");
        throw failure("unavailable", "Docker sandbox operation is unavailable.");
      }
    },
  };
}

export type DockerSandboxControls = ReturnType<typeof createDockerSandboxControls>;
