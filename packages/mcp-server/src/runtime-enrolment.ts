import { randomBytes } from "node:crypto";
import { sha256Hex } from "@armada/auth";
import { decryptSecret, encryptSecret, type Sql } from "@armada/core/server";
import type { Route } from "./http.ts";

const ENROL_PATH = "/api/runtime/enrol";
const SESSION_PATH = "/api/runtime/session";
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
export function createRuntimeEnrolments(sql: Sql, encryptionKey: string) {
  const token = (kind: "enrol" | "runtime") => `armada_${kind}_${randomBytes(32).toString("hex")}`;
  const valid = (value: string, kind: "enrol" | "runtime") => new RegExp(`^armada_${kind}_[a-f0-9]{64}$`).test(value);
  async function transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> {
    if (!sql.transaction) throw Error("runtime_enrolment_transaction_required");
    return sql.transaction(work);
  }
  // Member removal already holds the member before its triggers lock sandboxes.
  // Use that same order (member -> sandbox -> runtime) to avoid an inversion.
  async function lockSandbox(tx: Sql, id: string, ownerId?: string) {
    const member = (
      await tx.query(
        `select m.user_id from public.members m join public.sandboxes s
       on m.org_id=s.org_id and m.user_id=s.owner_id where s.id=$1 for update of m`,
        [id],
      )
    ).rows[0];
    if (!member) throw new RuntimeEnrolmentDenied();
    // Sandbox org/owner identity is immutable; the locked membership cannot disappear.
    const row = (
      await tx.query<{ id: string; lifecycle_generation: string }>(
        `select s.id,s.lifecycle_generation::text from public.sandboxes s
       where s.id=$1 and s.provider='boat' and s.status in ('starting','ready','running')
       and s.stop_requested_at is null and s.deleted_at is null and s.expires_at>now()
       and ($2::uuid is null or s.owner_id=$2)
       for update of s`,
        [id, ownerId ?? null],
      )
    ).rows[0];
    if (!row) throw new RuntimeEnrolmentDenied();
    return row;
  }
  async function issue(input: { sandboxId: string; ownerId: string; configuration: Record<string, unknown> }) {
    const serialized = JSON.stringify(input.configuration);
    if (Buffer.byteLength(serialized) > 1048576) throw new RuntimeEnrolmentDenied();
    const sealed = await encryptSecret(serialized, encryptionKey);
    const enrolmentToken = token("enrol");
    const hash = await sha256Hex(enrolmentToken);
    await transaction(async (tx) => {
      const sandbox = await lockSandbox(tx, input.sandboxId, input.ownerId);
      await tx.query(
        `insert into public.runtime_enrolments(sandbox_id,lifecycle_generation,enrolment_hash,enrolment_expires_at,configuration_enc)
         values($1,$2,$3,now()+interval '5 minutes',$4)
         on conflict(sandbox_id) do update set lifecycle_generation=excluded.lifecycle_generation,
         enrolment_hash=excluded.enrolment_hash,enrolment_expires_at=excluded.enrolment_expires_at,
         configuration_enc=excluded.configuration_enc,runtime_hash=null`,
        [sandbox.id, sandbox.lifecycle_generation, hash, sealed],
      );
    });
    return { enrolmentToken };
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
         and lifecycle_generation=$3 and enrolment_expires_at>now() for update`,
          [sandbox.id, hash, sandbox.lifecycle_generation],
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
  /** Keep the epoch lock through journal/command mutations, not merely an earlier auth lookup. */
  async function withSession<T>(
    runtimeToken: string,
    epoch: string,
    work: (tx: Sql, scope: RuntimeSessionScope) => Promise<T>,
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
      const sandbox = await lockSandbox(tx, candidate.sandbox_id);
      const row = (
        await tx.query<{ epoch: string }>(
          `select epoch::text from public.runtime_enrolments where sandbox_id=$1 and runtime_hash=$2
         and epoch::text=$3 and lifecycle_generation=$4 for update`,
          [sandbox.id, hash, epoch, sandbox.lifecycle_generation],
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
  ) {
    return transaction(async (tx) => {
      const sandbox = await lockSandbox(tx, sandboxId, ownerId);
      const row = (
        await tx.query<{ epoch: string }>(
          `select epoch::text from public.runtime_enrolments where sandbox_id=$1
         and lifecycle_generation=$2 and runtime_hash is not null for update`,
          [sandbox.id, sandbox.lifecycle_generation],
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
  return { issue, enrol, withSession, withOwner, route };
}
