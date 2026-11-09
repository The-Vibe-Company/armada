import { createSqlVaultStore, type Harness, resolveCredentials, type Sql, VaultError } from "@armada/core/server";
import type { Machine } from "@armada/provider-modal";
import type { Caller } from "./caller.ts";

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
) => Promise<CredentialBindingRecoveryResult>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** No provider port: recovery cannot allocate, resume or restart a physical workspace. */
export function createCredentialBindingRecovery(
  sql: Sql,
  encryptionKey: string | undefined,
): CredentialBindingRecovery {
  return async (caller, input) => {
    if (!UUID.test(input.id) || !UUID.test(input.credentialId))
      throw new VaultError("invalid", "Sandbox and credential IDs must be UUIDs.");
    if (!sql.transaction) throw new VaultError("unavailable", "Binding recovery requires a transaction.");
    return sql.transaction(async (tx) => {
      const selected = await tx.query<{
        id: string;
        org_id: string;
        provider_sandbox_id: string;
        harness: Harness;
        status: string;
        credential_id: string | null;
        credential_version: number | null;
        /** An activity or reconciliation lease that has not expired; an expired one is released, as everywhere else. */
        leased: boolean;
        modal_workspace: string;
        modal_environment: string;
        modal_app_id: string;
      }>(
        `select s.*,g.modal_workspace,g.modal_environment,g.modal_app_id,
        coalesce(s.activity_until>=now(),false) or coalesce(s.reconcile_lease_until>=now(),false) as leased
        from public.sandboxes s join public.goldens g on g.id=s.golden_id
        where s.id=$1 and s.owner_id=$2 and s.provider='modal' and s.org_id=any($3::uuid[])
        and ($4::uuid is null or s.org_id=$4::uuid) for update of s`,
        [input.id, caller.userId, caller.orgs.map((m) => m.orgId), input.org ?? null],
      );
      const sandbox = selected.rows[0];
      if (!sandbox) throw new VaultError("not_found", "Only the sandbox owner can recover its account binding.");
      const member = await tx.query("select 1 from public.members where org_id=$1 and user_id=$2 for share", [
        sandbox.org_id,
        caller.userId,
      ]);
      if (!member.rows.length) throw new VaultError("forbidden", "Organization membership is required.");
      if (sandbox.credential_id !== null || sandbox.credential_version !== null)
        throw new VaultError("conflict", "This sandbox is already bound; its account cannot change.");
      const policies = await tx.query<{
        scope: string;
        owner_id: string;
        record: Machine;
        leased: boolean;
        harness: Harness;
        credential_id: string | null;
        credential_version: number | null;
      }>(
        `
        select m.scope,m.owner_id,m.record,coalesce(m.lease_until>=now(),false) as leased,h.harness,h.credential_id,h.credential_version
        from public.modal_machines m join public.modal_server_harnesses h on h.scope=m.scope and h.machine_id=m.id
        join public.modal_server_scopes c on c.scope=m.scope
        where m.id=$1 and m.org_id=$2 and c.context->'binding'->>'workspace'=$3
        and c.context->'binding'->>'environment'=$4 and c.context->'binding'->>'appId'=$5
        for update of m,h`,
        [
          sandbox.provider_sandbox_id,
          sandbox.org_id,
          sandbox.modal_workspace,
          sandbox.modal_environment,
          sandbox.modal_app_id,
        ],
      );
      const policy = policies.rows[0];
      if (policies.rows.length !== 1 || !policy || policy.harness !== sandbox.harness)
        throw new VaultError("conflict", "The retained Modal harness policy cannot be identified safely.");
      const machine = policy.record;
      if ((machine.launchUserId ?? policy.owner_id) !== caller.userId)
        throw new VaultError("forbidden", "Only the original workspace owner can recover its binding.");
      if (
        policy.credential_id !== null ||
        policy.credential_version !== null ||
        machine.info.labels.credentialId !== undefined ||
        machine.info.labels.credentialVersion !== undefined
      )
        throw new VaultError("conflict", "The Modal workspace is already bound; its account cannot change.");
      if (
        sandbox.status !== "stopped" ||
        sandbox.leased ||
        policy.leased ||
        machine.golden ||
        machine.phase !== "stopped" ||
        machine.info.state !== "stopped" ||
        machine.info.providerState !== "stopped" ||
        !machine.recoveryImageId
      )
        throw new VaultError(
          "credential_binding_unsafe",
          "Stop the sandbox and finish lifecycle reconciliation before binding. Running, leased or uncertain physical state cannot be adopted.",
        );
      const resolved = await resolveCredentials(createSqlVaultStore(tx), encryptionKey, {
        userId: caller.userId,
        orgId: sandbox.org_id,
        harness: sandbox.harness,
        credentialId: input.credentialId,
      });
      const binding = resolved.binding;
      if (!binding) throw new VaultError("unavailable", "The selected account has no stable revision.");
      const credential = await tx.query(
        "select id from public.credentials where id=$1 and version=$2 and status='active' and (expires_at is null or expires_at>now()) for share",
        [binding.credentialId, binding.credentialVersion],
      );
      if (!credential.rows.length)
        throw new VaultError("conflict", "The selected account changed during recovery. Choose it again.");
      const publicPin = await tx.query(
        "update public.sandboxes set credential_id=$2,credential_version=$3 where id=$1 and credential_id is null and credential_version is null returning id",
        [sandbox.id, binding.credentialId, binding.credentialVersion],
      );
      const privatePin = await tx.query(
        "update public.modal_server_harnesses set credential_id=$3,credential_version=$4 where scope=$1 and machine_id=$2 and credential_id is null and credential_version is null returning machine_id",
        [policy.scope, sandbox.provider_sandbox_id, binding.credentialId, binding.credentialVersion],
      );
      if (!publicPin.rows.length || !privatePin.rows.length)
        throw new VaultError("conflict", "The workspace was bound concurrently; no account change was made.");
      machine.launchUserId ??= caller.userId;
      machine.info.labels = {
        ...machine.info.labels,
        credentialId: binding.credentialId,
        credentialVersion: String(binding.credentialVersion),
      };
      await tx.query("update public.modal_machines set record=$3::jsonb where scope=$1 and id=$2", [
        policy.scope,
        sandbox.provider_sandbox_id,
        JSON.stringify(machine),
      ]);
      return { id: sandbox.id, ...binding, harness: sandbox.harness, status: "bound" };
    });
  };
}
