import type { OrchestratorDetail } from "@armada/core";
import type { Sql } from "@armada/core/server";
import { recordOrchestratorActivity } from "./orchestrator-activity.ts";
import { OrchestratorRuntime, type OrchestratorRuntimeOptions } from "./orchestrator-runtime.ts";
import type { OrchestratorRuntimeFoundation } from "./orchestrator-runtime-foundation.ts";
import { OrchestratorRuntimeStore, type RuntimeIdentity } from "./orchestrator-runtime-store.ts";

/** Actual #662 store/caller integration. One outer transaction encompasses producer event
 * cursor ACK plus lifecycle activity: a crash cannot advance history without its activity.
 * No producer source is copied and no callback silently upgrades native capability. */
export class LifecycleRuntimeStore extends OrchestratorRuntimeStore {
  constructor(
    private readonly lifecycleSql: Sql,
    private readonly reserveFoundation: OrchestratorRuntimeFoundation["reserveOperation"],
  ) {
    super(lifecycleSql, reserveFoundation);
  }
  private atomic<T>(work: (sql: Sql, store: OrchestratorRuntimeStore) => Promise<T>): Promise<T> {
    if (!this.lifecycleSql.transaction) throw new Error("Transactional runtime lifecycle integration required.");
    return this.lifecycleSql.transaction(async (tx) => {
      const scoped: Sql = { query: tx.query.bind(tx), transaction: async (next) => next(tx) };
      return work(scoped, new OrchestratorRuntimeStore(scoped, this.reserveFoundation));
    });
  }
  override create(input: Parameters<OrchestratorRuntimeStore["create"]>[0]) {
    return this.atomic(async (tx, store) => {
      const reservation = await store.create(input);
      const config = reservation.identity.configuration;
      await tx.query(
        `insert into public.orchestrator_lifecycle(orchestrator_id,idle_seconds,max_active_children)
        values($1,$2,$3) on conflict(orchestrator_id) do nothing`,
        [reservation.identity.id, config.idleSeconds ?? 7200, config.maxActiveChildren ?? null],
      );
      return reservation;
    });
  }
  override appendEvents(...args: Parameters<OrchestratorRuntimeStore["appendEvents"]>) {
    return this.atomic(async (tx, store) => {
      const accepted = await store.appendEvents(...args);
      if (!accepted) return false;
      const [identity, page] = args;
      if (!identity.sandboxId || !identity.providerSandboxId || identity.generation === null)
        throw new Error("Native event machine identity unavailable.");
      for (const event of page.events)
        await recordOrchestratorActivity(
          tx,
          {
            orchestratorId: identity.id,
            sandboxId: identity.sandboxId,
            providerSandboxId: identity.providerSandboxId,
            generation: String(identity.generation),
          },
          event,
        );
      return true;
    });
  }
  override complete(...args: Parameters<OrchestratorRuntimeStore["complete"]>) {
    return this.atomic(async (tx, store) => {
      const accepted = await store.complete(...args);
      if (!accepted) return false;
      const [reservation, result] = args;
      if (result.state === "succeeded" && result.parentState === "ready" && reservation.operation.kind === "resume")
        await tx.query(
          `update public.orchestrator_lifecycle set stop_operation_id=null,stop_generation=null,stop_physical_generation=null,stop_sandbox_id=null,
          stop_provider_sandbox_id=null,stop_reason=null,stop_dispatched=false,lease=null,lease_until=null,
          observation_state='unknown',observation_generation=null,observation_evidence=null,last_activity_at=clock_timestamp(),
          reconcile_after=clock_timestamp(),reason='native_resumed' where orchestrator_id=$1`,
          [reservation.identity.id],
        );

      if (result.state === "succeeded" && ["message", "steer"].includes(reservation.operation.kind))
        await tx.query(
          `update public.orchestrator_lifecycle set last_activity_at=clock_timestamp(),observation_state='unknown',
          reason='owner_message',reconcile_after=clock_timestamp() where orchestrator_id=$1`,
          [reservation.identity.id],
        );
      return true;
    });
  }
  override async read(
    ownerId: string,
    orgId: string,
    id: string,
    sql = this.lifecycleSql,
    lock = false,
  ): Promise<RuntimeIdentity> {
    const identity = await super.read(ownerId, orgId, id, sql, lock);
    const row = (
      await sql.query<{
        last_activity_at: Date | string;
        idle_seconds: number;
        max_active_children: number | null;
        observation_state: string;
        reason: string;
      }>(
        `select last_activity_at,idle_seconds,max_active_children,observation_state,reason from public.orchestrator_lifecycle where orchestrator_id=$1`,
        [id],
      )
    ).rows[0];
    if (!row) return identity;
    const last = new Date(row.last_activity_at);
    const configuration = { ...identity.configuration, idleSeconds: row.idle_seconds };
    if (row.max_active_children === null) delete configuration.maxActiveChildren;
    else configuration.maxActiveChildren = row.max_active_children;
    return {
      ...identity,
      configuration,
      lastActivityAt: last.toISOString(),
      idleDeadline:
        row.observation_state === "quiescent" ? new Date(last.getTime() + row.idle_seconds * 1000).toISOString() : null,
      blockedReason: identity.state === "blocked" ? (identity.blockedReason ?? row.reason) : identity.blockedReason,
    };
  }
}

