import {
  createSqlMcpRegistry,
  type GoldenActor,
  type LaunchStores,
  type McpCatalogId,
  type McpRegistry,
  type Provider,
  type Sql,
  VaultError,
} from "@armada/core/server";
import { createMcpLifecycle } from "./mcp-lifecycle.ts";

type Scope = {
  id: string;
  orgId: string;
  ownerId: string;
  provider: string;
  providerSandboxId: string;
  orchestratorId: string;
  operationId: string;
  revision: string;
  generation: string;
  deferredRestore: boolean;
};
/** Internal operation-bound MCP preparation. The public registry still excludes
 * managed parents, even from their owners/admins. No request can supply Scope. */
export function createManagedParentMcp(input: {
  sql: Sql;
  registry: McpRegistry;
  encryptionKey: string | undefined;
  origin: string;
  prepareGitHub?: (provider: Provider, sandboxId: string) => Promise<void>;
  catalogAuthentication?: (serviceId: McpCatalogId) => Promise<string | undefined>;
}) {
  async function scopeFor(
    actor: { userId: string; orgId: string },
    selector: { id: string } | { provider: string; providerSandboxId: string },
    allowStoppedResume = false,
  ): Promise<Scope | null> {
    const row = (
      await input.sql.query<{
        id: string;
        org_id: string;
        owner_id: string;
        provider: string;
        provider_sandbox_id: string;
        orchestrator_id: string;
        operation_id: string | null;
        revision: string | number;
        generation: string | number;
        operation_action: string;
        parent_state: string;
        sandbox_status: string;
      }>(
        `select s.id,s.org_id,s.owner_id,s.provider,s.provider_sandbox_id,o.id as orchestrator_id,p.id as operation_id,o.revision,s.lifecycle_generation as generation,p.action as operation_action,o.state as parent_state,s.status as sandbox_status
       from public.sandboxes s join public.orchestrators o on o.sandbox_id=s.id
       left join public.orchestrator_operations p on p.orchestrator_id=o.id and p.revision=o.revision and p.actor_id=o.owner_id and p.state='pending' and p.action in ('create','message','steer','resume')
       where s.org_id=$1 and ${"id" in selector ? "s.id=$2" : "s.provider=$2 and s.provider_sandbox_id=$3"}`,
        "id" in selector ? [actor.orgId, selector.id] : [actor.orgId, selector.provider, selector.providerSandboxId],
      )
    ).rows[0];
    if (!row) return null;
    if (row.owner_id !== actor.userId || !row.operation_id)
      throw new VaultError("forbidden", "Managed MCP operation is not current.");
    const scope = {
      id: row.id,
      orgId: row.org_id,
      ownerId: row.owner_id,
      provider: row.provider,
      providerSandboxId: row.provider_sandbox_id,
      orchestratorId: row.orchestrator_id,
      operationId: row.operation_id,
      revision: String(row.revision),
      generation: String(row.generation),
      deferredRestore:
        allowStoppedResume &&
        row.provider === "modal" &&
        row.operation_action === "resume" &&
        row.parent_state === "resuming" &&
        row.sandbox_status === "stopped",
    };
    await authorized(input.sql, scope, allowStoppedResume);
    return scope;
  }
  async function authorized(sql: Sql, scope: Scope, allowStoppedResume = false) {
    const rows = await sql.query(
      `select s.id from public.sandboxes s join public.orchestrators o on o.sandbox_id=s.id
       join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
       join public.orchestrator_operations p on p.orchestrator_id=o.id and p.id=$7 and p.revision=o.revision and p.actor_id=o.owner_id
       where s.id=$1 and s.org_id=$2 and s.owner_id=$3 and o.owner_id=s.owner_id and o.org_id=s.org_id and s.visibility='private'
       and s.provider=$4 and s.provider_sandbox_id=$5 and o.id=$6 and o.revision=$8 and s.lifecycle_generation=$9
       and o.state in ('creating','ready','resuming') and p.state='pending' and p.action in ('create','message','steer','resume')
       and (s.status in ('starting','ready','running') or ($10 and s.provider='modal' and o.state='resuming' and p.action='resume' and s.status='stopped'))
       and s.stop_requested_at is null`,
      [
        scope.id,
        scope.orgId,
        scope.ownerId,
        scope.provider,
        scope.providerSandboxId,
        scope.orchestratorId,
        scope.operationId,
        scope.revision,
        scope.generation,
        allowStoppedResume && scope.deferredRestore,
      ],
    );
    if (rows.rows.length !== 1) throw new VaultError("forbidden", "Managed MCP operation is no longer current.");
  }
  function lifecycle(scope: Scope) {
    const transact = async <T>(work: (tx: Sql) => Promise<T>) => {
      if (!input.sql.transaction) throw new VaultError("unavailable", "Managed MCP requires transactions.");
      return input.sql.transaction(async (tx) => {
        // Reconcile owns its sandbox-row lock; don't hold parent/authority locks
        // across native I/O. Compare the exact operation again before COMMIT.
        await authorized(tx, scope);
        const value = await work({ query: tx.query.bind(tx), transaction: async (next) => next(tx) });
        await authorized(tx, scope);
        return value;
      });
    };
    const sql: Sql = { query: (q, params) => transact((tx) => tx.query(q, params)), transaction: transact };
    const scopedRegistry = (db: Sql, base: McpRegistry): McpRegistry => ({
      ...base,
      async sandboxConnections(user, org, id) {
        if (user !== scope.ownerId || org !== scope.orgId || id !== scope.id)
          throw new VaultError("forbidden", "Managed MCP scope mismatch.");
        await authorized(db, scope);
        const selected = (
          await db.query<{ connection_id: string }>(
            "select connection_id from public.mcp_bindings where sandbox_id=$1 order by connection_id",
            [id],
          )
        ).rows;
        return Promise.all(selected.map((row) => base.get(user, org, row.connection_id)));
      },
    });
    const registry = scopedRegistry(sql, input.registry);
    return createMcpLifecycle({
      sql,
      registry,
      registryForSql: (tx) =>
        scopedRegistry(
          tx,
          createSqlMcpRegistry(tx, input.encryptionKey, {
            ...(input.catalogAuthentication ? { catalogAuthentication: input.catalogAuthentication } : {}),
          }),
        ),
      encryptionKey: input.encryptionKey,
      origin: input.origin,
      ...(input.prepareGitHub
        ? {
            prepareGitHub: async (provider, id) => {
              await authorized(input.sql, scope);
              await input.prepareGitHub?.(provider, id);
              await authorized(input.sql, scope);
            },
          }
        : {}),
    });
  }
  return {
    async prepare(
      provider: Provider,
      sandbox: Parameters<NonNullable<NonNullable<LaunchStores["connections"]>["prepare"]>>[1],
      actor: GoldenActor,
    ) {
      const scope = await scopeFor(actor, { id: sandbox.id });
      if (!scope || scope.provider !== provider.id || scope.providerSandboxId !== sandbox.providerSandboxId)
        throw new VaultError("forbidden", "Managed MCP parent is not current.");
      await lifecycle(scope).reconcile(provider, sandbox);
    },
    async beforePrompt(provider: Provider, id: string, actor: { userId: string; orgId: string }) {
      const scope = await scopeFor(actor, { provider: provider.id, providerSandboxId: id }, true);
      if (!scope) return null;
      // Modal invokes this hook after physical activation but BEFORE native
      // session proof and SQL stopped -> ready/generation publication. Only the
      // current pending owner resume may defer; it grants no MCP/status/epoch
      // authority. The runtime reconciles via prepare after verified restore.
      if (scope.deferredRestore) return scope.id;
      await lifecycle(scope).reconcile(provider, {
        id: scope.id,
        orgId: scope.orgId,
        ownerId: scope.ownerId,
        providerSandboxId: scope.providerSandboxId,
      });
      return scope.id;
    },
  };
}
