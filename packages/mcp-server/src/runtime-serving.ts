import {
  isFinalPromptStatus,
  type MemberRole,
  type Provider,
  ProviderError,
  type ProviderTarget,
  type Sql,
  VaultError,
} from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { createSqlData } from "./data.ts";
import { createRuntimeAgent } from "./runtime-agent.ts";
import { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import { createRuntimeHistory } from "./runtime-history.ts";
import { createRuntimeProvider } from "./runtime-provider.ts";

/** Always available for retained reads/cleanup even when new opt-ins are disabled. */
export function createRuntimeServing(sql: Sql, key: string) {
  const commands = createRuntimeCommands(createRuntimeEnrolments(sql, key), key);
  const history = createRuntimeHistory(sql, key);
  return async (apiKey: string | Provider, target: ProviderTarget, actor: { userId: string }) => {
    const member = (
      await sql.query<{ role: MemberRole }>(
        "select role::text as role from public.members where org_id=$1 and user_id=$2",
        [target.orgId, actor.userId],
      )
    ).rows[0];
    if (!member || !target.id) throw new VaultError("not_found", "No authorized runtime sandbox.");
    const caller = {
      userId: actor.userId,
      orgs: [{ orgId: target.orgId, role: member.role }],
      via: "service" as const,
    };
    const sandbox = await createSqlData(sql)(caller).sandboxes.get(target.id);
    if (
      !sandbox ||
      (!sandbox.boatRuntime && sandbox.runtimeTransport !== "dialout") ||
      !["boat", "modal"].includes(sandbox.provider) ||
      sandbox.harness !== "codex" ||
      sandbox.visibility !== target.visibility ||
      sandbox.sourceGoldenVisibility !== (target.sourceGoldenVisibility ?? target.visibility) ||
      !sandbox.model ||
      !sandbox.reasoningEffort
    )
      throw new VaultError("not_found", "No authorized runtime sandbox.");
    const agent = createRuntimeAgent(commands, {
      ownerId: sandbox.ownerId,
      sandboxId: sandbox.id,
      providerSandboxId: sandbox.providerSandboxId,
      cwd: sandbox.repositoryDir ? `/home/user/${sandbox.repositoryDir}` : "/home/user",
      defaults: { model: sandbox.model, reasoningEffort: sandbox.reasoningEffort },
    });
    return createRuntimeProvider(
      typeof apiKey === "string" ? createBoatProvider({ apiKey }) : apiKey,
      sandbox.providerSandboxId,
      {
        async getPrompt(request) {
          if (!["failed", "stopped", "deleted"].includes(sandbox.status)) return agent.getPrompt(request);
          const page = await history(caller, sandbox.id, { direction: "backward", limit: 1000 });
          const last = page.events
            .toReversed()
            .find((event) => event.kind === "prompt" && event.promptId === request.promptId);
          if (
            (!last || last.kind !== "prompt") &&
            sandbox.status === "failed" &&
            sandbox.taskPromptId === request.promptId
          )
            return { promptId: request.promptId, status: "failed" as const, done: true };
          if (!last || last.kind !== "prompt")
            throw new ProviderError({
              provider: "boat",
              code: "not_found",
              message: "No archived runtime prompt.",
              retryable: false,
            });
          return {
            promptId: request.promptId,
            ...(last.conversationId ? { conversationId: last.conversationId } : {}),
            status: isFinalPromptStatus(last.status)
              ? last.status
              : sandbox.status === "failed"
                ? "failed"
                : "interrupted",
            done: true,
          };
        },
        events: ({ sandboxId: _physical, ...pagination }) => history(caller, sandbox.id, pagination),
      },
    );
  };
}