export function lifecycleDetail(sql: Sql): NonNullable<OrchestratorRuntimeOptions["lifecycleDetail"]> {
  return async (ownerId, orgId, id) => {
    const visible = (
      await sql.query(
        `select o.id from public.orchestrators o join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
      where o.id=$1 and o.owner_id=$2 and o.org_id=$3`,
        [id, ownerId, orgId],
      )
    ).rows[0];
    if (!visible) throw new Error("No such orchestrator.");
    const waits = (
      await sql.query<{
        id: string;
        kind: "ci" | "child" | "external" | "task";
        reference: string;
        reason: string;
        expires_at: Date | string;
        deadline: Date | string;
      }>(
        `select id,kind,reference,reason,expires_at,deadline from public.orchestrator_waits where orchestrator_id=$1 and released_at is null order by created_at,id`,
        [id],
      )
    ).rows;
    const children = (
      await sql.query<{ sandbox_id: string }>(
        `select sandbox_id from public.orchestrator_children where orchestrator_id=$1 order by sandbox_id`,
        [id],
      )
    ).rows;
    const grant = (
      await sql.query<{
        id: string;
        scopes: NonNullable<OrchestratorDetail["delegation"]>["scopes"];
        expires_at: Date | string;
        revoked_at: Date | string | null;
      }>(
        `select d.id,d.scopes,d.expires_at,d.revoked_at from public.orchestrator_delegations d join public.orchestrators o on o.id=d.orchestrator_id
        where o.id=$1 and d.epoch=o.authority_epoch and d.acknowledged_at is not null order by d.expires_at desc limit 1`,
        [id],
      )
    ).rows[0];
    return {
      waits: waits.map((w) => ({
        id: w.id,
        orchestratorId: id,
        kind: w.kind,
        reference: w.reference,
        reason: w.reason,
        expiresAt: new Date(w.expires_at).toISOString(),
        deadline: new Date(w.deadline).toISOString(),
      })),
      childSandboxIds: children.map((c) => c.sandbox_id),
      delegation: grant
        ? {
            id: grant.id,
            orchestratorId: id,
            ownerId,
            orgId,
            scopes: grant.scopes,
            expiresAt: new Date(grant.expires_at).toISOString(),
            revokedAt: grant.revoked_at ? new Date(grant.revoked_at).toISOString() : null,
            childPolicy: "owned_children",
          }
        : null,
    };
  };
}

/** Real #662 shared HTTP/MCP caller, with actual #661 receipt producer. No live
 * backend default: caller must supply the reviewed native-proof-gated resolver. */
export function createLifecycleAwareOrchestratorRuntime(
  sql: Sql,
  options: Omit<OrchestratorRuntimeOptions, "store" | "lifecycleDetail"> & {
    reserveOperation: OrchestratorRuntimeFoundation["reserveOperation"];
  },
) {
  const store = new LifecycleRuntimeStore(sql, options.reserveOperation);
  return { store, runtime: new OrchestratorRuntime({ ...options, store, lifecycleDetail: lifecycleDetail(sql) }) };
}
