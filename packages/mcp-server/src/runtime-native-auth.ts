import type { GoldenActor, Sql } from "@armada/core/server";
import { VaultError } from "@armada/core/server";
import { createNativeStateStore, nativeState } from "./model-auth-state.ts";
import { createRuntimeEnrolments, RuntimeEnrolmentDenied } from "./runtime-enrolment.ts";

export interface RuntimeNativePublication {
  token: string;
  epoch: string;
  sandboxId: string;
  generation: string;
  authJson: string;
  expectedRevision: number;
}

/** Live Boat runtime only. Existing account ownership/CAS/sealing stays authoritative. */
export function createRuntimeNativeAuth(sql: Sql, key: string) {
  const authority = createRuntimeEnrolments(sql, key);
  return async (input: RuntimeNativePublication): Promise<{ authRevision: number; committed: boolean }> => {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
      throw new VaultError("invalid", "Invalid native auth revision.");
    nativeState(input.authJson);
    // Discover binding only. Do not retain sandbox/epoch locks while waiting for an account lock.
    const binding = await authority.withSession(input.token, input.epoch, async (tx, scope) => {
      if (input.sandboxId !== scope.sandboxId || input.generation !== scope.epoch) throw new RuntimeEnrolmentDenied();
      const row = (
        await tx.query<{ owner_id: string; org_id: string; credential_id: string; credential_version: number }>(
          `select s.owner_id,s.org_id,s.credential_id,s.credential_version from public.sandboxes s
         join public.credentials c on c.id=s.credential_id where s.id=$1 and s.harness='codex'
         and c.kind='codex_auth' and s.credential_version is not null`,
          [scope.sandboxId],
        )
      ).rows[0];
      if (!row) throw new RuntimeEnrolmentDenied();
      return row;
    });
    if (!sql.transaction) throw Error("runtime_native_auth_transaction_required");
    return sql.transaction(async (tx) => {
      // NativeStateStore locks member -> credential/ownership -> source -> state.
      // Take an exclusive member lock FIRST: two readers must not share member
      // locks while one waits for credential and the other upgrades for the epoch.
      const member = await tx.query("select user_id from public.members where org_id=$1 and user_id=$2 for update", [
        binding.org_id,
        binding.owner_id,
      ]);
      if (!member.rows.length) throw new RuntimeEnrolmentDenied();
      const scoped: Sql = { query: (q, v) => tx.query(q, v), transaction: (work) => work(tx) };
      const source = createRuntimeEnrolments(scoped, key),
        state = createNativeStateStore(scoped, key);
      const actor: GoldenActor = { userId: binding.owner_id, orgId: binding.org_id, role: "member" };
      const verifySource = async () =>
        source.withSession(input.token, input.epoch, async (locked, scope) => {
          if (scope.sandboxId !== input.sandboxId || scope.epoch !== input.generation)
            throw new RuntimeEnrolmentDenied();
          const current = await locked.query(
            `select id from public.sandboxes where id=$1 and owner_id=$2 and org_id=$3
           and credential_id=$4 and credential_version=$5 and harness='codex'`,
            [scope.sandboxId, binding.owner_id, binding.org_id, binding.credential_id, binding.credential_version],
          );
          if (!current.rows.length) throw new RuntimeEnrolmentDenied();
        });
      try {
        const revision = await state.publish({
          actor,
          accountId: binding.credential_id,
          version: binding.credential_version,
          sandboxId: input.sandboxId,
          generation: `runtime:${input.epoch}`,
          authJson: input.authJson,
          expectedRevision: input.expectedRevision,
          verifySource,
        });
        return { authRevision: revision, committed: true };
      } catch (error) {
        if (!(error instanceof VaultError) || error.code !== "conflict") throw error;
        await verifySource();
        const revision = await state.publicationRevision(
          actor,
          binding.credential_id,
          binding.credential_version,
          input.sandboxId,
          async () => {
            throw new RuntimeEnrolmentDenied();
          },
        );
        return { authRevision: revision, committed: false };
      }
    });
  };
}
