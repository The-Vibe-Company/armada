import { randomBytes } from "node:crypto";
import { PROTOCOL_VERSION } from "@armada/agent-runtime";
import { sha256Hex } from "@armada/auth";
import {
  createSqlSandboxStore,
  createSqlVaultStore,
  DelegatedAuthority,
  decryptSecret,
  encryptSecret,
  resolveBoatKey,
  type Sql,
} from "@armada/core/server";
import type { Route } from "./http.ts";
import { resumeDispatchBlocked } from "./jobs/resume-authority.ts";
import { recordLaunchStage } from "./launch-stage-record.ts";
import { usesHostLaunch } from "./provider-runtime-admission.ts";
import { runtimeHealthMatches } from "./runtime-health.ts";
import { runtimeHttpFailure } from "./runtime-http-failure.ts";
import { publishRuntimeReadiness } from "./sandbox-lifecycle.ts";

const ENROL_PATH = "/api/runtime/enrol";
const SESSION_PATH = "/api/runtime/session";
const UNSUPPORTED_PROTOCOL = "runtime_protocol_unsupported";
const SOURCE_TRANSACTION = Symbol("runtime_source_transaction");

import { currentRequestId, recordOperatorDiagnostic } from "./request-observability.ts";

function supportsProtocol(version: number) {
  return version > 0 && (version === PROTOCOL_VERSION || version === PROTOCOL_VERSION - 1);
}

type LiveRuntime = { epoch: string; runtime_protocol_version: number };

export class RuntimeEnrolmentDenied extends Error {
  constructor() {
    super("runtime_enrolment_denied");
  }
}
class RuntimeProtocolUnsupported extends Error {
  constructor(readonly sandboxId: string) {
    super(UNSUPPORTED_PROTOCOL);
  }
}

export interface RuntimeSessionScope {
  sandboxId: string;
  epoch: string;
}
/** Owner scopes also name the locked sandbox's provider for request-correlated command records. */
export interface RuntimeOwnerScope extends RuntimeSessionScope {
  lifecycleGeneration: string;
  provider?: "boat" | "modal" | "docker";
  commandGrantExpiresAt?: Date;
}

/** Reenter an owner-held transaction without opening another connection or changing the callback's SQL object. */
export const runtimeTransaction = (tx: Sql): Sql => ({
  ...tx,
  query: tx.query.bind(tx),
  transaction: async (work) => work(tx),
});

/** Query-only reentry: preserve synchronous forwarding and pass the original owner-held transaction. */
export const scopedRuntimeSql = (tx: Sql): Sql => ({ query: tx.query.bind(tx), transaction: (work) => work(tx) });

export type RuntimeTicketGuard = {
  lockPrerequisites(tx: Sql): Promise<void>;
  check(tx: Sql): Promise<void>;
};

