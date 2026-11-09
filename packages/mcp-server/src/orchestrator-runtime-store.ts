import { createHash } from "node:crypto";
import type {
  AgentEvent,
  OrchestratorContinuity,
  OrchestratorCreate,
  OrchestratorEventPage,
  OrchestratorOperation,
  OrchestratorState,
} from "@armada/core";
import type { Sql } from "@armada/core/server";
import type { OrchestratorRuntimeFoundation } from "./orchestrator-runtime-foundation.ts";

export class OrchestratorRuntimeError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "unavailable" | "invalid_request") {
    super(code);
  }
}
export interface RuntimeIdentity {
  id: string;
  orgId: string;
  ownerId: string;
  state: OrchestratorState;
  revision: number;
  sandboxId: string | null;
  providerSandboxId: string | null;
  generation: number | null;
  conversationId: string | null;
  configuration: OrchestratorCreate;
  skillRevision: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  idleDeadline: string | null;
  continuity: OrchestratorContinuity;
  blockedReason: string | null;
}
export interface RuntimeReservation {
  operation: OrchestratorOperation;
  identity: RuntimeIdentity;
  fresh: boolean;
}

/** Canonical JSON deliberately rejects exotic values rather than digesting lossy JSON. */
export function orchestratorRequestDigest(input: {
  actorId: string;
  orgId: string;
  action: string;
  target: string;
  payload: unknown;
}): string {
  function canonical(value: unknown): string {
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype) {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
        .join(",")}}`;
    }
    throw new OrchestratorRuntimeError("invalid_request");
  }
  return createHash("sha256").update(canonical(input)).digest("hex");
}

/** Exact configure/activity consumer signatures from actual #663 candidate v1. */
export interface RuntimeLifecycleHooks {
  /** Bound actual #663 v2 LifecycleRuntimeStore.complete; owns authoritative owner activity. */
  completeOwner?: OrchestratorRuntimeStore["complete"];
  configure(
    sql: Sql,
    input: {
      orchestratorId: string;
      ownerId: string;
      expectedRevision: number;
      idleSeconds: number;
      maxActiveChildren: number | null;
    },
  ): Promise<void>;
  recordActivity(
    sql: Sql,
    machine: { orchestratorId: string; sandboxId: string; providerSandboxId: string; generation: string },
    event: AgentEvent,
  ): Promise<boolean>;
}

/** Runtime storage extends, never replaces, #661's identity and receipt relations.
 * All external effects happen after a committed reservation; ambiguous COMMIT must
 * propagate and must never authorize an allocation or automatic replay. */
export class OrchestratorRuntimeStore {
  constructor(
    private readonly sql: Sql,
    private readonly reserveOrchestratorOperation: OrchestratorRuntimeFoundation["reserveOperation"],
    private readonly lifecycle?: RuntimeLifecycleHooks,
  ) {}

  private transaction<T>(work: (sql: Sql) => Promise<T>): Promise<T> {
    if (!this.sql.transaction) throw new OrchestratorRuntimeError("unavailable");
    return this.sql.transaction(work);
  }

  async read(ownerId: string, orgId: string, id: string, sql = this.sql, lock = false): Promise<RuntimeIdentity> {
    const result = await sql.query<{
      id: string;
      owner_id: string;
      org_id: string;
      state: OrchestratorState;
      revision: string | number;
      sandbox_id: string | null;
      provider_sandbox_id: string | null;
      lifecycle_generation: string | number | null;
      configuration: OrchestratorCreate;
      skill_revision: string;
      conversation_id: string | null;
      created_at: Date | string;
      updated_at: Date | string;
      last_activity_at: Date | string;
      idle_deadline: Date | string | null;
      continuity: OrchestratorContinuity;
      blocked_reason: string | null;
    }>(
      `select o.id,o.owner_id,o.org_id,o.state,o.revision,o.sandbox_id,s.provider_sandbox_id,s.lifecycle_generation,
      r.configuration,r.skill_revision,r.conversation_id,o.created_at,r.updated_at,r.last_activity_at,r.idle_deadline,r.continuity,r.blocked_reason from public.orchestrators o
      join public.orchestrator_runtime r on r.orchestrator_id=o.id
      join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
      left join public.sandboxes s on s.id=o.sandbox_id
      where o.id=$1 and o.owner_id=$2 and o.org_id=$3 ${lock ? "for update of o,m,r" : ""}`,
      [id, ownerId, orgId],
    );
    const row = result.rows[0];
    if (!row) throw new OrchestratorRuntimeError("not_found");
    if (lock && row.sandbox_id) {
      // The outer join cannot lock its nullable side. Lock and resample the exact
      // machine row before comparing generation; retain it through publication.
      const machine = await sql.query<{ lifecycle_generation: string | number; provider_sandbox_id: string }>(
        `select lifecycle_generation,provider_sandbox_id from public.sandboxes where id=$1 for update`,
        [row.sandbox_id],
      );
      const current = machine.rows[0];
      if (!current) throw new OrchestratorRuntimeError("conflict");
      row.lifecycle_generation = current.lifecycle_generation;
      row.provider_sandbox_id = current.provider_sandbox_id;
    }
    if (this.lifecycle) {
      // A read projection of actual209 state, not another inactivity/admission policy.
      const policy = (
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
      if (!policy) throw new OrchestratorRuntimeError("unavailable");
      row.last_activity_at = policy.last_activity_at;
      row.idle_deadline =
        policy.observation_state === "quiescent"
          ? new Date(new Date(policy.last_activity_at).getTime() + policy.idle_seconds * 1000)
          : null;
      row.blocked_reason = row.blocked_reason ?? (row.state === "blocked" ? policy.reason : null);
      const { maxActiveChildren: _oldLimit, ...configuration } = row.configuration;
      row.configuration = {
        ...configuration,
        idleSeconds: policy.idle_seconds,
        ...(policy.max_active_children === null ? {} : { maxActiveChildren: policy.max_active_children }),
      };
    }
    return {
      id: row.id,
      orgId: row.org_id,
      ownerId: row.owner_id,
      state: row.state,
      revision: Number(row.revision),
      sandboxId: row.sandbox_id,
      providerSandboxId: row.provider_sandbox_id,
      generation: row.lifecycle_generation === null ? null : Number(row.lifecycle_generation),
      configuration: row.configuration,
      skillRevision: row.skill_revision,
      conversationId: row.conversation_id,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      lastActivityAt: new Date(row.last_activity_at).toISOString(),
      idleDeadline: row.idle_deadline === null ? null : new Date(row.idle_deadline).toISOString(),
      continuity: row.continuity,
      blockedReason: row.blocked_reason,
    };
  }

  async create(input: {
    ownerId: string;
    configuration: OrchestratorCreate;
    key: string;
    skillRevision: string;
  }): Promise<RuntimeReservation> {
    const { ownerId, configuration, key, skillRevision } = input;
    const digest = orchestratorRequestDigest({
      actorId: ownerId,
      orgId: configuration.orgId,
      action: "create",
      target: "create",
      payload: { configuration, skillRevision },
    });
    return this.transaction(async (tx) => {
      // The membership lock serializes create-key discovery before identity allocation.
      const member = await tx.query(`select user_id from public.members where user_id=$1 and org_id=$2 for update`, [
        ownerId,
        configuration.orgId,
      ]);
      if (!member.rows.length) throw new OrchestratorRuntimeError("not_found");
      const prior = await tx.query<{ orchestrator_id: string; request_digest: string }>(
        `select orchestrator_id,request_digest from public.orchestrator_runtime_create_keys where owner_id=$1 and org_id=$2 and idempotency_key=$3`,
        [ownerId, configuration.orgId, key],
      );
      const old = prior.rows[0];
      if (old && old.request_digest !== digest) throw new OrchestratorRuntimeError("conflict");
      const id = old?.orchestrator_id ?? crypto.randomUUID();
      if (!old) {
        await tx.query(`insert into public.orchestrators(id,org_id,owner_id) values($1,$2,$3)`, [
          id,
          configuration.orgId,
          ownerId,
        ]);
        await tx.query(
          `insert into public.orchestrator_runtime(orchestrator_id,configuration,skill_revision) values($1,$2::jsonb,$3)`,
          [id, JSON.stringify(configuration), skillRevision],
        );
        await tx.query(
          `insert into public.orchestrator_runtime_create_keys(owner_id,org_id,idempotency_key,request_digest,orchestrator_id) values($1,$2,$3,$4,$5)`,
          [ownerId, configuration.orgId, key, digest, id],
        );
      }
      if (!old && this.lifecycle) {
        await this.lifecycle.configure(
          { query: tx.query.bind(tx), transaction: async (work) => work(tx) },
          {
            orchestratorId: id,
            ownerId,
            expectedRevision: 0,
            idleSeconds: configuration.idleSeconds ?? 7200,
            maxActiveChildren: configuration.maxActiveChildren ?? null,
          },
        );
      }
      const currentRevision = (
        await tx.query<{ revision: string | number }>(`select revision from public.orchestrators where id=$1`, [id])
      ).rows[0];
      if (!currentRevision) throw new OrchestratorRuntimeError("conflict");
      const receipt = await this.reserveOrchestratorOperation(
        { query: tx.query.bind(tx), transaction: async (work) => work(tx) },
        {
          orchestratorId: id,
          actorId: ownerId,
          action: "create",
          key,
          digest,
          expectedRevision: Number(currentRevision.revision),
        },
      );
      const identity = await this.read(ownerId, configuration.orgId, id, tx);
      const persisted = await tx.query<{ error_code: string | null }>(
        `select error_code from public.orchestrator_operations where id=$1`,
        [receipt.id],
      );
      return {
        identity,
        fresh: !old,
        operation: {
          version: 1,
          id: receipt.id,
          orchestratorId: id,
          kind: "create",
          state: receipt.state as OrchestratorOperation["state"],
          revision: receipt.revision,
          errorCode: persisted.rows[0]?.error_code ?? null,
        },
      };
    });
  }

  async list(
    ownerId: string,
    orgId: string,
    cursor?: string,
    limit = 20,
  ): Promise<{ items: RuntimeIdentity[]; cursor: string | null }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new OrchestratorRuntimeError("invalid_request");
    let after: string | null = null;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (
          decoded.ownerId !== ownerId ||
          decoded.orgId !== orgId ||
          typeof decoded.after !== "string" ||
          !/^[a-f0-9-]{36}$/.test(decoded.after)
        )
          throw Error();
        after = decoded.after;
      } catch {
        throw new OrchestratorRuntimeError("invalid_request");
      }
    }
    const rows = await this.sql.query<{ id: string }>(
      `select o.id from public.orchestrators o join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id where o.owner_id=$1 and o.org_id=$2 and ($3::uuid is null or o.id>$3::uuid) order by o.id limit $4`,
      [ownerId, orgId, after, limit + 1],
    );
    const page = rows.rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: await Promise.all(page.map(({ id }) => this.read(ownerId, orgId, id))),
      cursor:
        rows.rows.length > limit && last
          ? Buffer.from(JSON.stringify({ ownerId, orgId, after: last.id })).toString("base64url")
          : null,
    };
  }

  async events(
    ownerId: string,
    orgId: string,
    id: string,
    cursor?: string,
    limit = 100,
  ): Promise<OrchestratorEventPage> {
    await this.read(ownerId, orgId, id);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new OrchestratorRuntimeError("invalid_request");
    let after = "0";
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (
          decoded.ownerId !== ownerId ||
          decoded.orgId !== orgId ||
          decoded.id !== id ||
          !/^[0-9]+$/.test(decoded.after)
        )
          throw Error();
        after = decoded.after;
      } catch {
        throw new OrchestratorRuntimeError("invalid_request");
      }
    }
    const result = await this.sql.query<{
      sequence: string | number;
      event: { kind: "agent"; event: AgentEvent } | { kind: "operation"; operation: OrchestratorOperation };
      revision: number | string;
      created_at: Date | string;
    }>(
      `select sequence,event,revision,created_at from public.orchestrator_runtime_events where orchestrator_id=$1 and sequence>$2 order by sequence limit $3`,
      [id, after, limit + 1],
    );
    const page = result.rows.slice(0, limit);
    const last = page.at(-1);
    return {
      version: 1,
      events: page.map((row) => ({
        ...row.event,
        id: String(row.sequence),
        orchestratorId: id,
        at: new Date(row.created_at).toISOString(),
        revision: Number(row.revision),
      })),
      cursor: Buffer.from(JSON.stringify({ ownerId, orgId, id, after: last ? String(last.sequence) : after })).toString(
        "base64url",
      ),
      hasMore: result.rows.length > limit,
    };
  }

  async operations(ownerId: string, orgId: string, id: string): Promise<OrchestratorOperation[]> {
    await this.read(ownerId, orgId, id);
    const rows = await this.sql.query<{
      id: string;
      action: OrchestratorOperation["kind"];
      state: OrchestratorOperation["state"];
      revision: string | number;
      error_code: string | null;
    }>(
      `select p.id,p.action,p.state,p.revision,p.error_code from public.orchestrator_operations p
       join public.orchestrators o on o.id=p.orchestrator_id join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
       where o.id=$1 and o.owner_id=$2 and o.org_id=$3 order by p.revision`,
      [id, ownerId, orgId],
    );
    return rows.rows.map((row) => ({
      version: 1,
      id: row.id,
      orchestratorId: id,
      kind: row.action,
      state: row.state,
      revision: Number(row.revision),
      errorCode: row.error_code,
    }));
  }

  async providerCursor(identity: RuntimeIdentity): Promise<string | null> {
    await this.read(identity.ownerId, identity.orgId, identity.id);
    const result = await this.sql.query<{ provider_cursor: string | null }>(
      `select r.provider_cursor from public.orchestrator_runtime r
      join public.orchestrators o on o.id=r.orchestrator_id join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
      where o.id=$1 and o.owner_id=$2 and o.org_id=$3`,
      [identity.id, identity.ownerId, identity.orgId],
    );
    if (!result.rows[0]) throw new OrchestratorRuntimeError("not_found");
    return result.rows[0].provider_cursor;
  }

  async appendEvents(
    identity: RuntimeIdentity,
    page: { events: AgentEvent[]; cursor?: string },
    expectedCursor: string | null,
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      const current = await this.read(identity.ownerId, identity.orgId, identity.id, tx, true);
      if (
        current.revision !== identity.revision ||
        current.generation !== identity.generation ||
        current.conversationId !== identity.conversationId
      )
        return false;
      const cursor = await tx.query<{ provider_cursor: string | null }>(
        `select provider_cursor from public.orchestrator_runtime where orchestrator_id=$1`,
        [identity.id],
      );
      if (cursor.rows[0]?.provider_cursor !== expectedCursor) return false;
      for (const event of page.events) {
        if (!identity.conversationId || event.conversationId !== identity.conversationId)
          throw new OrchestratorRuntimeError("conflict");
        await tx.query(
          `insert into public.orchestrator_runtime_events(orchestrator_id,revision,generation,conversation_id,upstream_id,event)
          values($1,$2,$3,$4,$5,$6::jsonb) on conflict(orchestrator_id,generation,conversation_id,upstream_id) do nothing`,
          [
            identity.id,
            identity.revision,
            identity.generation,
            identity.conversationId,
            event.id,
            JSON.stringify({ kind: "agent", event }),
          ],
        );
      }
      if (this.lifecycle && identity.sandboxId && identity.providerSandboxId && identity.generation !== null) {
        const scoped: Sql = { query: tx.query.bind(tx), transaction: async (work) => work(tx) };
        for (const event of page.events)
          await this.lifecycle.recordActivity(
            scoped,
            {
              orchestratorId: identity.id,
              sandboxId: identity.sandboxId,
              providerSandboxId: identity.providerSandboxId,
              generation: String(identity.generation),
            },
            event,
          );
      }
      // Cursor moves only in the transaction which durably mirrored every event.
      await tx.query(`update public.orchestrator_runtime set provider_cursor=$2 where orchestrator_id=$1`, [
        identity.id,
        page.cursor ?? expectedCursor,
      ]);
      return true;
    });
  }

  async reserve(input: {
    ownerId: string;
    orgId: string;
    id: string;
    action: OrchestratorOperation["kind"];
    key: string;
    expectedRevision: number;
    payload: unknown;
  }): Promise<RuntimeReservation> {
    const digest = orchestratorRequestDigest({
      actorId: input.ownerId,
      orgId: input.orgId,
      action: input.action,
      target: input.id,
      payload: input.payload,
    });
    return this.transaction(async (tx) => {
      const identity = await this.read(input.ownerId, input.orgId, input.id, tx, true);
      const prior = await tx.query<{
        id: string;
        state: OrchestratorOperation["state"];
        revision: string | number;
        request_digest: string;
        error_code: string | null;
      }>(
        `select id,state,revision,request_digest,error_code from public.orchestrator_operations
         where orchestrator_id=$1 and actor_id=$2 and action=$3 and idempotency_key=$4`,
        [input.id, input.ownerId, input.action, input.key],
      );
      const existing = prior.rows[0];
      if (existing) {
        if (existing.request_digest !== digest) throw new OrchestratorRuntimeError("conflict");
        return {
          identity,
          fresh: false,
          operation: {
            version: 1,
            id: existing.id,
            orchestratorId: input.id,
            kind: input.action,
            state: existing.state,
            revision: Number(existing.revision),
            errorCode: existing.error_code,
          },
        };
      }
      const busy = await tx.query(
        `select id from public.orchestrator_operations where orchestrator_id=$1 and state in ('pending','uncertain')`,
        [input.id],
      );
      if (busy.rows.length || identity.revision !== input.expectedRevision)
        throw new OrchestratorRuntimeError("conflict");
      // Foundation owns reservation; reuse the surrounding locked transaction, no nested COMMIT.
      const receipt = await this.reserveOrchestratorOperation(
        { ...tx, query: tx.query.bind(tx), transaction: async (work) => work(tx) },
        {
          orchestratorId: input.id,
          actorId: input.ownerId,
          action: input.action,
          key: input.key,
          digest,
          expectedRevision: input.expectedRevision,
        },
      );
      if (input.action === "stop")
        await tx.query(`update public.orchestrators set state='stopping' where id=$1`, [input.id]);
      if (input.action === "resume" && identity.state === "stopped")
        await tx.query(`update public.orchestrators set state='resuming' where id=$1`, [input.id]);
      return {
        identity: { ...identity, revision: receipt.revision },
        fresh: true,
        operation: {
          version: 1,
          id: receipt.id,
          orchestratorId: input.id,
          kind: input.action,
          state: receipt.state as OrchestratorOperation["state"],
          revision: receipt.revision,
          errorCode: null,
        },
      };
    });
  }

  async preparing(reservation: RuntimeReservation): Promise<RuntimeIdentity> {
    return this.transaction(async (tx) => {
      const identity = await this.read(
        reservation.identity.ownerId,
        reservation.identity.orgId,
        reservation.identity.id,
        tx,
        true,
      );
      if (identity.revision !== reservation.operation.revision || !identity.sandboxId)
        throw new OrchestratorRuntimeError("conflict");
      await tx.query(`update public.orchestrators set state='ready' where id=$1`, [identity.id]);
      return { ...identity, state: "ready" };
    });
  }

  /** Publication checks logical revision AND physical generation under the owner/member lock. */
  async complete(
    reservation: RuntimeReservation,
    result: {
      state: OrchestratorOperation["state"];
      parentState?: OrchestratorState;
      conversationId?: string;
      errorCode?: string;
      continuity?: OrchestratorContinuity;
    },
  ): Promise<boolean> {
    if (this.lifecycle?.completeOwner && ["message", "steer"].includes(reservation.operation.kind))
      return this.lifecycle.completeOwner(reservation, result);
    return this.transaction(async (tx) => {
      const { identity, operation } = reservation;
      let current: RuntimeIdentity;
      try {
        current = await this.read(identity.ownerId, identity.orgId, identity.id, tx, true);
      } catch (error) {
        if (error instanceof OrchestratorRuntimeError && error.code === "not_found") return false;
        throw error;
      }
      if (current.revision !== operation.revision || current.generation !== identity.generation) return false;
      if (current.conversationId && result.conversationId && current.conversationId !== result.conversationId)
        return false;
      const updated = await tx.query(
        `update public.orchestrator_operations set state=$2,error_code=$3
        where id=$1 and state='pending' returning id`,
        [operation.id, result.state, result.errorCode ?? null],
      );
      if (!updated.rows.length) return false;
      if (result.parentState)
        await tx.query(`update public.orchestrators set state=$2 where id=$1`, [identity.id, result.parentState]);
      await tx.query(
        `update public.orchestrator_runtime set updated_at=now(),blocked_reason=$2,
        last_activity_at=case when $3 then now() else last_activity_at end,
        continuity=case when $5::text is not null then $5 when $4 then 'unverified' else continuity end where orchestrator_id=$1`,
        [
          identity.id,
          result.errorCode ?? null,
          result.state === "succeeded" && ["message", "steer"].includes(operation.kind),
          !!result.conversationId && current.continuity === "not_started",
          result.continuity ?? null,
        ],
      );
      if (result.conversationId)
        await tx.query(`update public.orchestrator_runtime set conversation_id=$2 where orchestrator_id=$1`, [
          identity.id,
          result.conversationId,
        ]);
      await tx.query(
        `insert into public.orchestrator_runtime_events(orchestrator_id,revision,event)
        values($1,$2,$3::jsonb)`,
        [
          identity.id,
          operation.revision,
          JSON.stringify({
            kind: "operation",
            operation: { ...operation, state: result.state, errorCode: result.errorCode ?? null },
          }),
        ],
      );
      return true;
    });
  }
}
