import { createHash, randomBytes } from "node:crypto";
import { isScopedMethod, scopedOperations } from "./contract/scoped.ts";
import type { Harness } from "./contract.ts";
import type { DelegatedScope } from "./delegated-access.ts";
import type { Sql } from "./golden-store.ts";
import { isHarness } from "./harnesses.ts";

/** Not a Caller: this principal must never enter ordinary owner/admin dispatch. */
export interface DelegatedPrincipal {
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
export type AuthorizeDelegatedAccount = (
  sql: Sql,
  input: { userId: string; orgId: string; harness: Harness; credentialId: string; credentialVersion: number },
) => Promise<void>;
export class DelegatedAuthorityDenied extends Error {
  constructor() {
    super("Orchestrator authority is unavailable or denied.");
  }
}
const deny = (): never => {
  throw new DelegatedAuthorityDenied();
};
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

/** Private transport must not use prompt/exec argv, logs, events, golden or checkpoint files.
 * ACK proves initial session delivery, NOT live native config reload. */
export interface DelegatedAuthorityTransport {
  /** Trusted provider incarnation and SQL snapshot observed before private delivery. */
  readonly physicalGeneration: string;
  readonly lifecycleGeneration: string;
  /** Atomically compare-install by physical generation then epoch. Reject a
   * delayed older write even after a newer session ACK; never last-write-wins. */
  deliver(token: string, binding: { epoch: string; physicalGeneration: string }): Promise<{ acknowledged: boolean }>;
  /** With hash: atomic compare-and-scrub ONLY that installed secret. A late
   * delivery failure must never erase a newer epoch. Without hash: quiescent
   * checkpoint scrub of all session grants. Implementations must prove both. */
  scrub(tokenHash?: string): Promise<void>;
}

type AuthorityParent = { id: string; sandbox_id: string; owner_id: string; org_id: string };

async function lockAuthorityMember(tx: Sql, parent: AuthorityParent) {
  if (
    !(
      await tx.query("select 1 from public.members where org_id=$1 and user_id=$2 for share", [
        parent.org_id,
        parent.owner_id,
      ])
    ).rows.length
  )
    return deny();
}

async function lockAuthorityParent(tx: Sql, parent: AuthorityParent) {
  // WARNING: The lifecycle fence acquires the parent sandbox before the access parent.
  if (
    !(await tx.query("select 1 from public.sandboxes where id=$1 for no key update", [parent.sandbox_id])).rows.length
  )
    return deny();
  // WARNING: A stronger parent lock deadlocks with the child sandbox and its ownership foreign key.
  if (
    !(
      await tx.query("select 1 from public.armada_access_parents where id=$1 and sandbox_id=$2 for no key update", [
        parent.id,
        parent.sandbox_id,
      ])
    ).rows.length
  )
    return deny();
}

/** Epoch-bound authority shared by native and runtime scoped access. */
export class DelegatedAuthority {
  constructor(
    private readonly sql: Sql,
    private readonly authorizeAccount: AuthorizeDelegatedAccount,
  ) {}

  /** Discovery reads the current grant without reserving work or locking the parent. */
  async catalogGrant(token: string) {
    if (!/^armada_epoch_[a-f0-9]{64}$/.test(token)) return deny();
    const { scopes, kind } = await this.activeGrant(this.sql, token, null);
    return { scopes, kind };
  }

  private async activeGrant(tx: Sql, token: string, scope: DelegatedScope | null, lockDelegation = false) {
    const result = await tx.query<
      AuthorityParent & {
        role: "admin" | "member";
        golden_ids: string[];
        account_ids: string[];
        scopes: DelegatedScope[];
        kind: string;
      }
    >(
      `with grant_row as materialized (
        select o.id,o.sandbox_id,o.owner_id,o.org_id,m.role,d.golden_ids,d.account_ids,d.scopes,o.kind,d.expires_at
        from public.orchestrator_delegations d
        join public.armada_access_parents o on o.id=d.orchestrator_id
        join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
        join public.sandboxes s on s.id=o.sandbox_id
        where d.hash=$1 and d.revoked_at is null and d.acknowledged_at is not null
        and d.expires_at>clock_timestamp() and d.epoch=o.authority_epoch and o.state='ready'
        and d.native_generation=s.orchestrator_native_generation and s.status not in ('stopped','deleted','failed')
        and s.stop_requested_at is null and ($2::text is null or $2=any(d.scopes))
        ${lockDelegation ? "for no key update of d" : ""}
      ) select * from grant_row where expires_at>clock_timestamp()`,
      [digest(token), scope],
    );
    return result.rows[0] ?? deny();
  }

