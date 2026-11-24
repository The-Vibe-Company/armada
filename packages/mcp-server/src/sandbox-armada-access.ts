import {
  createSqlVaultStore,
  DelegatedAuthority,
  GOLDEN_ROOT,
  type GoldenActor,
  type Provider,
  resolveCredentials,
  type SandboxRecord,
  type Sql,
  VaultError,
} from "@armada/core/server";
import type { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import { bootstrapSandboxAccess } from "./sandbox-access-bootstrap.ts";
import { orchestratorScopedMcpUrl } from "./sandbox-access-scoped-gateway.ts";
import { createEnrolledDelegatedTransport } from "./sandbox-access-transport.ts";

const enrolledPlacement =
  "((s.provider='boat' and s.boat_runtime) or (s.provider='modal' and s.runtime_transport='dialout'))";

const workerScopes = ["worker:launch", "worker:read", "worker:message", "worker:stop", "worker:extend"] as const;

export interface SandboxArmadaAccessOptions {
  maxActiveChildren?: number;
}

function requireScopedAccount(
  sandbox: Pick<SandboxRecord, "credentialId" | "visibility" | "ownerId" | "orgId">,
  actor: GoldenActor,
) {
  const { credentialId } = sandbox;
  if (
    !credentialId ||
    sandbox.visibility !== "private" ||
    sandbox.ownerId !== actor.userId ||
    sandbox.orgId !== actor.orgId
  )
    throw new VaultError("invalid", "Delegated access requires a private sandbox and a bound model account.");
  return credentialId;
}

export async function registerSandboxArmadaParent(
  tx: Sql,
  actor: Pick<GoldenActor, "orgId" | "userId">,
  sandboxId: string,
  goldenId: string,
  credentialId: string,
  options: SandboxArmadaAccessOptions,
) {
  await tx.query(
    `insert into public.armada_access_parents(id,kind,org_id,owner_id,sandbox_id,state,golden_ids,credential_ids)
     values($1,'sandbox',$2,$3,$1,'ready',$4::uuid[],$5::uuid[])`,
    [sandboxId, actor.orgId, actor.userId, [goldenId], [credentialId]],
  );
  await tx.query(`insert into public.orchestrator_lifecycle(orchestrator_id,max_active_children) values($1,$2)`, [
    sandboxId,
    options.maxActiveChildren ?? 3,
  ]);
}

/** Ordinary sandbox authority. There is deliberately no orchestrator identity,
 * orchestration policy, owner token or ambient access for unselected sandboxes. */
export function createSandboxArmadaAccess(input: {
  sql: Sql;
  encryptionKey: string;
  publicUrl: string;
  commands?: Pick<ReturnType<typeof createRuntimeCommands>, "call" | "enqueue">;
}) {
  const { sql } = input;
  const enrolments = createRuntimeEnrolments(sql, input.encryptionKey);
  const authorityFor = (store: Sql) =>
    new DelegatedAuthority(store, async (tx, account) => {
      await resolveCredentials(createSqlVaultStore(tx), input.encryptionKey, account);
    });
  async function scope(provider: Provider, providerId: string, sandboxId?: string) {
    return (
      await sql.query<{
        id: string;
        sandbox_id: string;
        owner_id: string;
        org_id: string;
        lifecycle_generation: string;
        golden_ids: string[];
        credential_ids: string[];
        enrolled: boolean;
        stop_requested: boolean;
        terminal: boolean;
      }>(
        `select p.id,p.sandbox_id,p.owner_id,p.org_id,s.lifecycle_generation,p.golden_ids,p.credential_ids,
          ${enrolledPlacement} is true as enrolled,s.stop_requested_at is not null as stop_requested,
          s.status in ('stopped','failed','deleted') as terminal from public.armada_access_parents p
       join public.sandboxes s on s.id=p.sandbox_id where p.kind='sandbox' and s.provider=$1 and s.provider_sandbox_id=$2
         and ($3::uuid is null or s.id=$3)`,
        [provider.id, providerId, sandboxId ?? null],
      )
    ).rows[0];
  }
  async function restoreEnrolled(
    ownerId: string,
    sandboxId: string,
    epoch: string,
    lifecycleGeneration: string,
    signal: AbortSignal,
    assertClaim?: (tx: Sql) => Promise<void>,
    required = false,
  ) {
    signal.throwIfAborted();
    const parent = (
      await sql.query<{ id: string; golden_ids: string[]; credential_ids: string[] }>(
        `select p.id,p.golden_ids,p.credential_ids from public.armada_access_parents p
         join public.sandboxes s on s.id=p.sandbox_id
         where p.sandbox_id=$1 and p.owner_id=$2 and p.kind='sandbox'
         and ${enrolledPlacement}`,
        [sandboxId, ownerId],
      )
    ).rows[0];
    if (!parent) {
      if (required) throw new VaultError("conflict", "Scoped runtime parent is unavailable.");
      return;
    }
    if (!input.commands) throw new VaultError("unavailable", "Scoped runtime delivery is unavailable.");
    const transport = createEnrolledDelegatedTransport(input.commands, {
      ownerId,
      sandboxId,
      epoch,
      signal,
      ...(assertClaim ? { assertClaim } : {}),
      lifecycleGeneration,
      mcpUrl: orchestratorScopedMcpUrl(input.publicUrl),
    });
    const writeUnderOwner = <T>(write: (tx: Sql) => Promise<T>) =>
      enrolments.withOwner(
        sandboxId,
        ownerId,
        async (tx, scope) => {
          if (scope.epoch !== epoch) throw new VaultError("conflict", "Scoped runtime epoch changed.");
          await assertClaim?.(tx);
          const result = await write(tx);
          await assertClaim?.(tx);
          return result;
        },
        lifecycleGeneration,
      );
    const currentGrant = new Error("Scoped runtime grant is already acknowledged.");
    const runtimeFencedAuthority = authorityFor({
      ...sql,
      query: (statement, params) =>
        assertClaim ? writeUnderOwner((tx) => tx.query(statement, params)) : sql.query(statement, params),
      transaction: (write) =>
        writeUnderOwner(async (tx) => {
          const locked = await tx.query(
            "select id from public.armada_access_parents where id=$1 and state='ready' for update skip locked",
            [parent.id],
          );
          if (!locked.rows.length) throw new VaultError("conflict", "Scoped parent authority is unavailable.");
          const current = await tx.query(
            `select d.id from public.orchestrator_delegations d
             join public.armada_access_parents p on p.id=d.orchestrator_id
             join public.sandboxes s on s.id=p.sandbox_id
             where p.id=$1 and d.epoch=p.authority_epoch and d.native_generation=$2
             and s.orchestrator_native_generation=$2 and d.acknowledged_at is not null
             and d.revoked_at is null and d.expires_at>now()
             and d.golden_ids=p.golden_ids and d.account_ids=p.credential_ids and d.scopes=$3::text[]`,
            [parent.id, epoch, [...workerScopes]],
          );
          if (current.rows.length) throw currentGrant;
          signal.throwIfAborted();
          return write(tx);
        }),
    });
    try {
      await runtimeFencedAuthority.installEpoch(parent.id, transport, {
        scopes: [...workerScopes],
        goldenIds: parent.golden_ids,
        credentialIds: parent.credential_ids,
      });
    } catch (error) {
      if (error !== currentGrant) throw error;
    }
  }
  async function prepare(
    provider: Provider,
    sandbox: SandboxRecord,
    actor: GoldenActor,
    options: SandboxArmadaAccessOptions,
    runtime?: { epoch: string; exec: Provider["exec"]; signal: AbortSignal },
  ) {
    const credentialId = requireScopedAccount(sandbox, actor);
    const register = (tx: Sql) =>
      registerSandboxArmadaParent(tx, actor, sandbox.id, sandbox.goldenId, credentialId, options);
    const bootstrap = {
      sandboxId: sandbox.providerSandboxId,
      projectDir: sandbox.repositoryDir ? `${GOLDEN_ROOT}/${sandbox.repositoryDir}` : GOLDEN_ROOT,
      harness: sandbox.harness,
      skillRevision: "0".repeat(40),
    };
    if (!input.commands || !runtime) throw new VaultError("unavailable", "Scoped runtime delivery is unavailable.");
    await bootstrapSandboxAccess(provider, {
      ...bootstrap,
      exec: runtime.exec,
      configureAuthority: async () => {
        const generation = await enrolments.withOwner(sandbox.id, actor.userId, async (tx, scope) => {
          if (scope.epoch !== runtime.epoch) throw new VaultError("conflict", "Scoped runtime epoch changed.");
          const row = (
            await tx.query<{ generation: string }>(
              `select lifecycle_generation::text as generation from public.sandboxes s
                 where id=$1 and org_id=$2 and provider=$3 and provider_sandbox_id=$4 and ${enrolledPlacement}
                 and visibility='private' and golden_id=$5 and credential_id=$6`,
              [sandbox.id, actor.orgId, provider.id, sandbox.providerSandboxId, sandbox.goldenId, credentialId],
            )
          ).rows[0];
          if (!row) throw new VaultError("conflict", "The scoped runtime placement changed.");
          await register(tx);
          return row.generation;
        });
        await restoreEnrolled(actor.userId, sandbox.id, runtime.epoch, generation, runtime.signal);
      },
    });
  }
  async function scrub(provider: Provider, id: string, cleanup?: "stop" | "delete", sandboxId?: string) {
    const parent = await scope(provider, id, sandboxId);
    if (!parent) return;
    if (cleanup && (parent.terminal || (cleanup === "stop" && parent.stop_requested))) return;
    throw new VaultError("conflict", "Scoped runtime cleanup requires a lifecycle stop or terminal state.");
  }
  return {
    restoreEnrolled,
    prepare,
    wrap(provider: Provider): Provider {
      return new Proxy(provider, {
        get(target, key) {
          if (key === "stop" || key === "delete")
            return async (request: { sandboxId: string }) => {
              await scrub(target, request.sandboxId, key);
              return key === "stop" ? target.stop(request) : target.delete(request);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
}

export type RestoreScopedRuntimeAccess = ReturnType<typeof createSandboxArmadaAccess>["restoreEnrolled"];
