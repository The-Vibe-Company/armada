import { ProviderError } from "@armada/core";
import { decryptSecret, type Sql } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { createDockerLaunchEnvironment } from "./docker-launch-environment.ts";
import { createDockerQueuedPrompts } from "./docker-queued-prompts.ts";
import { createDockerRuntimeLifecycle } from "./docker-runtime-lifecycle.ts";
import { DOCKER_DISPATCH_REQUEST, DOCKER_SEND_REFUSAL } from "./docker-send-request-schema.ts";
import type { RuntimeGitHub } from "./runtime-github.ts";
import type { RuntimeMcp } from "./runtime-mcp.ts";
import { ToolError } from "./tools.ts";

/** Normal send shares the preview's fenced, idempotent native admission boundary. */
export function createDockerNormalSend(
  sql: Sql,
  key: string,
  options: {
    enabled?: boolean;
    /** Internal worker only: dispatch an already accepted, fenced queue record. */
    dispatchQueued?: boolean;
    github?: Pick<RuntimeGitHub, "prepareTurn">;
    clock?: { now(): number; wait(ms: number): Promise<void> };
    timeoutMs?: number;
    prepareMcp?: RuntimeMcp["prepare"];
    prepareSnapshotGitHub?: RuntimeGitHub["prepareLaunch"];
  } = {},
) {
  const runtime = createDockerRuntimeLifecycle(sql, key, { enabled: options.enabled === true });
  const clock = options.clock ?? {
    now: Date.now,
    wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  const failure = (code: "invalid_request" | "unavailable" | "conflict", message: string) =>
    new ProviderError({ provider: "docker", code, message, retryable: code === "unavailable" });
  return {
    async send(
      caller: Caller,
      args: Record<string, unknown>,
      row: {
        id: string;
        org_id: string;
        owner_id: string;
        status: string;
        conversation_ids: string[];
        docker_snapshot_id?: string | null;
      },
      wake?: () => Promise<typeof row>,
    ) {
      if (!options.enabled) throw failure("unavailable", "Docker send is not enabled.");
      if (row.owner_id !== caller.userId) throw failure("conflict", "Only the Docker sandbox owner can send prompts.");
      // The published Docker sandbox/send variant, plus the key the account queue always supplies.
      const parsed = DOCKER_DISPATCH_REQUEST.safeParse(args);
      // Armada's own request validation, not a provider diagnostic: its message is the public
      // guidance (a ProviderError invalid_request would be replaced by generic launch help).
      if (!parsed.success) throw new ToolError("invalid_request", DOCKER_SEND_REFUSAL);
      const input = parsed.data;
      if (!options.dispatchQueued) {
        const queued = await createDockerQueuedPrompts(sql, key).accept(caller, row.id, row.org_id, {
          request_id: input.request_id,
          prompt: input.prompt,
          ...(input.conversation_id === undefined ? {} : { conversation_id: input.conversation_id }),
        });
        if (queued) return queued;
        const current = (
          await sql.query<typeof row>(
            `select s.id,s.org_id,s.owner_id,s.status,s.conversation_ids,s.docker_snapshot_id from public.sandboxes s
          join public.members m on m.user_id=$2 and m.org_id=s.org_id where s.id=$1 and s.owner_id=$2 and s.org_id=$3`,
            [row.id, caller.userId, row.org_id],
          )
        ).rows[0];
        if (!current) throw failure("unavailable", "Docker sandbox is no longer accessible.");
        row = current;
      }
      const deadline = clock.now() + (options.timeoutMs ?? 25_000);
      // A saved prompt UUID is admission history, never a fresh wake instruction.
      // In particular, retrying it after a later idle stop must not resume compute.
      const previous = (
        await sql.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
          "select request_enc from public.runtime_commands where sandbox_id=$1 and request_id=$2",
          [row.id, `docker_prompt_${input.request_id}`],
        )
      ).rows[0];
      if (!["ready", "running"].includes(row.status)) {
        if (previous || !["stopped", "starting"].includes(row.status) || !wake)
          throw failure("conflict", "Docker sandbox must be running before send. Use a new request_id for a new turn.");
        if (row.status === "starting") {
          const pendingResume = await sql.query(
            `select request_id from public.docker_host_jobs where bound_sandbox_id=$1 and request_id=$2
             and bound_operation='resume' and bound_actor_id=$3 and outcome is distinct from 'failed'`,
            [row.id, input.request_id, caller.userId],
          );
          if (!pendingResume.rows.length)
            throw failure(
              "unavailable",
              "Docker sandbox resume is pending. Retry identical input with the same request_id.",
            );
        }
        row = await wake();
        if (!["ready", "running"].includes(row.status))
          throw failure("conflict", "Docker sandbox resume is still pending.");
      }
      await options.prepareMcp?.(caller, row.id);
      let conversationId = input.conversation_id ?? row.conversation_ids.at(-1);
      if (conversationId === undefined && !previous) {
        const launch = (
          await sql.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
            "select request_enc from public.docker_launch_requests where sandbox_id=$1",
            [row.id],
          )
        ).rows[0];
        if (launch) {
          const manifest = JSON.parse(await decryptSecret(launch.request_enc, key));
          conversationId = manifest.conversationId ?? manifest.promptId;
        }
      }
      // Reconcile durable admission without requiring GitHub to be healthy again.
      // runtime.prompt still validates exact input, current owner and epoch.
      if (input.conversation_id === undefined && previous)
        conversationId = JSON.parse(await decryptSecret(previous.request_enc, key)).input.conversationId;
      if (!previous) {
        await createDockerLaunchEnvironment(sql, key, clock)(caller, row.id);
        await options.github?.prepareTurn(caller, row.id);
      }
      if (!previous && row.docker_snapshot_id) await options.prepareSnapshotGitHub?.(caller, row.id);
      for (;;) {
        let result: Awaited<ReturnType<typeof runtime.prompt>>;
        try {
          result = await runtime.prompt({ userId: caller.userId, orgId: row.org_id }, row.id, {
            requestId: input.request_id,
            text: input.prompt,
            ...(conversationId === undefined ? {} : { conversationId: conversationId as string }),
          });
        } catch {
          throw failure(
            "conflict",
            "Docker prompt admission unavailable. Retry identical input with the same request_id.",
          );
        }
        if (result.state === "admitted")
          return {
            id: row.id,
            requestId: input.request_id,
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
    },
  };
}
