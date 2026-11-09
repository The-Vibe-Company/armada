import {
  createSqlSandboxStore,
  type GoldenActor,
  type LaunchRequest,
  type LaunchStores,
  launchSandbox,
  PROVIDER_LIMITS,
  type Provider,
  type Sql,
} from "@armada/core/server";
import { OrchestratorRuntimeError, type RuntimeReservation } from "./orchestrator-runtime-store.ts";

/** Reuses the v2 launcher; named credentials and size policy are resolved by their
 * actual producer adapters before invoking this function. Never resolves legacy defaults.
 * No ordinary-worker launch path is modified. */
export async function launchOrchestratorParent(input: {
  sql: Sql;
  provider: Provider;
  stores: LaunchStores;
  actor: GoldenActor;
  request: LaunchRequest;
  reservation: RuntimeReservation;
}): Promise<void> {
  const { sql, provider, actor, request, reservation } = input;
  const identity = reservation.identity;
  if (
    !sql.transaction ||
    actor.userId !== identity.ownerId ||
    actor.orgId !== identity.orgId ||
    request.provider !== identity.configuration.provider ||
    request.harness !== identity.configuration.harness ||
    request.model !== identity.configuration.model ||
    request.reasoningEffort !== identity.configuration.reasoningEffort ||
    request.prompt !== undefined
  )
    throw new OrchestratorRuntimeError("invalid_request");
  const sandboxId = crypto.randomUUID();
  const sandboxes = {
    ...input.stores.sandboxes,
    insert: async (record: Parameters<LaunchStores["sandboxes"]["insert"]>[0]) => {
      if (!sql.transaction || record.id !== sandboxId || record.visibility !== "private")
        throw new OrchestratorRuntimeError("conflict");
      return sql.transaction(async (tx) => {
        const current = await tx.query(
          `select o.id from public.orchestrators o join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
        where o.id=$1 and o.owner_id=$2 and o.org_id=$3 and o.revision=$4 and o.state='creating' and o.sandbox_id is null for update of o,m`,
          [identity.id, actor.userId, actor.orgId, reservation.operation.revision],
        );
        if (!current.rows.length) throw new OrchestratorRuntimeError("conflict");
        const saved = await createSqlSandboxStore(tx).insert(record);
        await tx.query(`update public.orchestrators set sandbox_id=$2 where id=$1`, [identity.id, saved.id]);
        return saved;
      });
    },
  };
  const routed = new Proxy(provider, {
    get(target, key) {
      if (key === "fork")
        return (fork: Parameters<Provider["fork"]>[0]) =>
          target.fork({
            ...fork,
            idempotencyKey: reservation.operation.id,
            labels: { ...fork.labels, orchestrator: identity.id, operation: reservation.operation.id },
          });
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await launchSandbox(
    routed,
    { ...input.stores, sandboxes },
    actor,
    {
      ...request,
      visibility: "private",
      ttlSeconds: PROVIDER_LIMITS[identity.configuration.provider].maxTtlSeconds,
    },
    { newId: () => sandboxId },
  );
}
