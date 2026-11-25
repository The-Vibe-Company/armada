import {
  isFinalPromptStatus,
  isSandboxProvider,
  type MemberRole,
  type Provider,
  ProviderError,
  type ProviderTarget,
  type Sql,
  VaultError,
} from "@armada/core/server";
import type { ModalProvider, ModalRuntimeCapture } from "@armada/provider-modal";
import { createSqlData } from "./data.ts";
import { createObservedBoatProvider } from "./observed-boat.ts";
import { runtimeBridgeProfiles, runtimeHarnessSupported } from "./provider-runtime-admission.ts";
import { runtimeAgentFor } from "./runtime-agent.ts";
import { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments, runtimeTransaction } from "./runtime-enrolment.ts";
import { createRuntimeHistory } from "./runtime-history.ts";
import { createRuntimeProvider } from "./runtime-provider.ts";

/** Always available for retained reads/cleanup even when new opt-ins are disabled. */
export function createRuntimeServing(sql: Sql, key: string) {
  const commands = createRuntimeCommands(createRuntimeEnrolments(sql, key), key);
  const history = createRuntimeHistory(sql, key);
  return async (
    apiKey: string | Provider,
    target: ProviderTarget,
    actor: { userId: string },
    captureRuntimeWork?: ModalRuntimeCapture,
  ) => {
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
      (!sandbox.boatRuntime && sandbox.modalTransport !== "dialout") ||
      !isSandboxProvider(sandbox.provider) ||
      !runtimeHarnessSupported(sandbox.provider, sandbox.harness) ||
      sandbox.provider !== target.provider ||
      (typeof apiKey !== "string" && apiKey.id !== sandbox.provider) ||
      sandbox.visibility !== target.visibility ||
      sandbox.sourceGoldenVisibility !== (target.sourceGoldenVisibility ?? target.visibility) ||
      !sandbox.model ||
      !sandbox.reasoningEffort
    )
      throw new VaultError("not_found", "No authorized runtime sandbox.");
    const agent = runtimeAgentFor(
      {
        async call(ownerId, request, options) {
          return commands.callPrepared(
            ownerId,
            request.op,
            async () => {
              // This serving adapter uses private health only for connection checks.
              if (request.op === "steer" || request.op === "testModelConnection" || request.op === "health") {
                if (!sql.transaction) throw new VaultError("unavailable", "Transactional runtime control unavailable.");
                await sql.transaction(async (tx) => {
                  const member = (
                    await tx.query("select user_id from public.members where user_id=$1 and org_id=$2 for update", [
                      actor.userId,
                      sandbox.orgId,
                    ])
                  ).rows[0];
                  if (!member || actor.userId !== sandbox.ownerId)
                    throw new ProviderError({
                      provider: sandbox.provider,
                      code: "forbidden",
                      message: "Runtime owner membership required.",
                      retryable: false,
                    });
                  const account = (
                    await tx.query(
                      `select id from public.credentials where id=$1 and version=$2 and status='active'
               and (expires_at is null or expires_at>now())
               and ((scope='user' and owner_id=$3) or (scope='org' and owner_id=$4))
               for update`,
                      [sandbox.credentialId, sandbox.credentialVersion, actor.userId, sandbox.orgId],
                    )
                  ).rows[0];
                  if (!account)
                    throw new ProviderError({
                      provider: sandbox.provider,
                      code: "forbidden",
                      message: "Pinned runtime account is no longer authorized.",
                      retryable: false,
                    });
                  if (request.op === "testModelConnection" || request.op === "health") {
                    const bound = await tx.query(
                      `select id from public.sandboxes where id=$1 and owner_id=$2 and org_id=$3
                   and provider='boat' and boat_runtime and harness=$4
                   and credential_id=$5 and credential_version=$6 and provider_sandbox_id=$7
                   and status in ('ready','running') and stop_requested_at is null
                   and deleted_at is null and expires_at>now() for update`,
                      [
                        sandbox.id,
                        actor.userId,
                        sandbox.orgId,
                        sandbox.harness,
                        sandbox.credentialId,
                        sandbox.credentialVersion,
                        sandbox.providerSandboxId,
                      ],
                    );
                    if (!bound.rows.length)
                      throw new VaultError("conflict", "Runtime connection binding is no longer current.");
                  }
                  const local = runtimeTransaction(tx);
                  await createRuntimeCommands(createRuntimeEnrolments(local, key), key).enqueue(
                    ownerId,
                    request,
                    options?.expectedEpoch,
                  );
                });
              }
              return { request, options: options ?? {} };
            },
            sandbox.provider,
            sandbox.id,
          );
        },
      },
      sandbox.ownerId,
      sandbox,
      { model: sandbox.model, reasoningEffort: sandbox.reasoningEffort },
    );
    const host = typeof apiKey === "string" ? createObservedBoatProvider({ apiKey }, sandbox.id) : apiKey;
    const authorize = () => {
      if (actor.userId !== sandbox.ownerId)
        throw new VaultError("forbidden", "Only the runtime owner may control this sandbox.");
    };
    const provider = createRuntimeProvider(
      host,
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
              provider: sandbox.provider,
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
      sandbox.boatRuntime || sandbox.modalTransport === "dialout"
        ? {
            ...(runtimeBridgeProfiles[sandbox.provider].modelCheck === "runtime-command" && sandbox.boatRuntime
              ? {
                  testModelConnection(request: Parameters<NonNullable<Provider["testModelConnection"]>>[0]) {
                    authorize();
                    return agent.testModelConnection(request);
                  },
                }
              : {}),
            interrupt(request) {
              authorize();
              return agent.interrupt(request, request.requestId);
            },
            steer(request) {
              authorize();
              const conversationId = request.conversationId ?? sandbox.conversationIds.at(-1);
              if (!conversationId) throw new VaultError("invalid", "No runtime conversation.");
              return agent.steer({ ...request, conversationId }, request.requestId);
            },
            exec(request) {
              authorize();
              return agent.exec(request, request.requestId);
            },
          }
        : undefined,
      captureRuntimeWork,
    );
    if (typeof apiKey === "string" || sandbox.provider !== "modal") return provider;
    const modal = apiKey as ModalProvider;
    return Object.assign(provider, {
      runtimeStopMachine: (binding: Parameters<ModalProvider["runtimeStopMachine"]>[0]) =>
        modal.runtimeStopMachine(binding),
    });
  };
}
