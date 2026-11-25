import {
  accountBindingAvailability,
  type Harness,
  type LaunchCredentialResolver,
  OPENCODE_ENDPOINT_ENV,
  parseOpenCodeEndpoint,
  type Sql,
} from "@armada/core";
import { sandboxCheckOperations } from "@armada/core/contract";
import { VaultError } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { runtimeBridgeTarget } from "./provider-runtime-admission.ts";

import { pendingModalStopOutput } from "./sandbox-lifecycle.ts";

const bindingIds = sandboxCheckOperations.bindSandboxCredential.input.body.pick({ id: true, credentialId: true });
export const ACCOUNT_CHANGE_BUSY =
  "An account can change only when no turn is running. Wait for the turn and any start or stop operation to finish, then try again.";
type Target = {
  id: string;
  owner_id: string;
  org_id: string;
  provider: string;
  harness: Harness;
  runtime_transport: string | null;
  boat_runtime: boolean;
  model: string | null;
  status: string;
  lifecycle_generation: string;
  deleted_at: unknown;
  stopped_at: unknown;
  leased: boolean;
  credential_id: string | null;
  credential_version: number | null;
};
export interface CredentialBindingRecoveryInput {
  id: string;
  credentialId: string;
  org?: string;
}
export interface CredentialBindingRecoveryResult {
  id: string;
  credentialId: string;
  credentialVersion: number;
  harness: Harness;
  status: "bound";
}
export type CredentialBindingRecovery = (
  caller: Caller,
  input: CredentialBindingRecoveryInput,
  quiesce?: QuiesceAccountChange,
) => Promise<CredentialBindingRecoveryResult>;

export type QuiesceAccountChange = (id: string, org: string) => Promise<void>;

/** Account changes quiesce compute before replacing pins; never hot-swap a live driver's environment. */
export function createSandboxAccountChange(
  sql: Sql,
  credentials: Pick<LaunchCredentialResolver, "resolve" | "enrollAccount">,
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
    const runtimeRunning =
      row.status === "running" &&
      runtimeBridgeTarget({
        provider: row.provider,
        harness: row.harness,
        boatRuntime: row.boat_runtime,
        ...(row.runtime_transport ? { modalTransport: row.runtime_transport } : {}),
      });
    if (row.deleted_at || (!["ready", "stopped"].includes(row.status) && !runtimeRunning) || row.leased)
      throw new VaultError("credential_binding_unsafe", ACCOUNT_CHANGE_BUSY);
    if (row.provider === "modal" && row.runtime_transport !== "dialout")
      throw new VaultError("credential_binding_unsupported", "Modal account changes require Armada runtime enrolment.");
    return row;
  }
  return async (caller, input, quiesce) => {
    if (!bindingIds.safeParse(input).success) throw new VaultError("invalid", "Sandbox and account IDs must be UUIDs.");
    if (!transaction) throw new VaultError("unavailable", "Account changes require a transaction.");
    const before = await target(sql, caller, input.id);
    const stopOwnedIdle = async () => {
      if (!quiesce)
        throw new VaultError("credential_binding_unsafe", "Stop the sandbox safely before changing its account.");
      try {
        await quiesce(before.id, before.org_id);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "not_found")
          throw new VaultError(
            "credential_binding_unsafe",
            "This owned sandbox's provider state could not be confirmed. Inspect its status before retrying; the account is unchanged.",
          );
        throw error;
      }
    };
    if (input.org && input.org !== before.org_id)
      throw new VaultError("forbidden", "Choose the organization that owns this sandbox.");
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
    if (before.status !== "stopped") await stopOwnedIdle();
    await credentials.enrollAccount?.(actor, resolved);
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
      if (
        current.runtime_transport === "dialout" &&
        (await pendingModalStopOutput(tx, current.id, current.lifecycle_generation))
      )
        throw new VaultError("credential_binding_unsafe", ACCOUNT_CHANGE_BUSY);
      if (current.credential_id !== before.credential_id || current.credential_version !== before.credential_version)
        throw new VaultError("conflict", "Another account change won. Refresh the sandbox before trying again.");
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
