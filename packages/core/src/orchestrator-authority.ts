import { createHash, randomBytes } from "node:crypto";
import type { Harness } from "./contract.ts";
import type { Sql } from "./golden-store.ts";
import type { OrchestratorScope } from "./orchestrator.ts";

/** Not a Caller: this principal must never enter ordinary owner/admin dispatch. */
export interface DelegatedOrchestrator {
  kind: "orchestrator";
  orchestratorId: string;
  ownerId: string;
  orgId: string;
  role: "admin" | "member";
}
export interface DelegatedRequest {
  method: string;
  childId?: string;
  goldenId?: string;
  harness?: Harness;
  credentialId?: string;
  credentialVersion?: number;
}
/** Adapter to #612's resolveCredentials with explicit credentialId/version. No legacy fallback. */
export type AuthorizeOrchestratorAccount = (
  sql: Sql,
  input: { userId: string; orgId: string; harness: Harness; credentialId: string; credentialVersion: number },
) => Promise<void>;
const methods: Record<string, OrchestratorScope> = {
  launch: "worker:launch",
  read: "worker:read",
  message: "worker:message",
  stop: "worker:stop",
};
export class OrchestratorAuthorityDenied extends Error {
  constructor() {
    super("Orchestrator authority is unavailable or denied.");
  }
}
const deny = (): never => {
  throw new OrchestratorAuthorityDenied();
};
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

/** Private transport must not use prompt/exec argv, logs, events, golden or checkpoint files.
 * ACK proves initial session delivery, NOT live native config reload. */
export interface OrchestratorAuthorityTransport {
  /** Atomically compare-install by physical generation then epoch. Reject a
   * delayed older write even after a newer session ACK; never last-write-wins. */
  deliver(token: string, binding: { epoch: string; physicalGeneration: string }): Promise<{ acknowledged: boolean }>;
  /** With hash: atomic compare-and-scrub ONLY that installed secret. A late
   * delivery failure must never erase a newer epoch. Without hash: quiescent
   * checkpoint scrub of all session grants. Implementations must prove both. */
  scrub(tokenHash?: string): Promise<void>;
}

/** Foundation port, deliberately not mounted in HTTP/MCP or production launch.
 * Epochs last at most 24h, not 15m. Runtime must drain/scrub before epoch expiry
 * and prove native continuity before this can be enabled for either provider. */
export class OrchestratorAuthority {
  constructor(
    private readonly sql: Sql,
    private readonly authorizeAccount: AuthorizeOrchestratorAccount,
  ) {}

  /** Hold parent/member/generation locks through receipt reservation, not provider I/O.
   * Returned work must be a durable operation; external effects reconcile that receipt. */
  async admit<T>(
    token: string,
    request: DelegatedRequest,
    reserve: (sql: Sql, principal: DelegatedOrchestrator) => Promise<T>,
  ): Promise<T> {
    const scope = Object.hasOwn(methods, request.method) ? methods[request.method] : undefined;
    if (!scope || !/^armada_epoch_[a-f0-9]{64}$/.test(token)) return deny();
    if (!this.sql.transaction) return deny();
    return this.sql.transaction(async (tx) => {
      const result = await tx.query<{
        id: string;
        owner_id: string;
        org_id: string;
        role: "admin" | "member";
        golden_ids: string[];
        account_ids: string[];
      }>(
        `select o.id,o.owner_id,o.org_id,m.role,d.golden_ids,d.account_ids
        from public.orchestrator_delegations d
        join public.orchestrators o on o.id=d.orchestrator_id
        join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
        join public.sandboxes s on s.id=o.sandbox_id
        where d.hash=$1 and d.revoked_at is null and d.acknowledged_at is not null
        and d.expires_at>now() and d.epoch=o.authority_epoch and o.state='ready'
        and s.lifecycle_generation=d.physical_generation and s.status not in ('stopped','deleted','failed')
        and s.stop_requested_at is null and $2=any(d.scopes)
        for update of o,d,s,m`,
        [digest(token), scope],
      );
      const row = result.rows[0];
      if (!row) return deny();
      if (request.method === "launch") {
        if (
          !request.goldenId ||
          !row.golden_ids.includes(request.goldenId) ||
          !request.credentialId ||
          !row.account_ids.includes(request.credentialId) ||
          (request.harness !== "claude" && request.harness !== "codex") ||
          !Number.isSafeInteger(request.credentialVersion) ||
          (request.credentialVersion ?? 0) < 1
        )
          return deny();
        const golden = await tx.query(
          `select id from public.goldens where id=$1 and org_id=$2
          and removed_at is null and (visibility='org' or owner_id=$3) for update`,
          [request.goldenId, row.org_id, row.owner_id],
        );
        if (!golden.rows.length) return deny();
        await this.authorizeAccount(tx, {
          userId: row.owner_id,
          orgId: row.org_id,
          harness: request.harness,
          credentialId: request.credentialId,
          credentialVersion: request.credentialVersion as number,
        });
      } else {
        const child = await tx.query(
          `select c.sandbox_id from public.orchestrator_children c
          join public.sandboxes s on s.id=c.sandbox_id
          where c.orchestrator_id=$1 and c.sandbox_id=$2 and c.org_id=$3 and c.owner_id=$4
          and s.org_id=c.org_id and s.owner_id=c.owner_id
          and not exists(select 1 from public.orchestrators parent where parent.sandbox_id=s.id) for update of c,s`,
          [row.id, request.childId ?? null, row.org_id, row.owner_id],
        );
        if (!child.rows.length) return deny();
      }
      return reserve(tx, {
        kind: "orchestrator",
        orchestratorId: row.id,
        ownerId: row.owner_id,
        orgId: row.org_id,
        role: row.role,
      });
    });
  }

