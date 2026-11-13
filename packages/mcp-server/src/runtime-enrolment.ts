import { randomBytes } from "node:crypto";
import { sha256Hex } from "@armada/auth";
import { decryptSecret, encryptSecret, type Sql } from "@armada/core/server";
import type { Route } from "./http.ts";

const ENROL_PATH = "/api/runtime/enrol";
const SESSION_PATH = "/api/runtime/session";
const SOURCE_TRANSACTION = Symbol("runtime_source_transaction");
export class RuntimeEnrolmentDenied extends Error {
  constructor() {
    super("runtime_enrolment_denied");
  }
}
export interface RuntimeSessionScope {
  sandboxId: string;
  epoch: string;
}

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
  async function lockSourceMembers(tx: Sql, id: string, ownerId?: string) {
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
       where s.id=$1 and ($2::uuid is null or s.owner_id=$2) order by m.user_id for update of m`,
      [id, ownerId ?? null],
    );
    const candidate = members.rows[0];
    const locked = new Set(members.rows.map((row) => row.user_id));
    if (!candidate || !locked.has(candidate.owner_id)) throw new RuntimeEnrolmentDenied();
    let docker_issuer_fence: string | null = null;
    if (candidate.provider === "docker") {
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
    if (candidate.provider === "docker") {
      const host = await tx.query(
        `select id from public.docker_hosts where id=$1 and org_id=$2 and owner_id=$3
         and installation_id=$4 and hash is not null and registration_hash is null and revoked_at is null for share`,
        [candidate.docker_host_id, candidate.org_id, candidate.issuer_id, candidate.docker_installation_id],
      );
      if (!host.rows.length) throw new RuntimeEnrolmentDenied();
    }
    const row = (
      await tx.query<{ id: string; lifecycle_generation: string }>(
        `select s.id,s.lifecycle_generation::text from public.sandboxes s
       where s.id=$1 and (s.provider in ('boat','docker') or (s.provider='modal' and s.runtime_transport='dialout')) and s.status in ('starting','ready','running')
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
  async function issue(input: { sandboxId: string; ownerId: string; configuration: Record<string, unknown> }) {
    const serialized = JSON.stringify(input.configuration);
    if (Buffer.byteLength(serialized) > 1048576) throw new RuntimeEnrolmentDenied();
    const sealed = await encryptSecret(serialized, encryptionKey);
    const enrolmentToken = token("enrol");
    const hash = await sha256Hex(enrolmentToken);
    const receipt = await transaction(async (tx) => {
      const sandbox = await lockSandbox(tx, input.sandboxId, input.ownerId);
      if (sandbox.provider === "docker" && options.allowDockerIssue !== true) throw new RuntimeEnrolmentDenied();
      const row = (
        await tx.query<{ epoch: string }>(
          `insert into public.runtime_enrolments(sandbox_id,lifecycle_generation,enrolment_hash,enrolment_expires_at,configuration_enc,docker_issuer_fence)
         values($1,$2,$3,now()+interval '5 minutes',$4,$5)
         on conflict(sandbox_id) do update set lifecycle_generation=excluded.lifecycle_generation,
         enrolment_hash=excluded.enrolment_hash,enrolment_expires_at=excluded.enrolment_expires_at,
         configuration_enc=excluded.configuration_enc,docker_issuer_fence=excluded.docker_issuer_fence,runtime_hash=null returning epoch::text`,
          [sandbox.id, sandbox.lifecycle_generation, hash, sealed, sandbox.docker_issuer_fence],
        )
      ).rows[0];
      if (!row) throw new RuntimeEnrolmentDenied();
      return { epoch: String(BigInt(row.epoch) + 1n), lifecycleGeneration: sandbox.lifecycle_generation };
    });
    return { enrolmentToken, ...receipt };
  }
  async function enrol(enrolmentToken: string) {
    if (!valid(enrolmentToken, "enrol")) throw new RuntimeEnrolmentDenied();
    const hash = await sha256Hex(enrolmentToken);
    const runtimeToken = token("runtime");
    const runtimeHash = await sha256Hex(runtimeToken);
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
        await tx.query<{ configuration_enc: Uint8Array<ArrayBuffer> }>(
          `select configuration_enc from public.runtime_enrolments where sandbox_id=$1 and enrolment_hash=$2
         and lifecycle_generation=$3 and enrolment_expires_at>now()
         and docker_issuer_fence is not distinct from $4::text for update`,
          [sandbox.id, hash, sandbox.lifecycle_generation, sandbox.docker_issuer_fence],
        )
      ).rows[0];
      if (!row) throw new RuntimeEnrolmentDenied();
      const configuration: unknown = JSON.parse(await decryptSecret(row.configuration_enc, encryptionKey));
      const updated = (
        await tx.query<{ epoch: string }>(
          `update public.runtime_enrolments set epoch=epoch+1,runtime_hash=$2,enrolment_hash=null,
         enrolment_expires_at=null,configuration_enc=null where sandbox_id=$1 returning epoch::text`,
          [sandbox.id, runtimeHash],
        )
      ).rows[0];
      if (!updated) throw new RuntimeEnrolmentDenied();
      return { sandboxId: sandbox.id, epoch: updated.epoch, runtimeToken, configuration };
    });
  }
  /** Read-only bootstrap reporting does not consume or extend the one-use ticket. */
  async function withBootstrap<T>(enrolmentToken: string, work: (tx: Sql, scope: RuntimeSessionScope) => Promise<T>) {
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
         and lifecycle_generation=$3 and enrolment_expires_at>now()
         and docker_issuer_fence is not distinct from $4::text for update`,
          [sandbox.id, hash, sandbox.lifecycle_generation, sandbox.docker_issuer_fence],
        )
      ).rows[0];
      if (!row) throw new RuntimeEnrolmentDenied();
      return work(tx, { sandboxId: sandbox.id, epoch: String(BigInt(row.epoch) + 1n) });
    });
  }
  /** Keep the epoch lock through journal/command mutations, not merely an earlier auth lookup. */
  async function withSession<T>(
    runtimeToken: string,
    epoch: string,
    work: (tx: Sql, scope: RuntimeSessionScope) => Promise<T>,
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
        await tx.query<{ epoch: string }>(
          `select epoch::text from public.runtime_enrolments where sandbox_id=$1 and runtime_hash=$2
         and epoch::text=$3 and lifecycle_generation=$4
         and docker_issuer_fence is not distinct from $5::text for update`,
          [sandbox.id, hash, epoch, sandbox.lifecycle_generation, sandbox.docker_issuer_fence],
        )
      ).rows[0];
      if (!row) throw new RuntimeEnrolmentDenied();
      return work(tx, { sandboxId: sandbox.id, epoch: row.epoch });
    });
  }
  /** Trusted server-side command issuer/readback, under the same owner/lifecycle fence. */
  async function withOwner<T>(
    sandboxId: string,
    ownerId: string,
    work: (tx: Sql, scope: RuntimeSessionScope) => Promise<T>,
    expectedLifecycleGeneration?: string,
  ) {
    return transaction(async (tx) => {
      const sandbox = await lockSandbox(tx, sandboxId, ownerId);
      if (expectedLifecycleGeneration !== undefined && sandbox.lifecycle_generation !== expectedLifecycleGeneration)
        throw new RuntimeEnrolmentDenied();
      const row = (
        await tx.query<{ epoch: string }>(
          `select epoch::text from public.runtime_enrolments where sandbox_id=$1
         and lifecycle_generation=$2 and runtime_hash is not null
         and docker_issuer_fence is not distinct from $3::text for update`,
          [sandbox.id, sandbox.lifecycle_generation, sandbox.docker_issuer_fence],
        )
      ).rows[0];
      if (!row) throw new RuntimeEnrolmentDenied();
      return work(tx, { sandboxId: sandbox.id, epoch: row.epoch });
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
          ? await enrol(bearer)
          : await withSession(bearer, request.headers.get("x-armada-runtime-epoch") ?? "", async (_tx, scope) => scope);
      return Response.json(result, { headers });
    } catch (error) {
      return Response.json(
        { error: error instanceof RuntimeEnrolmentDenied ? "runtime_enrolment_denied" : "runtime_unavailable" },
        { status: error instanceof RuntimeEnrolmentDenied ? 401 : 503, headers },
      );
    }
  };
  return { issue, enrol, withBootstrap, withSession, withOwner, lockSourceMembers, route };
}
