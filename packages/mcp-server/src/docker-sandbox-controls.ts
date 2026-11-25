import { randomUUID } from "node:crypto";
import {
  type AgentEvent,
  DOCKER_LAUNCH_FAILURE_MESSAGES,
  DockerRetentionEnded,
  type DockerSandboxStatus,
  dockerSandboxFailureReason,
  dockerWorkspaceReclaimedMessage,
  GoldenError,
  HARNESS_CAPABILITIES,
  HARNESS_KINDS,
  type Harness,
  idlePauseMessage,
  PROMPT_STATUSES,
  ProviderError,
  planLimitData,
  planLimitFromMessage,
  planLimitMessage,
  promptFailureReason,
  type SandboxRecord,
  type SandboxUsage,
  type TaskOutcome,
  withUsageTotals,
} from "@armada/core";
import { readLogsOperation } from "@armada/core/contract";
import { decryptSecret, type Sql, VaultError } from "@armada/core/server";
import { z } from "zod";
import type { Caller } from "./caller.ts";
import { createSqlData } from "./data.ts";
import { createDockerHostStore, DockerHostDenied } from "./docker-host-store.ts";
import { DockerHostUpgradeRequired } from "./docker-host-version.ts";
import { createDockerLaunchEnvironment } from "./docker-launch-environment.ts";
import { isDockerPromptRefusal } from "./docker-prompt-refusal.ts";
import { createDockerRuntimeLifecycle } from "./docker-runtime-lifecycle.ts";
import { createDockerSandboxService } from "./docker-sandbox-service.ts";
import { readEventPages } from "./event-pagination.ts";
import type { createResumeJob } from "./jobs/resume.ts";
import { isPrivateModelEvent } from "./model-usage.ts";
import { usesHostLaunch } from "./provider-runtime-admission.ts";
import { observeProviderCall } from "./request-observability.ts";
import { createRuntimeAgent } from "./runtime-agent.ts";
import { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments, scopedRuntimeSql } from "./runtime-enrolment.ts";
import type { RuntimeGitHub } from "./runtime-github.ts";
import { createRuntimeHistory } from "./runtime-history.ts";
import type { RuntimeMcp } from "./runtime-mcp.ts";
import type { RuntimeTurnClaim } from "./runtime-resume.ts";
import { publicSandboxStatusSql } from "./sandbox-readiness.ts";
import { ResumeTurnDeferred } from "./tool-error.ts";
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
  external_ref: string | null;
  skills: SandboxRecord["skills"];
  pull_requests: NonNullable<SandboxRecord["pullRequests"]>;
  stopped_at: string | Date | null;
  model: string | null;
  reasoning_effort: string | null;
  conversation_ids: string[];
  expires_at: string | Date | null;
  usage_turns: unknown;
  prompt_sequence: string;
  task_prompt_id: string | null;
  lifecycle_generation: number | string;
  journal_sequence: string;
  prompt_projection_sequence: string | null;
  latest_prompt_enc: Uint8Array<ArrayBuffer> | null;
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
const dockerLogsInput = readLogsOperation.input.body.pick({ direction: true, all: true, coalesce: true }).extend({
  limit: z.number().int().min(1).max(500).optional(),
  since_cursor: z.string().optional(),
});

