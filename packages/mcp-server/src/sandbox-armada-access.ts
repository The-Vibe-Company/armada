import {
  createSqlVaultStore,
  GOLDEN_ROOT,
  type GoldenActor,
  OrchestratorAuthority,
  type Provider,
  resolveCredentials,
  type SandboxRecord,
  type Sql,
  VaultError,
} from "@armada/core/server";
import { createBoatOrchestratorProvider } from "./boat-orchestrator-provider.ts";
import { bootstrapOrchestrator } from "./orchestrator-bootstrap.ts";
import { orchestratorScopedMcpUrl } from "./orchestrator-scoped-gateway.ts";
import { createOrchestratorTransport } from "./orchestrator-transport.ts";

export interface SandboxArmadaAccessOptions {
  maxActiveChildren?: number;
}
export function parseSandboxArmadaAccess(value: unknown): SandboxArmadaAccessOptions | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return {};
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "maxActiveChildren")
  )
    throw new VaultError("invalid", "armadaAccess must be a boolean or a child-limit configuration.");
  const limit = Reflect.get(value, "maxActiveChildren");
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100))
    throw new VaultError("invalid", "maxActiveChildren must be between 1 and 100.");
  return limit === undefined ? {} : { maxActiveChildren: limit };
}

/** Ordinary sandbox authority. There is deliberately no orchestrator identity,
 * orchestration policy, owner token or ambient access for unselected sandboxes. */
export function createSandboxArmadaAccess(input: { sql: Sql; encryptionKey: string; publicUrl: string }) {
  const { sql } = input;
  const authority = new OrchestratorAuthority(sql, async (tx, account) => {
    await resolveCredentials(createSqlVaultStore(tx), input.encryptionKey, account);
  });
  const native = (provider: Provider) =>
    provider.id === "boat" ? createBoatOrchestratorProvider(provider, input.encryptionKey) : provider;
  async function scope(provider: Provider, providerId: string) {
    return (
      await sql.query<{
        id: string;
        sandbox_id: string;
        owner_id: string;
        org_id: string;
        lifecycle_generation: string;
        golden_ids: string[];
        credential_ids: string[];
      }>(
        `select p.id,p.sandbox_id,p.owner_id,p.org_id,s.lifecycle_generation,p.golden_ids,p.credential_ids from public.armada_access_parents p
       join public.sandboxes s on s.id=p.sandbox_id where p.kind='sandbox' and s.provider=$1 and s.provider_sandbox_id=$2`,
        [provider.id, providerId],
      )
    ).rows[0];
  }
  async function install(provider: Provider, id: string) {
    const parent = await scope(provider, id);
    if (!parent) return;
    const target = native(provider);
    const physical = await target.get(id);
    if (!physical.physicalGeneration || !["ready", "running"].includes(physical.state))
      throw new VaultError("unavailable", "Delegated access requires an active native generation.");
    await authority.installEpoch(
      parent.id,
      createOrchestratorTransport({
        provider: target,
        providerSandboxId: id,
        physicalGeneration: physical.physicalGeneration,
        lifecycleGeneration: String(parent.lifecycle_generation),
        mcpUrl: orchestratorScopedMcpUrl(input.publicUrl),
      }),
      {
        scopes: ["worker:launch", "worker:read", "worker:message", "worker:stop", "worker:extend"],
        goldenIds: parent.golden_ids,
        credentialIds: parent.credential_ids,
      },
    );
  }
  async function scrub(provider: Provider, id: string) {
    const parent = await scope(provider, id);
    if (!parent) return;
    await authority.revoke(parent.id);
    const target = native(provider);
    const physical = await target.get(id);
    if (physical.state === "stopped") return;
    if (!physical.physicalGeneration || !target.quiesceOrchestrator)
      throw new VaultError("unavailable", "Delegated access cannot be safely checkpointed.");
    await target.quiesceOrchestrator({ sandboxId: id, physicalGeneration: physical.physicalGeneration });
    await authority.scrubBeforeCheckpoint(
      parent.id,
      createOrchestratorTransport({
        provider: target,
        providerSandboxId: id,
        physicalGeneration: physical.physicalGeneration,
        lifecycleGeneration: String(parent.lifecycle_generation),
        mcpUrl: orchestratorScopedMcpUrl(input.publicUrl),
      }),
    );
  }
  return {
    beforePrompt: install,
    beforeSnapshot: scrub,
    async prepare(provider: Provider, sandbox: SandboxRecord, actor: GoldenActor, options: SandboxArmadaAccessOptions) {
      if (
        !sandbox.credentialId ||
        sandbox.visibility !== "private" ||
        sandbox.ownerId !== actor.userId ||
        sandbox.orgId !== actor.orgId
      )
        throw new VaultError("invalid", "Delegated access requires a private sandbox and an explicit named account.");
      await sql.query(
        `insert into public.armada_access_parents(id,kind,org_id,owner_id,sandbox_id,state,golden_ids,credential_ids)
        values($1,'sandbox',$2,$3,$1,'ready',$4::uuid[],$5::uuid[])`,
        [sandbox.id, actor.orgId, actor.userId, [sandbox.goldenId], [sandbox.credentialId]],
      );
      await sql.query(`insert into public.orchestrator_lifecycle(orchestrator_id,max_active_children) values($1,$2)`, [
        sandbox.id,
        options.maxActiveChildren ?? 3,
      ]);
      await bootstrapOrchestrator(native(provider), {
        sandboxId: sandbox.providerSandboxId,
        projectDir: sandbox.repositoryDir ? `${GOLDEN_ROOT}/${sandbox.repositoryDir}` : GOLDEN_ROOT,
        harness: sandbox.harness,
        skillRevision: "0".repeat(40),
        configureAuthority: () => install(provider, sandbox.providerSandboxId),
      });
    },
    wrap(provider: Provider): Provider {
      return new Proxy(provider, {
        get(target, key) {
          if (key === "stop" || key === "delete")
            return async (request: { sandboxId: string }) => {
              await scrub(target, request.sandboxId);
              return key === "stop" ? target.stop(request) : target.delete(request);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
}