/** Internal launcher authority, never a user-facing configuration/credential API. */
export function createRuntimeEnrolments(sql: Sql, encryptionKey: string, options: { allowDockerIssue?: boolean } = {}) {
  const token = (kind: "enrol" | "runtime") => `armada_${kind}_${randomBytes(32).toString("hex")}`;
  const valid = (value: string, kind: "enrol" | "runtime") => new RegExp(`^armada_${kind}_[a-f0-9]{64}$`).test(value);
  async function transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> {
    if (!sql.transaction) throw Error("runtime_enrolment_transaction_required");
    return sql.transaction(work);
  }
  // Lock every source actor in one stable order, before credentials, hosts or sandboxes.
  // The unlocked host owner is only a hint; lockSandbox pins it under the host lock.
  async function lockSourceMembers(tx: Sql, target: string | { enrolmentHash: string }, ownerId?: string) {
    const byToken = typeof target !== "string";
    const members = await tx.query<{
      user_id: string;
      id: string;
      provider: string;
      org_id: string;
      owner_id: string;
      docker_host_id: string | null;
      docker_installation_id: string | null;
      issuer_id: string | null;
    }>(
      `select m.user_id,s.id,s.provider,s.org_id,s.owner_id,s.docker_host_id,s.docker_installation_id,
       (select h.owner_id from public.docker_hosts h where h.id=s.docker_host_id and h.org_id=s.org_id) as issuer_id
       from public.sandboxes s join public.members m on m.org_id=s.org_id
       and (m.user_id=s.owner_id or (s.provider='docker' and m.user_id=(
         select h.owner_id from public.docker_hosts h where h.id=s.docker_host_id and h.org_id=s.org_id)))
       where s.id=${byToken ? "(select sandbox_id from public.runtime_enrolments where enrolment_hash=$1)" : "$1"}
         and ($2::uuid is null or s.owner_id=$2) order by m.user_id for share of m`,
      byToken ? [target.enrolmentHash, null] : [target, ownerId ?? null],
    );
    const candidate = members.rows[0];
    const locked = new Set(members.rows.map((row) => row.user_id));
    if (!candidate || !locked.has(candidate.owner_id)) throw new RuntimeEnrolmentDenied();
    let docker_issuer_fence: string | null = null;
    if (usesHostLaunch(candidate.provider)) {
      if (!candidate.issuer_id || !locked.has(candidate.issuer_id)) throw new RuntimeEnrolmentDenied();
      // A fresh statement after acquiring membership locks observes their committed epoch.
      const epoch = (
        await tx.query<{ epoch: string }>(
          "select epoch::text from public.mcp_actor_epochs where org_id=$1 and user_id=$2",
          [candidate.org_id, candidate.issuer_id],
        )
      ).rows[0];
      if (!epoch) throw new RuntimeEnrolmentDenied();
      docker_issuer_fence = `${candidate.issuer_id}:${epoch.epoch}`;
    }
    return Object.freeze({ ...candidate, docker_issuer_fence, [SOURCE_TRANSACTION]: tx });
  }
  type Source = Awaited<ReturnType<typeof lockSourceMembers>>;
  async function lockSandbox(tx: Sql, id: string, ownerId?: string, source?: Source) {
    const candidate = source ?? (await lockSourceMembers(tx, id, ownerId));
    if (
      candidate[SOURCE_TRANSACTION] !== tx ||
      candidate.id !== id ||
      (ownerId !== undefined && candidate.owner_id !== ownerId)
    )
      throw new RuntimeEnrolmentDenied();
    if (usesHostLaunch(candidate.provider)) {
      const host = await tx.query(
        `select id from public.docker_hosts where id=$1 and org_id=$2 and owner_id=$3
         and installation_id=$4 and hash is not null and registration_hash is null and revoked_at is null for share`,
        [candidate.docker_host_id, candidate.org_id, candidate.issuer_id, candidate.docker_installation_id],
      );
      if (!host.rows.length) throw new RuntimeEnrolmentDenied();
    }
    const row = (
      await tx.query<{
        id: string;
        lifecycle_generation: string;
        provider_sandbox_id: string;
        runtime_transport: string | null;
        boat_runtime: boolean;
        status: string;
        expires_at: Date;
      }>(
        `select s.id,s.lifecycle_generation::text,s.provider_sandbox_id,s.runtime_transport,s.boat_runtime,s.status,s.expires_at from public.sandboxes s
       where s.id=$1 and (s.provider in ('boat','docker') or (s.provider='modal' and s.runtime_transport='dialout'))
       and s.status in ('starting','ready','running')
       and s.stop_requested_at is null and s.deleted_at is null and s.expires_at>now()
       and s.org_id=$2 and s.owner_id=$3 and s.provider=$4
       and s.docker_host_id is not distinct from $5::uuid and s.docker_installation_id is not distinct from $6::uuid
       for update of s`,
        [
          id,
          candidate.org_id,
          candidate.owner_id,
          candidate.provider,
          candidate.docker_host_id,
          candidate.docker_installation_id,
        ],
      )
    ).rows[0];
    if (!row) throw new RuntimeEnrolmentDenied();
    return { ...row, provider: candidate.provider, docker_issuer_fence: candidate.docker_issuer_fence };
  }
  async function issue(input: {
    sandboxId: string;
    ownerId: string;
    configuration: Record<string, unknown>;
    expectedProviderSandboxId?: string;
    commandGrantExpiresAt?: number;
    expectedGeneration?: number;
    assertClaim?: (tx: Sql) => Promise<void>;
    ticketGuard?: RuntimeTicketGuard;
    recordIssued?: (tx: Sql, enrolmentToken: string) => Promise<void>;
  }) {
    const serialized = JSON.stringify(input.configuration);
    if (Buffer.byteLength(serialized) > 1048576) throw new RuntimeEnrolmentDenied();
    const sealed = await encryptSecret(serialized, encryptionKey);
    const enrolmentToken = token("enrol");
    const hash = await sha256Hex(enrolmentToken);
    const receipt = await transaction(async (tx) => {
      await input.ticketGuard?.lockPrerequisites(tx);
      const sandbox = await lockSandbox(tx, input.sandboxId, input.ownerId);
      if (
        (input.expectedProviderSandboxId !== undefined &&
          sandbox.provider_sandbox_id !== input.expectedProviderSandboxId) ||
        (input.expectedGeneration !== undefined && sandbox.lifecycle_generation !== String(input.expectedGeneration))
      )
        throw new RuntimeEnrolmentDenied();
      if (usesHostLaunch(sandbox.provider) && options.allowDockerIssue !== true) throw new RuntimeEnrolmentDenied();
      await input.assertClaim?.(tx);
      await input.ticketGuard?.check(tx);
      const parent = (
        await tx.query<{ id: string }>(
          "select id from public.armada_access_parents where sandbox_id=$1 and kind='sandbox'",
          [sandbox.id],
        )
      ).rows[0];
      if (parent) {
        const locked = await tx.query(
          "select id from public.armada_access_parents where id=$1 for update skip locked",
          [parent.id],
        );
        if (!locked.rows.length) throw new RuntimeEnrolmentDenied();
        await new DelegatedAuthority(tx, async () => {}).revoke(parent.id);
      }
      const commandDeadline =
        (sandbox.runtime_transport === "dialout" || sandbox.boat_runtime) && input.commandGrantExpiresAt !== undefined
          ? new Date(input.commandGrantExpiresAt)
          : null;
      const pricing = await createSqlSandboxStore(tx, { turnModels: true }).captureUsagePricingContext!(
        input.sandboxId,
      );
      const row = (
        await tx.query<{ epoch: string }>(
          `insert into public.runtime_enrolments as r(sandbox_id,lifecycle_generation,enrolment_hash,enrolment_expires_at,configuration_enc,docker_issuer_fence,pricing_context,correlation_id,command_grant_epoch,command_grant_expires_at)
         values($1,$2,$3,now()+interval '5 minutes',$4,$5,$6::jsonb,$7,case when $8::timestamptz is not null then 1 end,$8)
         on conflict(sandbox_id) do update set lifecycle_generation=excluded.lifecycle_generation,
         enrolment_hash=excluded.enrolment_hash,enrolment_expires_at=excluded.enrolment_expires_at,
         configuration_enc=excluded.configuration_enc,docker_issuer_fence=excluded.docker_issuer_fence,
         pricing_context=excluded.pricing_context,correlation_id=excluded.correlation_id,runtime_hash=null,
         command_grant_epoch=case when excluded.command_grant_expires_at is not null then r.epoch+1 end,
         command_grant_expires_at=excluded.command_grant_expires_at returning epoch::text`,
          [
            sandbox.id,
            sandbox.lifecycle_generation,
            hash,
            sealed,
            sandbox.docker_issuer_fence,
            JSON.stringify(pricing),
            currentRequestId() ?? null,
            commandDeadline,
          ],
        )
      ).rows[0];
      if (!row) throw new RuntimeEnrolmentDenied();
      await input.recordIssued?.(tx, enrolmentToken);
      await input.assertClaim?.(tx);
      return { epoch: String(BigInt(row.epoch) + 1n), lifecycleGeneration: sandbox.lifecycle_generation };
    });
    return { enrolmentToken, ...receipt };
  }
  async function refreshModalBootstrapManifest(
    tx: Sql,
    sandboxId: string,
    generation: number,
    hash: string,
    artifactManifest: unknown,
  ) {
    const {
      rows: [pending],
    } = await tx.query<{ configuration_enc: Uint8Array<ArrayBuffer> }>(
      `select configuration_enc from public.runtime_enrolments
       where sandbox_id=$1 and lifecycle_generation=$2 and enrolment_hash=$3
         and enrolment_expires_at>clock_timestamp() and runtime_hash is null and configuration_enc is not null
       for update`,
      [sandboxId, generation, hash],
    );
    if (!pending) return false;
    const configuration = JSON.parse(await decryptSecret(pending.configuration_enc, encryptionKey));
    const serialized = JSON.stringify({ ...configuration, artifactManifest });
    if (Buffer.byteLength(serialized) > 1048576) throw new RuntimeEnrolmentDenied();
    const sealed = await encryptSecret(serialized, encryptionKey);
    const { rows } = await tx.query(
      `update public.runtime_enrolments set configuration_enc=$4
       where sandbox_id=$1 and lifecycle_generation=$2 and enrolment_hash=$3
         and enrolment_expires_at>clock_timestamp() returning sandbox_id`,
      [sandboxId, generation, hash, sealed],
    );
    return rows.length > 0;
  }
  async function enrol(enrolmentToken: string, wireProtocol: string | null = String(PROTOCOL_VERSION)) {
    // The original v1 wire request had no protocol header. This encoding ages out with v1.
    const encodedVersion = wireProtocol ?? "1";
    const version = Number(encodedVersion);
    const supported = String(version) === encodedVersion && supportsProtocol(version);
    if (!valid(enrolmentToken, "enrol")) throw new RuntimeEnrolmentDenied();
    const hash = await sha256Hex(enrolmentToken);
    const runtimeToken = token("runtime");
    const runtimeHash = await sha256Hex(runtimeToken);
    const result = await transaction(async (tx) => {
      const source = await lockSourceMembers(tx, { enrolmentHash: hash });
      const sandbox = await lockSandbox(tx, source.id, undefined, source);
      const row = (
        await tx.query<{ configuration_enc: Uint8Array<ArrayBuffer> | null; lifecycle_generation: string }>(
          `select case when $5::boolean then configuration_enc end as configuration_enc,lifecycle_generation::text
         from public.runtime_enrolments where sandbox_id=$1 and enrolment_hash=$2
         and lifecycle_generation=$3::bigint and enrolment_expires_at>now()
         and not exists(select 1 from public.jobs j where j.kind='launch' and j.sandbox_id=$1
           and j.generation=$3 and j.outcome ? 'docker_actor_epoch'
           and (j.deadline_at<=clock_timestamp() or j.attempts>j.max_attempts or j.state in ('failed','done') or not exists(
             select 1 from public.mcp_actor_epochs e where e.org_id=j.org_id and e.user_id=j.request_owner_id
               and e.epoch::text=j.outcome->>'docker_actor_epoch')))
         and not ${resumeDispatchBlocked("$1", true)}
         and docker_issuer_fence is not distinct from $4::text for update`,
          [sandbox.id, hash, sandbox.lifecycle_generation, sandbox.docker_issuer_fence, supported],
        )
      ).rows[0];
      if (!row) throw new RuntimeEnrolmentDenied();
      if (!supported) return new RuntimeProtocolUnsupported(sandbox.id);
      if (!row.configuration_enc) throw new RuntimeEnrolmentDenied();
      if (sandbox.boat_runtime && sandbox.status === "starting") {
        const { rows } = await tx.query<{
          expired: boolean;
          key_digest: string;
          owner_id: string;
          org_id: string;
          visibility: "org" | "private";
        }>(
          `select j.outcome->>'boat_authority_sha256' as key_digest,s.owner_id,s.org_id,s.source_golden_visibility as visibility,
                  not (j.state in ('queued','leased') and j.deadline_at>clock_timestamp()
                         and j.attempts<=j.max_attempts and exists(
                           select 1 from public.credentials c
                           where c.id=s.credential_id and c.version=s.credential_version and c.status='active'
                             and (c.expires_at is null or c.expires_at>clock_timestamp())
                             and ((c.scope='org' and c.owner_id=s.org_id) or (c.scope='user' and c.owner_id=s.owner_id))
                           for share of c nowait
                         )) as expired
           from public.jobs j join public.sandboxes s on s.id=j.sandbox_id
           where j.sandbox_id=$1 and j.kind='launch' and j.generation=$2
             and j.payload_enc is not null
             and j.outcome #>> '{modal_machine,entry,machineId}'=s.provider_sandbox_id`,
          [sandbox.id, sandbox.lifecycle_generation],
        );
        for (const launch of rows) {
          if (launch.expired) throw new RuntimeEnrolmentDenied();
          await tx.query("select id from public.orgs where id=$1 for share nowait", [launch.org_id]);
          if (launch.visibility === "private")
            await tx.query(
              "select id from public.credentials where scope='user' and owner_id=$1 and kind='boat' for share nowait",
              [launch.owner_id],
            );
          const { key, scope } = await resolveBoatKey(createSqlVaultStore(tx), encryptionKey, {
            userId: launch.owner_id,
            orgId: launch.org_id,
            visibility: launch.visibility,
          }).catch(() => {
            throw new RuntimeEnrolmentDenied();
          });
          if ((await sha256Hex(JSON.stringify([scope, key]))) !== launch.key_digest) throw new RuntimeEnrolmentDenied();
        }
      }
      const configuration: unknown = JSON.parse(await decryptSecret(row.configuration_enc, encryptionKey));
      const updated = (
        await tx.query<{ epoch: string }>(
          `update public.runtime_enrolments set epoch=epoch+1,runtime_hash=$2,enrolment_hash=null,
         enrolment_expires_at=null,configuration_enc=null,runtime_protocol_version=$3
         where sandbox_id=$1 returning epoch::text`,
          [sandbox.id, runtimeHash, version],
        )
      ).rows[0];
      if (!updated) throw new RuntimeEnrolmentDenied();
      await recordLaunchStage(tx, sandbox.id, "enrolled");
      if (
        sandbox.status === "starting" &&
        (await publishRuntimeReadiness(tx, sandbox.id, sandbox.lifecycle_generation, "bootstrap")) === "conflict"
      )
        throw new RuntimeEnrolmentDenied();
      return { sandboxId: sandbox.id, epoch: updated.epoch, runtimeToken, configuration };
    });
    if (result instanceof RuntimeProtocolUnsupported) throw result;
    return result;
  }
  /** Read-only bootstrap reporting does not consume or extend the one-use ticket. */
  async function withBootstrap<T>(
    enrolmentToken: string,
    work: (tx: Sql, scope: RuntimeSessionScope, generation: string) => Promise<T>,
  ) {
    if (!valid(enrolmentToken, "enrol")) throw new RuntimeEnrolmentDenied();
    const hash = await sha256Hex(enrolmentToken);
    return transaction(async (tx) => {
      const candidate = (
        await tx.query<{ sandbox_id: string }>(
          "select sandbox_id from public.runtime_enrolments where enrolment_hash=$1",
          [hash],
        )
      ).rows[0];
      if (!candidate) throw new RuntimeEnrolmentDenied();
      const sandbox = await lockSandbox(tx, candidate.sandbox_id);
      const row = (
        await tx.query<{ epoch: string }>(
          `select epoch::text from public.runtime_enrolments where sandbox_id=$1 and enrolment_hash=$2
         and lifecycle_generation=$3 and enrolment_expires_at>now() and configuration_enc is not null
         and docker_issuer_fence is not distinct from $4::text for update`,
          [sandbox.id, hash, sandbox.lifecycle_generation, sandbox.docker_issuer_fence],
        )
      ).rows[0];
      if (!row) throw new RuntimeEnrolmentDenied();
      return work(tx, { sandboxId: sandbox.id, epoch: String(BigInt(row.epoch) + 1n) }, sandbox.lifecycle_generation);
    });
  }
  /** Keep the epoch lock through journal/command mutations, not merely an earlier auth lookup. */
  async function withSession<T>(
    runtimeToken: string,
    epoch: string,
    work: (tx: Sql, scope: RuntimeSessionScope, generation: string) => Promise<T>,
    source?: Source,
  ) {
    if (!valid(runtimeToken, "runtime") || !/^[1-9][0-9]{0,18}$/.test(epoch)) throw new RuntimeEnrolmentDenied();
    const hash = await sha256Hex(runtimeToken);
    return transaction(async (tx) => {
      const candidate = (
        await tx.query<{ sandbox_id: string }>(
          "select sandbox_id from public.runtime_enrolments where runtime_hash=$1",
          [hash],
        )
      ).rows[0];
      if (!candidate) throw new RuntimeEnrolmentDenied();
      const sandbox = await lockSandbox(tx, candidate.sandbox_id, undefined, source);
      const row = (
        await tx.query<LiveRuntime>(
          `select epoch::text,runtime_protocol_version from public.runtime_enrolments where sandbox_id=$1 and runtime_hash=$2
         and epoch::text=$3 and lifecycle_generation=$4
         and docker_issuer_fence is not distinct from $5::text for update`,
          [sandbox.id, hash, epoch, sandbox.lifecycle_generation, sandbox.docker_issuer_fence],
        )
      ).rows[0];
      if (!row || !supportsProtocol(row.runtime_protocol_version)) throw new RuntimeEnrolmentDenied();
      return work(tx, { sandboxId: sandbox.id, epoch: row.epoch }, sandbox.lifecycle_generation);
    });
  }
  async function dockerRestoreMatches(tx: Sql, scope: RuntimeSessionScope, health: unknown) {
    if (!runtimeHealthMatches(health, scope.epoch)) return false;
    const {
      rows: [checkpoint],
    } = await tx.query<{ epoch: string; watermark: string; conversation_ids: string[] }>(
      `select c.epoch::text,c.watermark::text,s.conversation_ids
       from public.sandboxes s join public.runtime_checkpoints c on c.sandbox_id=s.id
       where s.id=$1 and s.provider='docker'
       and c.epoch=$2::bigint-1 and c.watermark is not null`,
      [scope.sandboxId, scope.epoch],
    );
    if (!checkpoint) return true;
    return (
      checkpoint.conversation_ids.length === 1 &&
      runtimeHealthMatches(health, scope.epoch, {
        epoch: checkpoint.epoch,
        watermark: Number(checkpoint.watermark),
        conversationId: checkpoint.conversation_ids[0] as string,
      })
    );
  }

  async function confirmDockerRestore(tx: Sql, scope: RuntimeSessionScope, generation: string, health: unknown) {
    if (!(await dockerRestoreMatches(tx, scope, health))) return "unverified";
    const publication = await publishRuntimeReadiness(tx, scope.sandboxId, generation, "retained");
    if (publication === "conflict") throw new RuntimeEnrolmentDenied();
    return publication;
  }

  /** Trusted server-side command issuer/readback, under the same owner/lifecycle fence. */
  async function withOwner<T>(
    sandboxId: string,
    ownerId: string,
    work: (tx: Sql, scope: RuntimeOwnerScope) => Promise<T>,
    expectedLifecycleGeneration?: string,
  ) {
    return transaction(async (tx) => {
      const sandbox = await lockSandbox(tx, sandboxId, ownerId);
      if (expectedLifecycleGeneration !== undefined && sandbox.lifecycle_generation !== expectedLifecycleGeneration)
        throw new RuntimeEnrolmentDenied();
      const row = (
        await tx.query<LiveRuntime & { command_grant_expires_at: Date | null }>(
          `select epoch::text,runtime_protocol_version,
         case when command_grant_epoch=epoch then command_grant_expires_at end as command_grant_expires_at
         from public.runtime_enrolments where sandbox_id=$1
         and lifecycle_generation=$2 and runtime_hash is not null
         and docker_issuer_fence is not distinct from $3::text for update`,
          [sandbox.id, sandbox.lifecycle_generation, sandbox.docker_issuer_fence],
        )
      ).rows[0];
      if (!row || !supportsProtocol(row.runtime_protocol_version)) throw new RuntimeEnrolmentDenied();
      const grantDeadline = row.command_grant_expires_at;
      const commandGrantExpiresAt =
        sandbox.boat_runtime && grantDeadline && sandbox.expires_at < grantDeadline
          ? sandbox.expires_at
          : grantDeadline;
      return work(tx, {
        sandboxId: sandbox.id,
        epoch: row.epoch,
        lifecycleGeneration: sandbox.lifecycle_generation,
        provider: sandbox.provider as NonNullable<RuntimeOwnerScope["provider"]>,
        ...(commandGrantExpiresAt ? { commandGrantExpiresAt } : {}),
      });
    });
  }
  const route: Route = async (request) => {
    const path = new URL(request.url).pathname;
    if (![ENROL_PATH, SESSION_PATH].includes(path)) return null;
    const headers = { "cache-control": "no-store" };
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, allow: "POST" } });
    const bearer = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "";
    try {
      const result =
        path === ENROL_PATH
          ? await enrol(bearer, request.headers.get("x-armada-runtime-protocol"))
          : await withSession(bearer, request.headers.get("x-armada-runtime-epoch") ?? "", async (_tx, scope) => scope);
      return Response.json(result, { headers });
    } catch (error) {
      if (error instanceof RuntimeProtocolUnsupported) {
        recordOperatorDiagnostic(
          "runtime.enrol.protocol",
          { errorClass: "RuntimeProtocolUnsupported", message: UNSUPPORTED_PROTOCOL, stack: [] },
          { sandboxId: error.sandboxId },
        );
        return runtimeHttpFailure(409, UNSUPPORTED_PROTOCOL);
      }
      return runtimeHttpFailure(error instanceof RuntimeEnrolmentDenied ? 401 : 503);
    }
  };
  return {
    issue,
    refreshModalBootstrapManifest,
    enrol,
    withBootstrap,
    withSession,
    withOwner,
    confirmDockerRestore,
    lockSourceMembers,
    route,
  };
}