  /** Hold parent/member/generation locks through receipt reservation, not provider I/O.
   * Returned work must be a durable operation; external effects reconcile that receipt. */
  async admit<T>(
    token: string,
    request: DelegatedRequest,
    reserve: (sql: Sql, principal: DelegatedPrincipal) => Promise<T>,
  ): Promise<T> {
    const scope = isScopedMethod(request.method) ? scopedOperations[request.method].scope : undefined;
    if (!scope || !/^armada_epoch_[a-f0-9]{64}$/.test(token)) return deny();
    if (!this.sql.transaction) return deny();
    return this.sql.transaction(async (tx) => {
      const candidate = await this.activeGrant(tx, token, scope);
      await lockAuthorityMember(tx, candidate);
      let launchAccount: Parameters<AuthorizeDelegatedAccount>[1] | undefined;
      if (request.method === "launch") {
        if (
          !request.goldenId ||
          !candidate.golden_ids.includes(request.goldenId) ||
          !request.credentialId ||
          !candidate.account_ids.includes(request.credentialId) ||
          !isHarness(request.harness) ||
          !Number.isSafeInteger(request.credentialVersion) ||
          (request.credentialVersion ?? 0) < 1
        )
          return deny();
        const golden = await tx.query(
          `select id from public.goldens where id=$1 and org_id=$2
          and removed_at is null and (visibility='org' or owner_id=$3) for update`,
          [request.goldenId, candidate.org_id, candidate.owner_id],
        );
        if (!golden.rows.length) return deny();
        await tx.query(
          `select id from public.credentials where id=$1
           and ((scope='user' and owner_id=$2) or (scope='org' and owner_id=$3)) for update`,
          [request.credentialId, candidate.owner_id, candidate.org_id],
        );
        launchAccount = {
          userId: candidate.owner_id,
          orgId: candidate.org_id,
          harness: request.harness,
          credentialId: request.credentialId,
          credentialVersion: request.credentialVersion as number,
        };
      } else if (request.method !== "finish") {
        // WARNING: Launch/setup workers lock the child before revalidating parent authority.
        const child = await tx.query(
          `select c.sandbox_id from public.orchestrator_children c
          join public.sandboxes s on s.id=c.sandbox_id
          where c.orchestrator_id=$1 and c.sandbox_id=$2 and c.org_id=$3 and c.owner_id=$4
          and s.org_id=c.org_id and s.owner_id=c.owner_id
          and not exists(select 1 from public.armada_access_parents parent where parent.sandbox_id=s.id)
          ${request.method === "stop" ? "for update of s" : "for no key update of s"}`,
          [candidate.id, request.childId ?? null, candidate.org_id, candidate.owner_id],
        );
        if (!child.rows.length) return deny();
      }
      await lockAuthorityParent(tx, candidate);
      const row = await this.activeGrant(tx, token, scope, true);
      if (row.id !== candidate.id || row.sandbox_id !== candidate.sandbox_id) return deny();
      if (launchAccount) {
        if (!row.golden_ids.includes(request.goldenId ?? "") || !row.account_ids.includes(launchAccount.credentialId))
          return deny();
        await this.authorizeAccount(tx, launchAccount);
      } else if (request.method === "finish") {
        // Self completion has no caller-selected target and never grants child/owner authority.
        const self = await tx.query(
          "select sandbox_id from public.armada_access_parents where id=$1 and kind='sandbox'",
          [row.id],
        );
        if (!self.rows.length || request.childId !== undefined) return deny();
      } else {
        const relation = await tx.query(
          "select 1 from public.orchestrator_children where sandbox_id=$1 and orchestrator_id=$2 for update",
          [request.childId, row.id],
        );
        if (!relation.rows.length) return deny();
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
    transport: DelegatedAuthorityTransport,
    consent: { scopes: DelegatedScope[]; goldenIds: string[]; credentialIds: string[] },
  ): Promise<void> {
    if (!this.sql.transaction || !transport.physicalGeneration || !/^[1-9][0-9]*$/.test(transport.lifecycleGeneration))
      return deny();
    const secret = newDelegatedEpochSecret();
    const installed = await this.sql.transaction(async (tx) => {
      const parent = (
        await tx.query<AuthorityParent>(
          "select id,sandbox_id,org_id,owner_id from public.armada_access_parents where id=$1 and sandbox_id is not null",
          [orchestratorId],
        )
      ).rows[0];
      if (!parent) return deny();
      await lockAuthorityMember(tx, parent);
      await lockAuthorityParent(tx, parent);
      const binding = await tx.query(
        `update public.sandboxes s set orchestrator_native_generation=$2
         where s.id=$1 and s.lifecycle_generation=$3 and s.stop_requested_at is null
         and s.status in ('starting','ready','running')
         and exists(select 1 from public.armada_access_parents where id=$4 and state='ready')
         returning s.id`,
        [parent.sandbox_id, transport.physicalGeneration, transport.lifecycleGeneration, orchestratorId],
      );
      if (!binding.rows.length) return deny();
      const result = await tx.query<{ authority_epoch: string; lifecycle_generation: string }>(
        `update public.armada_access_parents o set authority_epoch=authority_epoch+1
         from public.sandboxes s,public.members m where o.id=$1 and o.state='ready'
         and s.id=o.sandbox_id and s.stop_requested_at is null and s.status in ('starting','ready','running')
         and m.org_id=o.org_id and m.user_id=o.owner_id
         returning o.authority_epoch,s.lifecycle_generation`,
        [orchestratorId],
      );
      const row = result.rows[0];
      if (!row) return deny();
      await tx.query(
        `insert into public.orchestrator_delegations
        (orchestrator_id,hash,epoch,physical_generation,scopes,golden_ids,account_ids,expires_at,native_generation)
        values($1,$2,$3,$4,$5::text[],$6::uuid[],$7::uuid[],now()+interval '24 hours',$8)`,
        [
          orchestratorId,
          secret.hash,
          row.authority_epoch,
          row.lifecycle_generation,
          consent.scopes,
          consent.goldenIds,
          consent.credentialIds,
          transport.physicalGeneration,
        ],
      );
      return row;
    });
    try {
      if (
        !(
          await transport.deliver(secret.token, {
            epoch: String(installed.authority_epoch),
            physicalGeneration: transport.physicalGeneration,
          })
        ).acknowledged
      )
        return deny();
      const ack = await this.sql.query(
        `update public.orchestrator_delegations d set acknowledged_at=now()
        from public.armada_access_parents o,public.sandboxes s,public.members m
        where d.hash=$1 and o.id=d.orchestrator_id and o.state='ready'
        and o.authority_epoch=d.epoch and s.id=o.sandbox_id and s.lifecycle_generation=d.physical_generation
        and d.native_generation=s.orchestrator_native_generation and d.native_generation=$2
        and s.stop_requested_at is null and s.status in ('starting','ready','running')
        and m.org_id=o.org_id and m.user_id=o.owner_id and d.revoked_at is null and d.expires_at>now()
        returning d.id`,
        [secret.hash, transport.physicalGeneration],
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
    await this.sql.query(`update public.armada_access_parents set authority_epoch=authority_epoch+1 where id=$1`, [
      orchestratorId,
    ]);
  }

  /** No issuer is exposed here: runtime/lifecycle must first prove private transport,
   * checkpoint scrub and both native clients' continuity in operator-run conformance. */
  async scrubBeforeCheckpoint(orchestratorId: string, transport: DelegatedAuthorityTransport): Promise<void> {
    await this.revoke(orchestratorId);
    try {
      await transport.scrub();
    } catch {
      return deny();
    } // failure MUST prevent checkpoint
  }
}

export function newDelegatedEpochSecret(): { token: string; hash: string } {
  const token = `armada_epoch_${randomBytes(32).toString("hex")}`;
  return { token, hash: digest(token) };
}
