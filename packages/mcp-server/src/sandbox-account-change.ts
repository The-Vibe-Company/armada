import {
  accountBindingAvailability,
  type Harness,
  type LaunchCredentialResolver,
  OPENCODE_ENDPOINT_ENV,
  parseOpenCodeEndpoint,
  type Sql,
} from "@armada/core";
import { VaultError } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import type { CredentialBindingRecovery } from "./credential-binding-recovery.ts";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export const ACCOUNT_CHANGE_BUSY =
  "An account can change only when no turn is running. Wait for the turn and any start or stop operation to finish, then try again.";
type Target = {
  id: string;
  owner_id: string;
  org_id: string;
  provider: string;
  harness: Harness;
  provider_sandbox_id: string;
  runtime_transport: string | null;
  boat_runtime: boolean;
  model: string | null;
  status: string;
  deleted_at: unknown;
  stopped_at: unknown;
  leased: boolean;
  credential_id: string | null;
  credential_version: number | null;
};
export type QuiesceAccountChange = (id: string, org: string) => Promise<void>;

/** Account changes quiesce compute before replacing pins; never hot-swap a live driver's environment. */
export function createSandboxAccountChange(
  sql: Sql,
  credentials: Pick<LaunchCredentialResolver, "resolve" | "admit">,
  legacy: CredentialBindingRecovery,
): CredentialBindingRecovery {
  const transaction = sql.transaction?.bind(sql);
  async function target(db: Sql, caller: Caller, id: string, lock = false): Promise<Target> {
    const row = (
      await db.query<Target>(
        `select s.*,
      coalesce(s.activity_until>=now(),false) or coalesce(s.reconcile_lease_until>=now(),false) as leased
      from public.sandboxes s where s.id=$1
      and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id) ${lock ? "for update" : ""}`,
        [id],
      )
    ).rows[0];
    if (!row || row.owner_id !== caller.userId)
      throw new VaultError("not_found", "Sandbox not found or not accessible.");
    if (!caller.orgs.some((membership) => membership.orgId === row.org_id))
      throw new VaultError("forbidden", "This token does not include the sandbox's organization.");
    const membership = await db.query("select 1 from public.members where org_id=$1 and user_id=$2 for share", [
      row.org_id,
      caller.userId,
    ]);
    if (!membership.rows.length)
      throw new VaultError("forbidden", "You must still be a member of this sandbox's organization.");
    if (row.deleted_at || !["ready", "stopped"].includes(row.status) || row.leased)
      throw new VaultError("credential_binding_unsafe", ACCOUNT_CHANGE_BUSY);
    return row;
  }
  return async (caller, input, quiesce) => {
    if (!UUID.test(input.id) || !UUID.test(input.credentialId))
      throw new VaultError("invalid", "Sandbox and account IDs must be UUIDs.");
    if (!transaction) throw new VaultError("unavailable", "Account changes require a transaction.");
    const before = await target(sql, caller, input.id);
    if (input.org && input.org !== before.org_id)
      throw new VaultError("forbidden", "Choose the organization that owns this sandbox.");
    // Preserve the stricter physical-evidence recovery policy for pre-account native Modal machines.
    if (before.provider === "modal" && before.credential_id === null && before.runtime_transport !== "dialout") {
      if (before.status === "ready" && quiesce) await quiesce(before.id, before.org_id);
      return legacy(caller, input);
    }
    const actor = { userId: caller.userId, orgId: before.org_id, role: "member" as const };
    const resolved = await credentials.resolve(actor, before.harness, input.credentialId);
    const pin = resolved.binding;
    if (!pin) throw new VaultError("unavailable", "The selected account has no stable revision.");
    if (pin.credentialId === before.credential_id && pin.credentialVersion === before.credential_version)
      return { id: before.id, ...pin, harness: before.harness, status: "bound" };
    const availability = accountBindingAvailability({ provider: before.provider, boatRuntime: before.boat_runtime });
    if (!availability.available) throw new VaultError("credential_binding_unsupported", availability.reason);
    const endpoint = resolved.env[OPENCODE_ENDPOINT_ENV];
    if (before.harness === "opencode" && before.model) {
      const compatible = endpoint
        ? parseOpenCodeEndpoint(JSON.parse(endpoint)).models.some((model) => before.model === `armada/${model}`)
        : before.model.startsWith("opencode/") || before.model.startsWith("opencode-go/");
      if (!compatible)
        throw new VaultError(
          "credential_refused",
          "Choose an account that supports this sandbox's current model, or launch a new sandbox with that account's model.",
        );
    }
    if (
      resolved.usagePricing &&
      (resolved.usagePricing.credentialId !== pin.credentialId ||
        resolved.usagePricing.credentialVersion !== pin.credentialVersion)
    )
      throw new VaultError("unavailable", "The selected account's pricing identity is inconsistent.");
    if (before.status === "ready") {
      if (!quiesce)
        throw new VaultError("credential_binding_unsafe", "Stop the sandbox safely before changing its account.");
      await quiesce(before.id, before.org_id);
    }
    await credentials.admit?.(actor, resolved, before.id);
    return transaction(async (tx) => {
      // Follow the member -> account -> sandbox lock order used by turn admission.
      await tx.query("select 1 from public.members where org_id=$1 and user_id=$2 for share", [
        before.org_id,
        caller.userId,
      ]);
      const account = await tx.query(
        `select id from public.credentials where id=$1 and version=$2 and status='active'
        and (expires_at is null or expires_at>now()) and ((scope='user' and owner_id=$3) or (scope='org' and owner_id=$4)) for share`,
        [pin.credentialId, pin.credentialVersion, caller.userId, before.org_id],
      );
      if (!account.rows.length) throw new VaultError("conflict", "The selected account changed. Choose it again.");
      const current = await target(tx, caller, before.id, true);
      if (current.status !== "stopped" || !current.stopped_at)
        throw new VaultError(
          "credential_binding_unsafe",
          "The sandbox is stopping to change accounts. Wait until it is stopped, then retry.",
        );
      if (current.credential_id !== before.credential_id || current.credential_version !== before.credential_version)
        throw new VaultError("conflict", "Another account change won. Refresh the sandbox before trying again.");
      if (current.provider === "modal" && current.runtime_transport !== "dialout") {
        const machines = await tx.query<{
          scope: string;
          record: import("@armada/provider-modal").Machine;
          leased: boolean;
          owner_id: string;
        }>(
          `select m.scope,m.record,m.owner_id,coalesce(m.lease_until>=now(),false) as leased from public.modal_machines m join public.modal_server_harnesses h on h.scope=m.scope and h.machine_id=m.id
          where m.id=$1 and m.org_id=$2 and h.credential_id is not distinct from $3::uuid
          and h.credential_version is not distinct from $4 for update of m,h`,
          [current.provider_sandbox_id, current.org_id, before.credential_id, before.credential_version],
        );
        if (machines.rows.length !== 1)
          throw new VaultError("conflict", "The retained workspace account cannot be identified safely.");
        const machine = machines.rows[0]!;
        if (
          machine.leased ||
          machine.record.golden ||
          (machine.record.launchUserId ?? machine.owner_id) !== caller.userId ||
          machine.record.phase !== "stopped" ||
          machine.record.info.state !== "stopped" ||
          machine.record.info.providerState !== "stopped" ||
          !machine.record.recoveryImageId
        )
          throw new VaultError("credential_binding_unsafe", ACCOUNT_CHANGE_BUSY);
        machine.record.info.labels = {
          ...machine.record.info.labels,
          credentialId: pin.credentialId,
          credentialVersion: String(pin.credentialVersion),
        };
        await tx.query(
          "update public.modal_server_harnesses set credential_id=$3,credential_version=$4 where scope=$1 and machine_id=$2",
          [machine.scope, current.provider_sandbox_id, pin.credentialId, pin.credentialVersion],
        );
        await tx.query(
          "update public.modal_machines set record=$3::jsonb,lease_id=null,lease_until=null where scope=$1 and id=$2",
          [machine.scope, current.provider_sandbox_id, JSON.stringify(machine.record)],
        );
      }
      // Generation change revokes old runtime/enrolment tokens and sealed configuration via the existing trigger.
      await tx.query(
        "update public.sandboxes set credential_id=$2,credential_version=$3,lifecycle_generation=lifecycle_generation+1 where id=$1",
        [current.id, pin.credentialId, pin.credentialVersion],
      );
      // Keep immutable historical launch/turn quotes. Only future admissions select this new book.
      await tx.query(
        `insert into public.sandbox_account_usage_pricing(sandbox_id,credential_id,credential_version,context)
         values($1,$2,$3,$4::jsonb) on conflict do nothing`,
        [current.id, pin.credentialId, pin.credentialVersion, JSON.stringify(resolved.usagePricing ?? null)],
      );
      return { id: current.id, ...pin, harness: current.harness, status: "bound" };
    });
  };
}