const invalid = () => failure("invalid_request", "Invalid Docker sandbox request.");
const terminal = (row: Row) => ["stopped", "deleted", "failed"].includes(row.status);
/** Controls that reach the Docker host (jobs, launch-time runtime admission) beyond the runtime command boundary. */
const DOCKER_HOST_CONTROLS = new Set(["send", "resume", "stop", "delete"]);
function reason(row: Row) {
  if (row.status === "deleted" && dockerWorkspaceReclaimedMessage(row.status_reason)) return row.status_reason;
  if (row.status_reason === "expired") return "expired";
  if (
    ["idle_paused", "agent_finished", "work_merged"].includes(row.status_reason ?? "") &&
    ["stopping", "stopped"].includes(row.status)
  )
    return row.status_reason;
  if (row.status !== "failed") return null;
  return dockerSandboxFailureReason(row.status_reason);
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
    sendEnabled?: boolean;
    resume?: ReturnType<typeof createResumeJob>["resumeDocker"];
    wakeResume?: ReturnType<typeof createResumeJob>["wake"];
  } = {},
) {
  const clock = options.clock ?? realClock;
  async function visible(caller: Caller, id: string): Promise<Row> {
    if (!UUID.test(id) || !UUID.test(caller.userId) || caller.orgs.some((org) => !UUID.test(org.orgId))) throw denied();
    const row = (
      await sql.query<Row>(
        `select s.id,s.org_id,s.owner_id,s.provider,s.docker_host_id,s.docker_image,s.docker_snapshot_id,s.harness,
        ${publicSandboxStatusSql} as status,
        s.status_reason,s.external_ref,s.skills,s.pull_requests,s.task_prompt_id,s.lifecycle_generation,
        s.stopped_at,s.model,s.reasoning_effort,s.conversation_ids,s.expires_at,s.usage_turns,m.role,e.prompt_projection_sequence::text,e.latest_prompt_enc,
       (select coalesce(max(c.sequence),0)::text from public.runtime_commands c where c.sandbox_id=s.id and starts_with(c.request_id,'docker_prompt_')) as prompt_sequence,
       (select coalesce(max(e.sequence),0)::text from public.runtime_events e where e.sandbox_id=s.id) as journal_sequence
       from public.sandboxes s join public.members m on m.org_id=s.org_id and m.user_id=$2
       left join public.runtime_idle_evidence e on e.sandbox_id=s.id
       where s.id=$1 and s.org_id=any($3::uuid[])`,
        [id, caller.userId, caller.orgs.map((org) => org.orgId)],
      )
    ).rows[0];
    if (!row || (usesHostLaunch(row.provider) && row.owner_id !== caller.userId && row.role !== "admin"))
      throw denied();
    return row;
  }
  async function nativeHistory(
    caller: Caller,
    id: string,
    request: Parameters<ReturnType<typeof createRuntimeHistory>>[2],
    initial?: Row,
  ) {
    let authorized = initial;
    return createRuntimeHistory(sql, key, {
      provider: "docker",
      async authorize(viewer, sandboxId) {
        // invoke already authorized this snapshot. The history reader still
        // revalidates membership after decryption before returning the page.
        const row = authorized ?? (await visible(viewer, sandboxId));
        authorized = undefined;
        if (!usesHostLaunch(row.provider)) throw denied();
        return { status: row.status, statusReason: reason(row) };
      },
    })(caller, id, request);
  }
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
        !object(reply.body)
      )
        return { sequence, known: false };
      if (isDockerPromptRefusal(reply.status, reply.body, command.request_id)) continue;
      const receipt = reply.body.result;
      if (
        reply.status !== 200 ||
        reply.body.version !== 1 ||
        reply.body.requestId !== command.request_id ||
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
  async function status(
    caller: Caller,
    initial: Row,
    promptId?: string,
    includeRepository = true,
  ): Promise<DockerSandboxStatus> {
    const admitted = await admission(initial.id);
    const selectedPrompt = promptId ?? admitted.receipt?.promptId;
    // Latest status uses ingest's durable projection. Missing/stale evidence is
    // reported explicitly; reads never rebuild it by decrypting output history.
    const events: AgentEvent[] = [];
    let newestCursor: string | undefined;
    let cursor: string | undefined;
    let complete = false;
    // Explicit historical lookups retain archive search semantics.
    const historical = promptId && selectedPrompt !== admitted.receipt?.promptId;
    const pageBudget = historical ? 100 : 0;
    if (!historical) {
      complete = initial.prompt_projection_sequence === initial.journal_sequence || initial.journal_sequence === "0";
      newestCursor = `ar1_${initial.id}_${initial.prompt_projection_sequence ?? "0"}`;
      if (initial.latest_prompt_enc) {
        const projected = JSON.parse(await decryptSecret(initial.latest_prompt_enc, key)) as AgentEvent;
        events.push(projected);
      }
    }
    for (let count = 0; count < pageBudget; count++) {
      const page = await nativeHistory(caller, initial.id, {
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
    if (!historical && newestCursor !== `ar1_${row.id}_${row.journal_sequence}`) complete = false;
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
      const limit =
        event.reason?.split(":")[0] === "authentication_failed"
          ? undefined
          : (planLimitData(event.limit) ?? planLimitFromMessage(event.reason));
      prompt = {
        promptId: event.promptId,
        conversationId: event.conversationId ?? null,
        state,
        reason: state === "failed" ? (limit ? planLimitMessage(limit) : promptFailureReason(event.reason)) : null,
      };
    }
    if (!prompt && admitted.receipt && (!promptId || selectedPrompt === admitted.receipt.promptId)) {
      const state = terminal(row) ? (row.status === "failed" ? "failed" : "interrupted") : "running";
      prompt = {
        promptId: admitted.receipt.promptId,
        conversationId: admitted.receipt.conversationId,
        state,
        reason: state === "failed" ? promptFailureReason() : null,
      };
    }
    if (promptId && !prompt)
      throw failure(complete ? "not_found" : "unavailable", "Docker prompt history is unavailable.");
    // An explicit historical turn does not make a newer, still-running turn idle.
    const latest = events.findLast((event) => event.kind === "prompt");
    const idle = latest?.kind === "prompt" ? !["queued", "running"].includes(latest.status) : row.status === "ready";
    const nativeSettled =
      terminal(row) ||
      (complete &&
        idle &&
        admitted.known &&
        admitted.sequence === row.prompt_sequence &&
        (!admitted.receipt || latest?.promptId === admitted.receipt.promptId) &&
        (newestCursor ?? `ar1_${row.id}_0`) === `ar1_${row.id}_${row.journal_sequence}`);
    const launch = includeRepository
      ? (
          await sql.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
            "select request_enc from public.docker_launch_manifests where sandbox_id=$1",
            [row.id],
          )
        ).rows[0]
      : undefined;
    const manifest = launch ? JSON.parse(await decryptSecret(launch.request_enc, key)) : null;
    const repositoryDir = (manifest?.request?.repos ?? manifest?.snapshotConfig?.repos)?.[0]?.dir ?? null;
    return {
      provider: "docker",
      hostId: row.docker_host_id,
      image: row.docker_image,
      ...(row.docker_snapshot_id ? { snapshotId: row.docker_snapshot_id } : {}),
      id: row.id,
      golden: null,
      visibility: "private",
      ...(row.external_ref ? { externalRef: row.external_ref } : {}),
      harness: row.harness,
      repositoryDir,
      machineSize: null,
      model: row.model,
      reasoningEffort: row.reasoning_effort,
      status: row.status,
      statusReason: reason(row),
      pullRequests: row.pull_requests ?? [],
      skills: row.skills ?? [],
      statusMessage:
        dockerWorkspaceReclaimedMessage(row.status_reason) ??
        idlePauseMessage(
          {
            status: row.status,
            statusReason: reason(row),
            expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
          },
          new Date(clock.now()),
        ) ??
        (!complete ? "Stored prompt state is incomplete; live data may be stale." : null),
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
      settled: nativeSettled,
    };
  }
  async function logs(caller: Caller, row: Row, args: Record<string, unknown>) {
    const parsed = dockerLogsInput.safeParse(args);
    if (!parsed.success || (parsed.data.direction === "backward" && parsed.data.all)) throw invalid();
    const { direction, all, coalesce, limit, since_cursor } = parsed.data;
    const {
      events: rawEvents,
      cursor,
      hasMore,
      olderCursor,
    } = await readEventPages(
      (cursor) =>
        nativeHistory(
          caller,
          row.id,
          {
            ...(cursor !== undefined ? { cursor } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(direction !== undefined ? { direction } : {}),
            ...(args.maxBytes !== undefined ? { maxBytes: args.maxBytes as number } : {}),
            ...(coalesce !== undefined ? { coalesce } : {}),
          },
          row,
        ),
      since_cursor,
      all === true,
    );
    const events = new Map<string, AgentEvent>();
    for (const event of rawEvents) if (!isPrivateModelEvent(event)) events.set(event.id, event);
    // Log metadata does not expose repositoryDir; avoid loading/decrypting its launch manifest.
    const summary = await status(caller, row, undefined, false);
    return {
      events: [...events.values()],
      cursor,
      ...(olderCursor ? { olderCursor } : {}),
      hasMore,
      source: "armada-runtime",
      threadStatus: {
        status: summary.status,
        statusMessage: summary.statusMessage,
        prompt: summary.prompt,
        usage: summary.usage,
      },
      settled: summary.settled,
      ...(summary.status === "failed"
        ? {
            runtimeFailure: {
              status: "failed" as const,
              reason: summary.statusReason ?? DOCKER_LAUNCH_FAILURE_MESSAGES.startup,
            },
          }
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
  async function cleanup(
    caller: Caller,
    row: Row,
    operation: "stop" | "delete",
    requestId?: string,
    onlyIfIdle = false,
  ) {
    const result = (current: Row) => ({ id: current.id, status: current.status });
    const actor = { userId: caller.userId, orgId: row.org_id };
    const hosts = createDockerHostStore(sql, key);
    const stop = operation === "stop";
    if (!stop) await assertDelete(caller, row.id);
    if (stop && onlyIfIdle && row.status === "ready" && !(await status(caller, row)).settled)
      throw failure("conflict", "Wait for the current turn to finish before changing accounts.");
    const done = (current: Row) =>
      current.status === "deleted" ||
      (stop && ["stopped", "failed"].includes(current.status) && current.stopped_at !== null);
    if (done(row)) return result(row);
    if (!stop && !["stopped", "failed"].includes(row.status))
      throw failure("conflict", "Stop the Docker sandbox before deleting it.");
    if (!sql.transaction) throw failure("unavailable", "Docker sandbox cleanup is unavailable.");
    const selected = stop
      ? await hosts.enqueueStop(actor, row.id, requestId, onlyIfIdle ? { idleSequence: row.prompt_sequence } : {})
      : (
          await hosts.enqueueCleanup(actor, row.id, { requestId, operation: "delete" }, (tx) =>
            assertDelete(caller, row.id, scopedRuntimeSql(tx)),
          )
        ).requestId;
    if (!selected) return result(await visible(caller, row.id));
    const deadline = clock.now() + (options.timeoutMs ?? 45_000);
    for (;;) {
      const {
        rows: [job],
      } = await sql.query<{ state: string }>(
        stop
          ? "select state::text from public.jobs where id=$1 and sandbox_id=$2 and kind='stop'"
          : "select outcome as state from public.docker_host_jobs where request_id=$1 and bound_sandbox_id=$2 and bound_operation='delete'",
        [selected, row.id],
      );
      const current = await visible(caller, row.id);
      if (done(current) && (stop || job?.state === "completed")) return result(current);
      if (job?.state === "failed" || job?.state === "done")
        throw failure("conflict", "Docker sandbox cleanup failed. Use a new request ID to retry.");
      if (clock.now() >= deadline)
        throw failure("conflict", "Docker sandbox cleanup is pending. Retry the same request.");
      await clock.wait(Math.min(250, deadline - clock.now()));
    }
  }
  async function control(caller: Caller, row: Row, name: string, args: Record<string, unknown>) {
    if (row.owner_id !== caller.userId) throw denied();
    if (!["ready", "running"].includes(row.status)) throw failure("conflict", "Docker sandbox must be running.");
    const requestId = (args.request_id as string | undefined) ?? randomUUID();
    let conversationId = row.conversation_ids.at(-1);
    if (name === "steer") {
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
          const current = createRuntimeEnrolments(scopedRuntimeSql(tx), key);
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
      await agent.interrupt({ sandboxId: row.id }, requestId);
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
  async function send(caller: Caller, row: Row, args: Record<string, unknown>, claim?: RuntimeTurnClaim) {
    const runtime = createDockerRuntimeLifecycle(sql, key);
    if (!options.sendEnabled) throw failure("unavailable", "Docker send is not enabled.");
    if (row.owner_id !== caller.userId) throw failure("conflict", "Only the Docker sandbox owner can send prompts.");
    if (typeof args.request_id !== "string" || typeof args.prompt !== "string") throw invalid();
    const { request_id: requestId, prompt } = args;
    const assertClaim =
      claim &&
      (async (tx?: Sql) => {
        if (!(await claim.canDispatch(tx))) throw failure("conflict", "Queued Docker turn lease is no longer current.");
      });
    await assertClaim?.();
    const deadline = clock.now() + (options.timeoutMs ?? 25_000);
    const previous = (
      await sql.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
        "select request_enc from public.runtime_commands where sandbox_id=$1 and request_id=$2",
        [row.id, `docker_prompt_${requestId}`],
      )
    ).rows[0];
    if (row.status === "stopped" && !previous && claim && options.wakeResume) {
      const sandbox = await createDockerSandboxService(sql).get({ userId: caller.userId, orgId: row.org_id }, row.id);
      return options.wakeResume(caller, sandbox, requestId, claim);
    }
    if (!["ready", "running"].includes(row.status))
      throw failure("conflict", "Docker sandbox must be running before send. Use a new request_id for a new turn.");
    await assertClaim?.();
    await options.prepareMcp?.(caller, row.id, undefined, assertClaim);
    let conversationId = row.conversation_ids.at(-1);
    if (conversationId === undefined && !previous) {
      const launch = (
        await sql.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
          "select request_enc from public.docker_launch_manifests where sandbox_id=$1",
          [row.id],
        )
      ).rows[0];
      if (launch) {
        const manifest = JSON.parse(await decryptSecret(launch.request_enc, key));
        conversationId = manifest.conversationId ?? manifest.promptId;
      }
    }
    if (previous) conversationId = JSON.parse(await decryptSecret(previous.request_enc, key)).input.conversationId;
    if (!previous) {
      await createDockerLaunchEnvironment(sql, key, clock)(caller, row.id, assertClaim);
      await options.github?.prepareTurn(caller, row.id, assertClaim);
      if (row.docker_snapshot_id) await options.prepareSnapshotGitHub?.(caller, row.id, assertClaim);
    }
    for (;;) {
      const result = await runtime
        .prompt(
          { userId: caller.userId, orgId: row.org_id },
          row.id,
          {
            requestId: requestId,
            text: prompt,
            ...(conversationId === undefined ? {} : { conversationId: conversationId as string }),
          },
          undefined,
          assertClaim,
        )
        .catch(() => {
          throw failure(
            "conflict",
            "Docker prompt admission unavailable. Retry identical input with the same request_id.",
          );
        });
      if (result.state === "admitted")
        return {
          id: row.id,
          requestId: requestId,
          runtime: { kind: "armada" as const, epoch: result.epoch },
          ...result.receipt,
        };
      if (clock.now() >= deadline)
        throw failure(
          "unavailable",
          "Docker prompt admission pending. Retry identical input with the same request_id.",
        );
      await clock.wait(Math.min(250, deadline - clock.now()));
    }
  }

  return {
    async invoke(
      caller: Caller,
      name: string,
      args: Record<string, unknown>,
      queued?: { claim?: RuntimeTurnClaim },
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
          "report",
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
        if (!usesHostLaunch(row.provider)) return { handled: false };
        const dispatch = async () => {
          if (name === "report") {
            if (!row.task_prompt_id || args.prompt_id !== row.task_prompt_id)
              throw failure("conflict", "Report only the latest finished turn, using its prompt id.");
            const summary = await status(caller, row, row.task_prompt_id, false);
            if (summary.prompt?.state !== "finished" || !summary.settled)
              throw failure("conflict", "Report only the latest finished turn, using its prompt id.");
            const outcome = args.outcome as TaskOutcome;
            await createSqlData(sql)(caller).sandboxes.reportTaskOutcome!(
              row.id,
              row.task_prompt_id,
              outcome,
              Number(row.lifecycle_generation),
            );
            return { handled: true as const, result: { id: row.id, taskOutcome: outcome } };
          }
          if (name === "github_refresh") {
            if (!options.github) throw failure("unavailable", "Docker GitHub refresh is unavailable.");
            return { handled: true as const, result: await options.github.prepare(caller, row.id) };
          }
          if (["steer", "interrupt", "exec"].includes(name))
            return { handled: true as const, result: await control(caller, row, name, args) };
          if (name === "send") {
            if (!queued) throw failure("unavailable", "Docker send requires the account turn queue.");
            return { handled: true as const, result: await send(caller, row, args, queued.claim) };
          }
          if (name === "resume") {
            if (!options.resume) throw failure("unavailable", "Docker sandbox resume is unavailable.");
            return {
              handled: true as const,
              result: await options.resume(caller, row, args.request_id as string | undefined),
            };
          }
          const result =
            name === "status"
              ? await status(caller, row, args.prompt_id as string | undefined)
              : name === "logs"
                ? await logs(caller, row, args)
                : await cleanup(
                    caller,
                    row,
                    name as "stop" | "delete",
                    args.request_id as string | undefined,
                    args.only_if_idle === true,
                  );
          return { handled: true as const, result };
        };
        return DOCKER_HOST_CONTROLS.has(name)
          ? await observeProviderCall("docker", name, dispatch, undefined, {
              replayable: true,
              sandboxId: () => row.id,
            })
          : await dispatch();
      } catch (error) {
        if (
          error instanceof ProviderError ||
          error instanceof DockerHostUpgradeRequired ||
          error instanceof ResumeTurnDeferred
        )
          throw error;
        if (error instanceof VaultError)
          throw failure(error.code === "conflict" ? "conflict" : "unavailable", error.message);
        if (error instanceof DockerRetentionEnded)
          throw new ProviderError({
            provider: "docker",
            code: "sandbox_retention_ended",
            message: error.message,
            retryable: false,
          });
        if (error instanceof DockerHostDenied) throw failure("conflict", "Docker sandbox cleanup is unavailable.");
        throw failure("unavailable", "Docker sandbox operation is unavailable.");
      }
    },
  };
}

export type DockerSandboxControls = ReturnType<typeof createDockerSandboxControls>;
