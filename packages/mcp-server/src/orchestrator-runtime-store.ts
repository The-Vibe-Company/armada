import { createHash } from "node:crypto";
import type {
  AgentEvent,
  OrchestratorContinuity,
  OrchestratorCreate,
  OrchestratorEventPage,
  OrchestratorOperation,
  OrchestratorState,
  PromptStatus,
} from "@armada/core";
import { boundEventEntries, coalesceEventMessages, truncateEvent } from "@armada/core";
import type { Sql } from "@armada/core/server";
import type { OrchestratorRuntimeFoundation } from "./orchestrator-runtime-foundation.ts";

export class OrchestratorRuntimeError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "unavailable" | "invalid_request",
    readonly admission?: "not_admitted" | "unknown",
    readonly operation?: OrchestratorOperation,
  ) {
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
  skillReceipt?: import("@armada/core").OrchestratorSkillReceipt | null;
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
  createDispatchId?: string;
  createForkDispatched?: boolean;
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
      skill_receipt: import("@armada/core").OrchestratorSkillReceipt | null;
      conversation_id: string | null;
      created_at: Date | string;
      updated_at: Date | string;
      last_activity_at: Date | string;
      idle_deadline: Date | string | null;
      continuity: OrchestratorContinuity;
      blocked_reason: string | null;
    }>(
      `select o.id,o.owner_id,o.org_id,o.state,o.revision,o.sandbox_id,s.provider_sandbox_id,s.lifecycle_generation,
      r.configuration,r.skill_revision,r.skill_receipt,r.conversation_id,o.created_at,r.updated_at,r.last_activity_at,r.idle_deadline,r.continuity,r.blocked_reason from public.orchestrators o
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
      skillReceipt: row.skill_receipt,
      conversationId: row.conversation_id,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      lastActivityAt: new Date(row.last_activity_at).toISOString(),
      idleDeadline: row.idle_deadline === null ? null : new Date(row.idle_deadline).toISOString(),
      continuity: row.continuity,
      blockedReason: row.blocked_reason,
    };
  }

  async recordSkillReceipt(
    identity: RuntimeIdentity,
    receipt: import("@armada/core").OrchestratorSkillReceipt | null,
  ): Promise<void> {
    const result = await this.sql.query(
      `update public.orchestrator_runtime set skill_receipt=$1::jsonb where orchestrator_id=$2 and exists(select 1 from public.orchestrators o where o.id=$2 and o.revision=$3) returning orchestrator_id`,
      [JSON.stringify(receipt), identity.id, identity.revision],
    );
    if (!result.rows.length) throw new OrchestratorRuntimeError("unavailable");
  }

  async create(input: {
    ownerId: string;
    configuration: OrchestratorCreate;
    key: string;
    skillRevision: string;
    queued?: true;
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
      if (old && old.request_digest !== digest) throw new OrchestratorRuntimeError("conflict", "not_admitted");
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
      if (!old && input.queued)
        await tx.query(`update public.orchestrator_operations set runtime_result=$2::jsonb where id=$1`, [
          receipt.id,
          JSON.stringify({ version: 1, kind: "create_job", stage: "queued" }),
        ]);
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
    options: { direction?: "forward" | "backward"; maxBytes?: number; coalesce?: boolean } = {},
  ): Promise<OrchestratorEventPage> {
    await this.read(ownerId, orgId, id);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new OrchestratorRuntimeError("invalid_request");
    const backward = options.direction === "backward";
    let after = backward ? "9223372036854775807" : "0";
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
      `select sequence,event,revision,created_at from public.orchestrator_runtime_events where orchestrator_id=$1 and sequence${backward ? "<" : ">"}$2 order by sequence ${backward ? "desc" : "asc"} limit $3`,
      [id, after, limit + 1],
    );
    const encode = (after: string) => Buffer.from(JSON.stringify({ ownerId, orgId, id, after })).toString("base64url");
    const page = boundEventEntries<OrchestratorEventPage["events"][number]>(
      result.rows.map((row) => ({
        cursor: encode(String(row.sequence)),
        event: {
          ...row.event,
          id: String(row.sequence),
          orchestratorId: id,
          at: new Date(row.created_at).toISOString(),
          revision: Number(row.revision),
        },
      })),
      { ...options, limit, ...(cursor ? { cursor } : {}) },
      result.rows.length > limit,
      "orchestrator",
      (events) => {
        const merged: typeof events = [];
        for (const event of events) {
          const previous = merged.at(-1);
          if (event.kind === "agent" && previous?.kind === "agent") {
            const pair = coalesceEventMessages([previous.event, event.event]);
            if (pair.length === 1) {
              merged[merged.length - 1] = { ...event, event: pair[0]! };
              continue;
            }
          }
          merged.push(event);
        }
        return merged;
      },
      (event, originalBytes) =>
        event.kind === "agent"
          ? { ...event, event: truncateEvent(event.event, originalBytes) }
          : {
              id: event.id,
              orchestratorId: event.orchestratorId,
              at: event.at,
              revision: event.revision,
              kind: "agent",
              event: truncateEvent(
                { id: event.id, at: Date.parse(event.at), kind: "other", type: "oversized", data: null },
                originalBytes,
                event.kind,
              ),
            },
    );
    return { version: 1, ...page, cursor: page.cursor ?? (backward ? null : encode(after)) };
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
          select $1,$2,$3,$4,$5,$6::jsonb where not exists (select 1 from public.orchestrator_runtime_events where orchestrator_id=$1 and conversation_id=$4 and upstream_id=$5) on conflict(orchestrator_id,generation,conversation_id,upstream_id) do nothing`,
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

  /** Read-only correlation of an exact owner request. Absence is UNKNOWN, never
   * proof that an in-flight transaction did not admit it. No provider/account lookup. */
  async lookupRequest(input: {
    ownerId: string;
    orgId: string;
    key: string;
    action: OrchestratorOperation["kind"];
    id?: string;
    payload?: unknown;
    configuration?: OrchestratorCreate;
  }): Promise<OrchestratorOperation | null> {
    let id = input.id;
    let digest: string;
    if (input.action === "create") {
      const member = await this.sql.query(`select user_id from public.members where user_id=$1 and org_id=$2`, [
        input.ownerId,
        input.orgId,
      ]);
      if (!member.rows.length) throw new OrchestratorRuntimeError("not_found");
      const prior = (
        await this.sql.query<{ orchestrator_id: string }>(
          `select orchestrator_id from public.orchestrator_runtime_create_keys where owner_id=$1 and org_id=$2 and idempotency_key=$3`,
          [input.ownerId, input.orgId, input.key],
        )
      ).rows[0];
      if (!prior) return null;
      id = prior.orchestrator_id;
      const identity = await this.read(input.ownerId, input.orgId, id);
      digest = orchestratorRequestDigest({
        actorId: input.ownerId,
        orgId: input.orgId,
        action: "create",
        target: "create",
        payload: { configuration: input.configuration, skillRevision: identity.skillRevision },
      });
    } else {
      if (!id) throw new OrchestratorRuntimeError("invalid_request");
      await this.read(input.ownerId, input.orgId, id);
      digest = orchestratorRequestDigest({
        actorId: input.ownerId,
        orgId: input.orgId,
        action: input.action,
        target: id,
        payload: input.payload,
      });
    }
    const row = (
      await this.sql.query<{
        id: string;
        action: OrchestratorOperation["kind"];
        state: OrchestratorOperation["state"];
        revision: number | string;
        request_digest: string;
        error_code: string | null;
      }>(
        `select p.id,p.action,p.state,p.revision,p.request_digest,p.error_code from public.orchestrator_operations p
      join public.orchestrators o on o.id=p.orchestrator_id
      join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
      where o.id=$1 and o.owner_id=$2 and o.org_id=$3 and p.actor_id=$2 and p.action=$4 and p.idempotency_key=$5`,
        [id, input.ownerId, input.orgId, input.action, input.key],
      )
    ).rows[0];
    if (!row) return null;
    if (row.request_digest !== digest) throw new OrchestratorRuntimeError("conflict", "not_admitted");
    return {
      version: 1,
      id: row.id,
      orchestratorId: id!,
      kind: row.action,
      state: row.state,
      revision: Number(row.revision),
      errorCode: row.error_code,
    };
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
        if (existing.request_digest !== digest) throw new OrchestratorRuntimeError("conflict", "not_admitted");
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
      if (["message", "steer"].includes(input.action) && identity.state !== "ready")
        throw new OrchestratorRuntimeError("conflict", "not_admitted");
      if (busy.rows.length || identity.revision !== input.expectedRevision)
        throw new OrchestratorRuntimeError("conflict", "not_admitted");
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

  /** A queued admission is the ONLY automatically dispatchable create. Legacy or
   * previously dispatched pending receipts are never turned into another fork. */
  async claimCreateJob(): Promise<RuntimeReservation | null> {
    return this.transaction(async (tx) => {
      const next = (
        await tx.query<{
          id: string;
          orchestrator_id: string;
          owner_id: string;
          org_id: string;
          revision: number | string;
        }>(
          `select p.id,p.orchestrator_id,o.owner_id,o.org_id,p.revision from public.orchestrator_operations p
         join public.orchestrators o on o.id=p.orchestrator_id join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
         where p.action='create' and p.state='pending' and p.runtime_result->>'kind'='create_job' and p.runtime_result->>'version'='1'
         and p.runtime_result->>'stage'='queued' and o.revision=p.revision and o.state='creating' and o.sandbox_id is null
         order by o.created_at,p.id for update of p,o,m skip locked limit 1`,
        )
      ).rows[0];
      if (!next) return null;
      const dispatchId = crypto.randomUUID();
      await tx.query(
        `update public.orchestrator_operations set runtime_result=jsonb_build_object('version',1,'kind','create_job','stage','running','dispatchId',$2::text,'leaseUntil',clock_timestamp()+interval '2 minutes') where id=$1`,
        [next.id, dispatchId],
      );
      const identity = await this.read(next.owner_id, next.org_id, next.orchestrator_id, tx);
      return {
        identity,
        fresh: true,
        createDispatchId: dispatchId,
        createForkDispatched: false,
        operation: {
          version: 1,
          id: next.id,
          orchestratorId: next.orchestrator_id,
          kind: "create",
          state: "pending",
          revision: Number(next.revision),
          errorCode: null,
        },
      };
    });
  }

  async assertCreateCurrent(reservation: RuntimeReservation, sql: Sql = this.sql, lock = false): Promise<void> {
    const i = reservation.identity;
    const row = await sql.query(
      `select p.id from public.orchestrator_operations p join public.orchestrators o on o.id=p.orchestrator_id
      join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id left join public.sandboxes s on s.id=o.sandbox_id
      where p.id=$1 and p.action='create' and p.actor_id=$2 and o.owner_id=$2 and o.org_id=$3 and o.id=$4 and o.revision=$5
      and o.state in ('creating','ready') and p.state='pending' and p.runtime_result->>'kind'='create_job' and p.runtime_result->>'dispatchId'=$6
      and ((o.sandbox_id is null and $7::uuid is null) or (s.id=$7 and s.provider_sandbox_id=$8 and s.lifecycle_generation=$9)) ${lock ? "for update of o,p,m" : ""}`,
      [
        reservation.operation.id,
        i.ownerId,
        i.orgId,
        i.id,
        reservation.operation.revision,
        reservation.createDispatchId ?? null,
        i.sandboxId,
        i.providerSandboxId,
        i.generation,
      ],
    );
    if (row.rows.length !== 1) throw new OrchestratorRuntimeError("conflict");
  }

  async dispatchCreateFork(reservation: RuntimeReservation, sandboxId: string): Promise<void> {
    await this.transaction(async (tx) => {
      await this.assertCreateCurrent(reservation, tx, true);
      const row = await tx.query(
        `update public.orchestrator_operations set runtime_result=runtime_result || jsonb_build_object('stage','fork_dispatched','intendedSandboxId',$3::text)
        where id=$1 and runtime_result->>'dispatchId'=$2 and runtime_result->>'stage'='running' returning id`,
        [reservation.operation.id, reservation.createDispatchId ?? null, sandboxId],
      );
      if (row.rows.length !== 1) throw new OrchestratorRuntimeError("conflict");
    });
    reservation.createForkDispatched = true;
  }

  /** Called only after registration COMMIT is positively acknowledged. The caller
   * supplies that INSERT's saved row, never an error-path read of a newer machine. */
  async registeredCreate(
    reservation: RuntimeReservation,
    saved: import("@armada/core").SandboxRecord & { lifecycleGeneration: number },
  ): Promise<void> {
    const i = reservation.identity;
    if (
      saved.ownerId !== i.ownerId ||
      saved.orgId !== i.orgId ||
      saved.goldenId !== i.configuration.goldenId ||
      saved.provider !== i.configuration.provider ||
      saved.harness !== i.configuration.harness ||
      saved.credentialId !== i.configuration.modelAccountId ||
      saved.conversationIds.length !== 0 ||
      !Number.isSafeInteger(saved.lifecycleGeneration) ||
      saved.lifecycleGeneration < 1 ||
      (i.sandboxId !== null && i.sandboxId !== saved.id)
    )
      throw new OrchestratorRuntimeError("conflict");
    reservation.identity = {
      ...i,
      sandboxId: saved.id,
      providerSandboxId: saved.providerSandboxId,
      generation: saved.lifecycleGeneration,
    };
    await this.transaction(async (tx) => {
      await this.assertCreateCurrent(reservation, tx, true);
      const updated = await tx.query(
        `update public.orchestrator_operations set runtime_result=runtime_result || jsonb_build_object('stage','registered','binding',$3::jsonb)
        where id=$1 and runtime_result->>'dispatchId'=$2 and runtime_result->>'intendedSandboxId'=$4 and runtime_result->>'stage' in ('fork_dispatched','registered') returning id`,
        [
          reservation.operation.id,
          reservation.createDispatchId ?? null,
          JSON.stringify({
            sandboxId: saved.id,
            providerSandboxId: saved.providerSandboxId,
            generation: saved.lifecycleGeneration,
          }),
          saved.id,
        ],
      );
      if (updated.rows.length !== 1) throw new OrchestratorRuntimeError("conflict");
    });
  }

  async renewCreateJob(reservation: RuntimeReservation): Promise<void> {
    await this.sql.query(
      `update public.orchestrator_operations p set runtime_result=jsonb_set(p.runtime_result,'{leaseUntil}',to_jsonb(clock_timestamp()+interval '2 minutes'))
      from public.orchestrators o where p.id=$1 and p.runtime_result->>'dispatchId'=$2 and p.state='pending' and o.id=p.orchestrator_id and o.revision=p.revision`,
      [reservation.operation.id, reservation.createDispatchId ?? null],
    );
  }

  /** Local positive control-flow proof: the worker never passed the fork fence.
   * This may fail a request, not publish native success or adopt a machine. */
  async failCreateBeforeFork(reservation: RuntimeReservation): Promise<boolean> {
    return this.transaction(async (tx) => {
      const row = await tx.query(
        `update public.orchestrator_operations p set state='failed',error_code='create_preallocation_failed',runtime_result=p.runtime_result || '{"stage":"settled","noFork":true}'::jsonb
        from public.orchestrators o where p.id=$1 and p.runtime_result->>'dispatchId'=$2 and p.state='pending' and o.id=p.orchestrator_id
        and o.revision=p.revision and o.sandbox_id is null and p.runtime_result->>'stage' in ('running','fork_dispatched') returning p.orchestrator_id,p.revision`,
        [reservation.operation.id, reservation.createDispatchId ?? null],
      );
      if (!row.rows.length) return false;
      await tx.query(`update public.orchestrators set state='blocked' where id=$1 and revision=$2`, [
        reservation.identity.id,
        reservation.operation.revision,
      ]);
      await tx.query(
        `update public.orchestrator_runtime set blocked_reason='create_preallocation_failed',updated_at=now() where orchestrator_id=$1`,
        [reservation.identity.id],
      );
      await tx.query(
        `insert into public.orchestrator_runtime_events(orchestrator_id,revision,event) values($1,$2,$3::jsonb)`,
        [
          reservation.identity.id,
          reservation.operation.revision,
          JSON.stringify({
            kind: "operation",
            operation: { ...reservation.operation, state: "failed", errorCode: "create_preallocation_failed" },
          }),
        ],
      );
      return true;
    });
  }

  /** A known execution/publication failure may settle only its own ledger as
   * uncertain. It grants no parent/machine generation publication permission. */
  async markCreateUncertain(reservation: RuntimeReservation): Promise<void> {
    await this.transaction(async (tx) => {
      const row = await tx.query(
        `select p.id from public.orchestrators o join public.orchestrator_operations p on p.orchestrator_id=o.id
        where p.id=$1 and p.state='pending' and p.action='create' and p.runtime_result->>'kind'='create_job' and p.runtime_result->>'dispatchId'=$2 for update of o,p`,
        [reservation.operation.id, reservation.createDispatchId ?? null],
      );
      if (!row.rows.length) return;
      await tx.query(
        `update public.orchestrator_operations set state='uncertain',error_code='create_publication_fenced' where id=$1`,
        [reservation.operation.id],
      );
      const i = reservation.identity;
      await tx.query(
        `update public.orchestrators o set state='blocked' where o.id=$1 and o.revision=$2 and
        ((o.sandbox_id is null and $3::uuid is null) or exists(select 1 from public.sandboxes s where s.id=o.sandbox_id and s.id=$3 and s.provider_sandbox_id=$4 and s.lifecycle_generation=$5))`,
        [i.id, reservation.operation.revision, i.sandboxId, i.providerSandboxId, i.generation],
      );
    });
  }

  /** Revocation of queued, never-dispatched intent is positive no-fork proof.
   * Legacy or dispatched work cannot take this preallocation-failure path. */
  async failRevokedQueuedCreate(): Promise<OrchestratorOperation | null> {
    return this.transaction(async (tx) => {
      const row = (
        await tx.query<{ id: string; orchestrator_id: string; revision: number | string }>(
          `select p.id,p.orchestrator_id,p.revision from public.orchestrators o join public.orchestrator_operations p on p.orchestrator_id=o.id
         where p.action='create' and p.state='pending' and p.runtime_result->>'kind'='create_job' and p.runtime_result->>'version'='1' and p.runtime_result->>'stage'='queued'
         and not (p.runtime_result ? 'dispatchId') and not (p.runtime_result ? 'intendedSandboxId') and o.sandbox_id is null and o.revision=p.revision
         and not exists(select 1 from public.members m where m.org_id=o.org_id and m.user_id=o.owner_id) order by p.id for update of o,p skip locked limit 1`,
        )
      ).rows[0];
      if (!row) return null;
      const operation: OrchestratorOperation = {
        version: 1,
        id: row.id,
        orchestratorId: row.orchestrator_id,
        kind: "create",
        state: "failed",
        revision: Number(row.revision),
        errorCode: "create_authority_revoked",
      };
      await tx.query(
        `update public.orchestrator_operations set state='failed',error_code='create_authority_revoked',runtime_result=runtime_result || '{"stage":"settled","noFork":true}'::jsonb where id=$1`,
        [row.id],
      );
      await tx.query(
        `update public.orchestrators set state='blocked' where id=$1 and revision=$2 and sandbox_id is null`,
        [row.orchestrator_id, row.revision],
      );
      await tx.query(
        `update public.orchestrator_runtime set blocked_reason='create_authority_revoked',updated_at=now() where orchestrator_id=$1`,
        [row.orchestrator_id],
      );
      await tx.query(
        `insert into public.orchestrator_runtime_events(orchestrator_id,revision,event) values($1,$2,$3::jsonb),($1,$2,$4::jsonb)`,
        [
          row.orchestrator_id,
          row.revision,
          JSON.stringify({ kind: "operation", operation }),
          JSON.stringify({ kind: "state", state: "blocked", continuity: "not_started" }),
        ],
      );
      return operation;
    });
  }

  /** A crashed/expired dispatcher is observation-only uncertainty. Never retry its
   * fork or classify it failed merely because time passed. Untagged legacy rows
   * are intentionally recovery-only, not executable queue entries. */
  async reconcileExpiredCreateJob(): Promise<OrchestratorOperation | null> {
    return this.transaction(async (tx) => {
      const row = (
        await tx.query<{
          id: string;
          orchestrator_id: string;
          revision: number | string;
          runtime_result: { binding?: { sandboxId: string; providerSandboxId: string; generation: number } };
        }>(
          `select p.id,p.orchestrator_id,p.revision,p.runtime_result from public.orchestrator_operations p
         where p.action='create' and p.state='pending' and p.runtime_result->>'kind'='create_job' and p.runtime_result->>'version'='1' and p.runtime_result->>'stage' in ('running','fork_dispatched','registered')
         and (p.runtime_result->>'leaseUntil')::timestamptz<clock_timestamp() order by p.id for update skip locked limit 1`,
        )
      ).rows[0];
      if (!row) return null;
      await tx.query(
        `update public.orchestrator_operations set state='uncertain',error_code='create_worker_interrupted' where id=$1`,
        [row.id],
      );
      const b = row.runtime_result.binding;
      await tx.query(
        `update public.orchestrators o set state='blocked' where o.id=$1 and o.revision=$2 and
        ((o.sandbox_id is null and $3::uuid is null) or exists(select 1 from public.sandboxes s where s.id=o.sandbox_id and s.id=$3 and s.provider_sandbox_id=$4 and s.lifecycle_generation=$5))`,
        [
          row.orchestrator_id,
          Number(row.revision),
          b?.sandboxId ?? null,
          b?.providerSandboxId ?? null,
          b?.generation ?? null,
        ],
      );
      const operation: OrchestratorOperation = {
        version: 1,
        id: row.id,
        orchestratorId: row.orchestrator_id,
        kind: "create",
        state: "uncertain",
        revision: Number(row.revision),
        errorCode: "create_worker_interrupted",
      };
      await tx.query(
        `insert into public.orchestrator_runtime_events(orchestrator_id,revision,event) values($1,$2,$3::jsonb)`,
        [row.orchestrator_id, row.revision, JSON.stringify({ kind: "operation", operation })],
      );
      return operation;
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
      const pending = (
        await tx.query<{ runtime_result: { kind?: string; dispatchId?: string } | null }>(
          `select runtime_result from public.orchestrator_operations where id=$1 and orchestrator_id=$2 and actor_id=$3 and action=$4 and revision=$5 and state='pending' for update`,
          [
            reservation.operation.id,
            identity.id,
            identity.ownerId,
            reservation.operation.kind,
            reservation.operation.revision,
          ],
        )
      ).rows[0];
      if (!pending) throw new OrchestratorRuntimeError("conflict");
      if (
        reservation.operation.kind === "create" &&
        pending.runtime_result?.kind === "create_job" &&
        (pending.runtime_result.dispatchId !== reservation.createDispatchId ||
          identity.sandboxId !== reservation.identity.sandboxId ||
          identity.providerSandboxId !== reservation.identity.providerSandboxId ||
          identity.generation !== reservation.identity.generation)
      )
        throw new OrchestratorRuntimeError("conflict");
      await tx.query(`update public.orchestrators set state='ready' where id=$1`, [identity.id]);
      return { ...identity, state: "ready" };
    });
  }

  async pendingPrompt(identity: RuntimeIdentity): Promise<{ operationId: string; promptId: string } | null> {
    const row = (
      await this.sql.query<{ id: string; prompt_id: string }>(
        `select id,runtime_result->>'promptId' as prompt_id from public.orchestrator_operations
       where orchestrator_id=$1 and actor_id=$2 and action='message' and state='succeeded'
       and runtime_result->>'kind'='prompt_receipt' and runtime_result->>'conversationId'=$3
       and coalesce(runtime_result->>'done','false')='false' order by revision desc limit 1`,
        [identity.id, identity.ownerId, identity.conversationId],
      )
    ).rows[0];
    return row ? { operationId: row.id, promptId: row.prompt_id } : null;
  }
  /** The provider reported the turn done. Boat updates a prompt event in place, which the
   * insert-only mirror never sees again, so the final status is published here as one prompt
   * event of the same turn (#847); readers keep the latest status per prompt. Fenced like
   * `appendEvents`: a fenced identity publishes nothing and the turn is observed again. */
  async finishPromptObservation(
    identity: RuntimeIdentity,
    pending: { operationId: string; promptId: string },
    status: PromptStatus,
  ): Promise<void> {
    await this.transaction(async (tx) => {
      const current = await this.read(identity.ownerId, identity.orgId, identity.id, tx, true);
      if (
        current.revision !== identity.revision ||
        current.generation !== identity.generation ||
        current.conversationId !== identity.conversationId ||
        !identity.conversationId
      )
        return;
      const upstreamId = `armada:prompt-done:${pending.promptId}`;
      const event: AgentEvent = {
        id: upstreamId,
        at: Date.now(),
        conversationId: identity.conversationId,
        promptId: pending.promptId,
        kind: "prompt",
        text: "",
        status,
      };
      await tx.query(
        `insert into public.orchestrator_runtime_events(orchestrator_id,revision,generation,conversation_id,upstream_id,event)
        select $1,$2,$3,$4,$5,$6::jsonb where not exists (select 1 from public.orchestrator_runtime_events where orchestrator_id=$1 and conversation_id=$4 and upstream_id=$5) on conflict(orchestrator_id,generation,conversation_id,upstream_id) do nothing`,
        [
          identity.id,
          identity.revision,
          identity.generation,
          identity.conversationId,
          upstreamId,
          JSON.stringify({ kind: "agent", event }),
        ],
      );
      await tx.query(
        `update public.orchestrator_operations set runtime_result=jsonb_set(runtime_result,'{done}','true') where id=$1 and runtime_result->>'kind'='prompt_receipt'`,
        [pending.operationId],
      );
    });
  }

  /** Publication checks logical revision AND physical generation under the owner/member lock. */
  async complete(
    reservation: RuntimeReservation,
    result: {
      state: OrchestratorOperation["state"];
      parentState?: OrchestratorState;
      conversationId?: string;
      promptReceipt?: { promptId: string; conversationId: string; status: string };
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
        `update public.orchestrator_operations set state=$2,error_code=$3, runtime_result=case when runtime_result->>'kind'='create_job' then jsonb_set(runtime_result,'{stage}','"settled"') else case when $4::jsonb is not null then $4::jsonb else runtime_result end end
        where id=$1 and state='pending' returning id`,
        [
          operation.id,
          result.state,
          result.errorCode ?? null,
          result.promptReceipt ? JSON.stringify({ kind: "prompt_receipt", ...result.promptReceipt }) : null,
        ],
      );
      if (!updated.rows.length) return false;
      if (result.parentState)
        await tx.query(`update public.orchestrators set state=$2 where id=$1`, [identity.id, result.parentState]);
      if (operation.kind === "create" && result.state === "failed" && result.parentState === "stopped")
        await tx.query(
          `update public.sandboxes set status='stopped',stopped_at=coalesce(stopped_at,now()),last_observed_at=now()
           where id=$1 and lifecycle_generation=$2 and provider_sandbox_id=$3`,
          [identity.sandboxId, identity.generation, identity.providerSandboxId],
        );
      await tx.query(
        `update public.orchestrator_runtime set updated_at=now(),blocked_reason=$2,
        last_activity_at=case when $3 then now() else last_activity_at end,
        continuity=case when $5::text is not null then $5 when $4 then 'unverified' else continuity end where orchestrator_id=$1`,
        [
          identity.id,
          (operation.kind === "create" && result.state === "failed") || result.parentState === "blocked"
            ? (result.errorCode ?? null)
            : null,
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
