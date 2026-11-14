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
import { runtimeAgentFor } from "./runtime-agent.ts";
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
      (sandbox.harness !== "codex" &&
        sandbox.harness !== "claude" &&
        !(sandbox.provider === "modal" && sandbox.harness === "opencode")) ||
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
          if (request.op === "steer") {
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
              const local = {
                ...tx,
                query: tx.query.bind(tx),
                transaction: async <T>(work: (tx: Sql) => Promise<T>) => work(tx),
              };
              await createRuntimeCommands(createRuntimeEnrolments(local, key), key).enqueue(ownerId, request);
            });
          }
          return commands.call(ownerId, request, options);
        },
      },
      sandbox.ownerId,
      sandbox,
      { model: sandbox.model, reasoningEffort: sandbox.reasoningEffort },
    );
    const host = typeof apiKey === "string" ? createBoatProvider({ apiKey }) : apiKey;
    // Native Modal stop expects its private listener. This lane may retain disk
    // only after the common journal checkpoint committed, never on a host ACK.
    const compute =
      sandbox.provider !== "modal"
        ? host
        : new Proxy(host, {
            get(instance, property) {
              if (property !== "stop") {
                const value = Reflect.get(instance, property, instance);
                return typeof value === "function" ? value.bind(instance) : value;
              }
              return async (request: { sandboxId: string }) => {
                if (request.sandboxId !== sandbox.providerSandboxId)
                  throw new VaultError("not_found", "No runtime stop target.");
                const proof = (
                  await sql.query<{ epoch: string; watermark: string }>(
                    `select p.epoch::text,p.watermark::text
            from public.sandboxes s join public.runtime_enrolments r on r.sandbox_id=s.id
            join public.runtime_checkpoints p on p.sandbox_id=s.id and p.epoch=r.epoch
            join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
            where s.id=$1 and s.owner_id=$2 and s.provider_sandbox_id=$3 and s.runtime_transport='dialout'
            and s.status in ('ready','running','stopping') and s.deleted_at is null and not s.application_secret_tainted
            and p.watermark is not null and p.watermark=(select coalesce(max(sequence),0) from public.runtime_events where sandbox_id=s.id)`,
                    [sandbox.id, sandbox.ownerId, sandbox.providerSandboxId],
                  )
                ).rows[0];
                if (!proof) return instance.stop(request); // No checkpoint: compute-only cleanup, no disk claim.
                const current = await instance.get(request.sandboxId);
                if (current.state === "stopped") return;
                const watermark = Number(proof.watermark);
                if (
                  !Number.isSafeInteger(watermark) ||
                  watermark < 0 ||
                  !current.physicalGeneration ||
                  !/^[1-9][0-9]*$/.test(current.physicalGeneration)
                )
                  throw new VaultError("conflict", "No physical checkpoint binding.");
                return (instance as import("@armada/provider-modal").ModalProvider).stopRuntime({
                  ...request,
                  physicalGeneration: current.physicalGeneration!,
                  epoch: proof.epoch,
                  watermark,
                });
              };
            },
          });
    const authorize = () => {
      if (actor.userId !== sandbox.ownerId)
        throw new VaultError("forbidden", "Only the runtime owner may control this sandbox.");
    };
    return createRuntimeProvider(
      compute,
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
      sandbox.boatRuntime || sandbox.runtimeTransport === "dialout"
        ? {
            interrupt(request) {
              authorize();
              return agent.interrupt(request);
            },
            steer(request) {
              authorize();
              const conversationId = request.conversationId ?? sandbox.conversationIds.at(-1);
              if (!conversationId) throw new VaultError("invalid", "No runtime conversation.");
              return agent.steer({ ...request, conversationId });
            },
            exec(request) {
              authorize();
              return agent.exec(request);
            },
          }
        : undefined,
    );
  };
}
