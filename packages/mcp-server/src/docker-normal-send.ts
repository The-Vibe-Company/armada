import { ProviderError } from "@armada/core";
import { decryptSecret, type Sql } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { createDockerLaunchVariables } from "./docker-launch-variables.ts";
import { createDockerRuntimeLifecycle } from "./docker-runtime-lifecycle.ts";
import type { RuntimeGitHub } from "./runtime-github.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Normal send shares the preview's fenced, idempotent native admission boundary. */
export function createDockerNormalSend(
  sql: Sql,
  key: string,
  options: {
    enabled?: boolean;
    github?: Pick<RuntimeGitHub, "prepareTurn">;
    clock?: { now(): number; wait(ms: number): Promise<void> };
    timeoutMs?: number;
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
      row: { id: string; org_id: string; owner_id: string; status: string; conversation_ids: string[] },
    ) {
      if (!options.enabled) throw failure("unavailable", "Docker send is not enabled.");
      if (row.owner_id !== caller.userId) throw failure("conflict", "Only the Docker sandbox owner can send prompts.");
      if (
        typeof args.request_id !== "string" ||
        !uuid.test(args.request_id) ||
        typeof args.prompt !== "string" ||
        !args.prompt.trim() ||
        Buffer.byteLength(args.prompt) > 262144 ||
        args.model !== undefined ||
        args.reasoning_effort !== undefined ||
        (args.conversation_id !== undefined &&
          (typeof args.conversation_id !== "string" || !uuid.test(args.conversation_id)))
      )
        throw failure("invalid_request", "Docker send requires request_id and prompt; model and effort remain pinned.");
      if (!["ready", "running"].includes(row.status))
        throw failure("conflict", "Docker sandbox must be running before send.");
      let conversationId = args.conversation_id ?? row.conversation_ids.at(-1);
      const previous = (
        await sql.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
          "select request_enc from public.runtime_commands where sandbox_id=$1 and request_id=$2",
          [row.id, `docker_prompt_${args.request_id}`],
        )
      ).rows[0];
      // Reconcile durable admission without requiring GitHub to be healthy again.
      // runtime.prompt still validates exact input, current owner and epoch.
      if (args.conversation_id === undefined && previous)
        conversationId = JSON.parse(await decryptSecret(previous.request_enc, key)).input.conversationId;
      if (!previous) {
        await createDockerLaunchVariables(sql, key, clock)(caller, row.id);
        await options.github?.prepareTurn(caller, row.id);
      }
      const deadline = clock.now() + (options.timeoutMs ?? 25_000);
      for (;;) {
        let result: Awaited<ReturnType<typeof runtime.prompt>>;
        try {
          result = await runtime.prompt({ userId: caller.userId, orgId: row.org_id }, row.id, {
            requestId: args.request_id,
            text: args.prompt,
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
            requestId: args.request_id,
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