  /** Trusted runtime-only installation. A fresh epoch fences the previous secret before
   * delivery; failed/late ACK never opens authority. No public mint/renew route. */
  async installEpoch(
    orchestratorId: string,
    transport: OrchestratorAuthorityTransport,
    consent: { scopes: OrchestratorScope[]; goldenIds: string[]; credentialIds: string[] },
  ): Promise<void> {
    if (!this.sql.transaction) return deny();
    const secret = newOrchestratorEpochSecret();
    const installed = await this.sql.transaction(async (tx) => {
      const result = await tx.query<{ authority_epoch: string; lifecycle_generation: string }>(
        `update public.orchestrators o set authority_epoch=authority_epoch+1
         from public.sandboxes s,public.members m where o.id=$1 and o.state='ready'
         and s.id=o.sandbox_id and s.stop_requested_at is null and s.status in ('ready','running')
         and m.org_id=o.org_id and m.user_id=o.owner_id
         returning o.authority_epoch,s.lifecycle_generation`,
        [orchestratorId],
      );
      const row = result.rows[0];
      if (!row) return deny();
      await tx.query(
        `insert into public.orchestrator_delegations
        (orchestrator_id,hash,epoch,physical_generation,scopes,golden_ids,account_ids,expires_at)
        values($1,$2,$3,$4,$5::text[],$6::uuid[],$7::uuid[],now()+interval '24 hours')`,
        [
          orchestratorId,
          secret.hash,
          row.authority_epoch,
          row.lifecycle_generation,
          consent.scopes,
          consent.goldenIds,
          consent.credentialIds,
        ],
      );
      return row;
    });
    try {
      if (
        !(
          await transport.deliver(secret.token, {
            epoch: String(installed.authority_epoch),
            physicalGeneration: String(installed.lifecycle_generation),
          })
        ).acknowledged
      )
        return deny();
      const ack = await this.sql.query(
        `update public.orchestrator_delegations d set acknowledged_at=now()
        from public.orchestrators o,public.sandboxes s,public.members m
        where d.hash=$1 and o.id=d.orchestrator_id and o.state='ready'
        and o.authority_epoch=d.epoch and s.id=o.sandbox_id and s.lifecycle_generation=d.physical_generation
        and s.stop_requested_at is null and s.status in ('ready','running')
        and m.org_id=o.org_id and m.user_id=o.owner_id and d.revoked_at is null and d.expires_at>now()
        returning d.id`,
        [secret.hash],
      );
      if (!ack.rows.length) return deny();
    } catch {
      // Revoke only this delivery: a failed old ACK must not revoke a newer epoch.
      await this.sql.query(`update public.orchestrator_delegations set revoked_at=now() where hash=$1`, [secret.hash]);
      try {
        await transport.scrub(secret.hash);
      } catch {
        return deny();
      }
      return deny();
    }
  }

  /** Revocation is serialized against admission; rotation/stop must call this before delivery/checkpoint. */
  async revoke(orchestratorId: string): Promise<void> {
    await this.sql.query(`update public.orchestrators set authority_epoch=authority_epoch+1 where id=$1`, [
      orchestratorId,
    ]);
  }

  /** No issuer is exposed here: runtime/lifecycle must first prove private transport,
   * checkpoint scrub and both native clients' continuity in operator-run conformance. */
  async scrubBeforeCheckpoint(orchestratorId: string, transport: OrchestratorAuthorityTransport): Promise<void> {
    await this.revoke(orchestratorId);
    try {
      await transport.scrub();
    } catch {
      return deny();
    } // failure MUST prevent checkpoint
  }
}

/** Server-only entropy helper. Never persisted, logged, returned through a public DTO, or used as an owner token. */
export function newOrchestratorEpochSecret(): { token: string; hash: string } {
  const token = `armada_epoch_${randomBytes(32).toString("hex")}`;
  return { token, hash: digest(token) };
}
