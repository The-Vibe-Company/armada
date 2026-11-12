import type { GoldenActor, Provider, Sql } from "@armada/core/server";
import {
  CREDENTIAL_BUSY_MESSAGE,
  createSqlVaultStore,
  decryptSecret,
  deleteNeverStartedSandbox,
  encryptSecret,
  ProviderError,
  redact,
  sshNativeAuthAdmission,
  sshPrivateAuthState,
  VaultError,
} from "@armada/core/server";

import type { IngestGrantClaims, Scope } from "@armada/provider-modal";
import { scopeKey } from "@armada/provider-modal";
import { exposedSecrets } from "./launch-credentials.ts";
import { createNativeStateStore, type NativeState, nativeState } from "./model-auth-state.ts";
import { createSubscriptionBroker } from "./subscription-broker.ts";

/**
 * Shared-session broker plus legacy native-state recovery/publication.
 * The exclusive owner is confined to legacy native mode and compatibility
 * embedders; configured shared launch admission goes directly to the broker.
 */
export function createModelAuthOwnership(
  sql: Sql,
  encryptionKey?: string,
  captureNative: typeof sshPrivateAuthState = sshPrivateAuthState,
  now: () => number = Date.now,
  historicalProvider?: (tx: Sql, sandboxId: string) => Promise<{ provider: Provider; providerSandboxId: string }>,
  subscription?: { origin: string; fetch?: typeof fetch },
) {
  const state = createNativeStateStore(sql, encryptionKey);
  const broker = subscription
    ? createSubscriptionBroker(sql, encryptionKey, subscription.origin, subscription.fetch, historicalProvider)
    : undefined;
  async function modalGeneration(tx: Sql, providerId: string, actor: GoldenActor, lock = false): Promise<string> {
    const result = await tx.query<{ generation: string }>(
      `select record->>'generation' as generation from public.modal_machines where id=$1 and org_id=$2::uuid and owner_id=$3::uuid${lock ? " for update" : ""}`,
      [providerId, actor.orgId, actor.userId],
    );
    if (result.rows.length !== 1 || !result.rows[0]?.generation)
      throw new VaultError("conflict", "Native source generation is ambiguous.");
    return result.rows[0].generation;
  }
  async function authorize(tx: Sql, actor: GoldenActor, id: string, version: number): Promise<Uint8Array> {
    const result = await tx.query<{ id: string; value_enc: Uint8Array }>(
      `select c.id,c.value_enc from public.credentials c where c.id=$1::uuid and c.version=$2 and c.status='active'
       and c.kind='codex_auth' and (c.expires_at is null or c.expires_at>now())
       and exists(select 1 from public.members m where m.org_id=$4::uuid and m.user_id=$3::uuid)
       and ((c.scope='user' and c.owner_id=$3::uuid) or (c.scope='org' and c.owner_id=$4::uuid))
       for update of c`,
      [id, version, actor.userId, actor.orgId],
    );
    const row = result.rows[0];
    if (!row) throw new VaultError("not_found", "Native credential is no longer authorized.");
    return row.value_enc;
  }
  async function releaseFailed(
    actor: GoldenActor,
    id: string,
    version: number,
    sandboxId: string,
    deletePhysical?: () => Promise<void>,
    freshAuthJson?: string,
    automaticNeverStarted = false,
  ) {
    if (!sql.transaction) throw new VaultError("unavailable", "Native cleanup requires transactions.");
    await sql.transaction(async (tx) => {
      await authorize(tx, actor, id, version);
      const ownership = await tx.query<{ account_version: number }>(
        "select account_version from public.model_auth_ownership where account_id=$1::uuid and sandbox_id=$2::uuid for update",
        [id, sandboxId],
      );
      const historical = ownership.rows.length
        ? undefined
        : (
            await tx.query<{ credential_version: number | null }>(
              "select credential_version from public.sandboxes where id=$1::uuid and credential_id=$2::uuid and owner_id=$3::uuid and org_id=$4::uuid for update",
              [sandboxId, id, actor.userId, actor.orgId],
            )
          ).rows[0];
      const storedVersion = ownership.rows[0]?.account_version ?? historical?.credential_version;
      if (storedVersion === undefined)
        throw new VaultError("conflict", "The subscription holder changed. Reload and try again.");
      await tx.query(
        "select account_id from public.model_auth_state where account_id=$1::uuid and account_version=$2 for update",
        [id, storedVersion],
      );
      const unknownVersion = storedVersion === null;
      if (unknownVersion && !freshAuthJson)
        throw new VaultError("conflict", "Import fresh account auth while releasing this unknown-version history.");
      const imported = unknownVersion ? nativeState(freshAuthJson ?? "").authJson : undefined;
      const fresh = unknownVersion || version > Number(storedVersion);
      if (automaticNeverStarted && (fresh || !deletePhysical))
        throw new VaultError(
          "conflict",
          "Automatic cleanup requires the original never-started account version and physical deletion proof.",
        );
      if (!automaticNeverStarted && (deletePhysical || fresh)) {
        const permitted = await tx.query(
          `select c.id from public.credentials c where c.id=$1::uuid
             and (c.scope='user' or exists(select 1 from public.members m
             where m.org_id=c.owner_id and m.user_id=$2::uuid and m.role='admin'))`,
          [id, actor.userId],
        );
        if (!permitted.rows.length)
          throw new VaultError("forbidden", "An organization administrator must release organization accounts.");
      }
      const sandbox = await tx.query<{ id: string }>("select id from public.sandboxes where id=$1::uuid for update", [
        sandboxId,
      ]);
      if (!sandbox.rows.length) {
        // Reconnect fences a late pre-registration bootstrap using the old version.
        if (!fresh) throw new VaultError("conflict", "Reconnect this account before releasing an unregistered launch.");
        await tx.query("delete from public.model_auth_ownership where account_id=$1::uuid and sandbox_id=$2::uuid", [
          id,
          sandboxId,
        ]);
        return;
      }
      const found = await tx.query(
        `select s.id from public.sandboxes s left join public.model_auth_state state
           on state.account_id=$1::uuid and state.account_version=$2
           where s.id=$3::uuid and s.owner_id=$4::uuid and s.org_id=$5::uuid
           and s.credential_id=$1::uuid and s.credential_version is not distinct from $2::integer
           and s.status in ('failed','stopped','deleted')
           and (s.activity_until is null or s.activity_until<now())
           and (s.reconcile_lease_until is null or s.reconcile_lease_until<now()) and s.stop_requested_at is null
           and ($6::boolean or (s.status='failed' and cardinality(s.conversation_ids)=0 and s.task_prompt_id is null
           and state.auth_revision=0 and state.source_generation='launch:never-started'))`,
        [id, storedVersion, sandboxId, actor.userId, actor.orgId, fresh],
      );
      if (!found.rows.length)
        throw new VaultError(
          "conflict",
          "Reconnect the account and finish sandbox operations before releasing its failed or stopped holder.",
        );
      if (fresh) {
        if (!historicalProvider) throw new VaultError("unavailable", "Historical sandbox control is unavailable.");
        const target = await historicalProvider(tx, sandboxId);
        if (!(await deleteNeverStartedSandbox(target.provider, target.providerSandboxId)))
          throw new VaultError("conflict", "Physical deletion is not confirmed; ownership retained.");
      } else await deletePhysical?.();
      if (imported !== undefined) {
        await tx.query("update public.credentials set value_enc=$2 where id=$1::uuid", [
          id,
          await encryptSecret(imported, encryptionKey),
        ]);
      }
      if (fresh) {
        await tx.query(
          "update public.sandboxes set status='deleted',deleted_at=coalesce(deleted_at,now()),status_reason=null,credential_id=null,credential_version=null,activity_lease_id=null,activity_until=null,reconcile_lease=null,reconcile_lease_until=null,lifecycle_generation=lifecycle_generation+1 where id=$1::uuid",
          [sandboxId],
        );
      } else {
        await tx.query(
          "update public.sandboxes set credential_id=null,credential_version=null,lifecycle_generation=lifecycle_generation+1 where id=$1::uuid",
          [sandboxId],
        );
        await tx.query("delete from public.model_auth_state where account_id=$1::uuid and account_version=$2", [
          id,
          storedVersion,
        ]);
      }
      await tx.query(
        "delete from public.model_auth_ownership where account_id=$1::uuid and account_version=$2 and sandbox_id=$3::uuid",
        [id, storedVersion, sandboxId],
      );
    });
  }

  return {
    state,
    broker,
    async shared(sandboxId: string): Promise<boolean> {
      return (
        !!broker &&
        (
          await sql.query(
            `select 1 from public.sandboxes s join public.model_auth_state a on a.account_id=s.credential_id and a.account_version=s.credential_version where s.id=$1::uuid and a.source_generation like 'server:%'`,
            [sandboxId],
          )
        ).rows.length > 0
      );
    },
    async managed(sandboxId: string): Promise<boolean> {
      return (
        (
          await sql.query(
            `select 1 from public.model_auth_ownership where sandbox_id=$1::uuid
          union all select 1 from public.sandboxes s join public.model_auth_state state
          on state.account_id=s.credential_id and state.account_version=s.credential_version
          where s.id=$1::uuid limit 1`,
            [sandboxId],
          )
        ).rows.length > 0
      );
    },
    async holder(actor: GoldenActor, id: string, version: number) {
      if (!sql.transaction) throw new VaultError("unavailable", "Native inspection requires transactions.");
      return sql.transaction(async (tx) => {
        await authorize(tx, actor, id, version);
        const result = await tx.query<{
          sandboxId: string;
          version: number | null;
          storedVersion: number | null;
          unknownVersion: boolean;
          currentVersion: number;
          requiresReconnect: boolean;
          releasable: boolean;
          orphan: boolean;
        }>(
          `select o.sandbox_id as "sandboxId",o.account_version as version,o.account_version as "storedVersion",
           $2::integer as "currentVersion",s.id is null as orphan,o.account_version is null as "unknownVersion",
           o.account_version is null or not ($2>o.account_version or (s.id is not null and coalesce(state.auth_revision=0,false)
             and state.source_generation='launch:never-started')) as "requiresReconnect",
           (o.account_version is not null and ($2>o.account_version or (s.id is not null and coalesce(state.auth_revision=0,false)
             and state.source_generation='launch:never-started'))
             and (s.id is null or (s.credential_id=$1::uuid and s.credential_version is not distinct from o.account_version and s.status in ('failed','stopped','deleted')
             and (s.activity_until is null or s.activity_until<now())
             and (s.reconcile_lease_until is null or s.reconcile_lease_until<now())
             and s.stop_requested_at is null))) as releasable
           from (
             select sandbox_id,account_version from public.model_auth_ownership where account_id=$1::uuid
             union all
             select history.id,history.credential_version from public.sandboxes history
             where history.credential_id=$1::uuid
             and history.owner_id=$3::uuid and history.org_id=$4::uuid
             and not exists(select 1 from public.model_auth_ownership owned where owned.account_id=$1::uuid)
           ) o left join public.model_auth_state state
           on state.account_id=$1::uuid and state.account_version=o.account_version
           left join public.sandboxes s on s.id=o.sandbox_id
           where (s.id is null or (s.owner_id=$3::uuid and s.org_id=$4::uuid)) order by o.account_version nulls first,s.id limit 1`,
          [id, version, actor.userId, actor.orgId],
        );
        return result.rows[0] ?? null;
      });
    },
    async markNeverStarted(actor: GoldenActor, id: string, version: number, sandboxId: string) {
      if (!sql.transaction) throw new VaultError("unavailable", "Native cleanup requires transactions.");
      return sql.transaction(async (tx) => {
        await authorize(tx, actor, id, version);
        const marked = await tx.query(
          `update public.model_auth_state state set source_generation='launch:never-started'
           from public.model_auth_ownership o,public.sandboxes s
           where state.account_id=$1::uuid and state.account_version=$2 and state.auth_revision=0
           and state.source_generation='launch:unallocated' and o.account_id=state.account_id
           and o.account_version=state.account_version and o.sandbox_id=$3::uuid
           and s.id=o.sandbox_id and s.owner_id=$4::uuid and s.status='failed'
           and cardinality(s.conversation_ids)=0 and s.task_prompt_id is null returning state.account_id`,
          [id, version, sandboxId, actor.userId],
        );
        if (marked.rows.length > 0) return true;
        // A send may have won admission since launch failure. Keep cleanup in
        // the locked native path; never fall back to an unleased provider stop.
        return (
          (
            await tx.query(
              "select 1 from public.model_auth_ownership where account_id=$1::uuid and account_version=$2 and sandbox_id=$3::uuid",
              [id, version, sandboxId],
            )
          ).rows.length > 0
        );
      });
    },
    async releaseFailed(
      actor: GoldenActor,
      id: string,
      version: number,
      sandboxId: string,
      deletePhysical?: () => Promise<void>,
      freshAuthJson?: string,
    ) {
      return releaseFailed(actor, id, version, sandboxId, deletePhysical, freshAuthJson);
    },
    /** Trusted launch lifecycle only; never selected by request data. */
    async releaseNeverStarted(
      actor: GoldenActor,
      id: string,
      version: number,
      sandboxId: string,
      deletePhysical: () => Promise<void>,
    ) {
      return releaseFailed(actor, id, version, sandboxId, deletePhysical, undefined, true);
    },
    async releaseUnallocated(id: string, version: number, sandboxId: string): Promise<void> {
      if (!sql.transaction) throw new VaultError("unavailable", "Native cleanup requires transactions.");
      await sql.transaction(async (tx) => {
        const removed = await tx.query(
          `delete from public.model_auth_ownership o using public.model_auth_state state
           where o.account_id=$1::uuid and o.account_version=$2 and o.sandbox_id=$3::uuid
           and state.account_id=o.account_id and state.account_version=o.account_version
           and state.auth_revision=0 and state.source_generation='launch:unallocated'
           and not exists(select 1 from public.sandboxes s where s.id=o.sandbox_id) returning o.account_id`,
          [id, version, sandboxId],
        );
        if (removed.rows.length)
          await tx.query(
            "delete from public.model_auth_state where account_id=$1::uuid and account_version=$2 and auth_revision=0 and source_generation='launch:unallocated'",
            [id, version],
          );
      });
    },
    async bootstrap(actor: GoldenActor, id: string, version: number, sandboxId: string) {
      const enrolled = await sql.query("select 1 from public.model_auth_ownership where account_id=$1::uuid", [id]);
      if (!enrolled.rows.length)
        throw new VaultError(
          "credential_binding_required",
          "Native renewal state is unavailable for this legacy workspace. Stop it, explicitly import a fresh account version, then launch a new sandbox; archived output remains unavailable.",
        );
      await this.assertOwned(actor, id, version, sandboxId);
      const saved = await state.read(actor, id, version, sandboxId);
      return { authJson: saved?.authJson, revision: saved?.revision ?? 0, secrets: saved?.secrets ?? [] };
    },
    async capture(
      provider: Provider,
      providerId: string,
      caller: { userId: string; orgId: string },
      quiesced = false,
      allowStoppedSample = false,
    ): Promise<string[]> {
      const result = await sql.query<{
        id: string;
        owner_id: string;
        org_id: string;
        credential_id: string | null;
        credential_version: number | null;
        harness: string;
        kind: string | null;
        lifecycle_generation: number;
        current_version: number | null;
        current_status: string | null;
        expires_at: string | Date | null;
      }>(
        `select s.id,s.owner_id,s.org_id,s.credential_id,s.credential_version,s.harness,c.kind,s.lifecycle_generation,
         c.version as current_version,c.status as current_status,c.expires_at
         from public.sandboxes s left join public.credentials c on c.id=s.credential_id
         where s.provider=$1::public.sandbox_provider and s.provider_sandbox_id=$2 and s.org_id=$3::uuid
         and s.deleted_at is null and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$4::uuid)
         and (coalesce(s.visibility,(select visibility from public.goldens g where g.id=s.golden_id))='org' or s.owner_id=$4::uuid)`,
        [provider.id, providerId, caller.orgId, caller.userId],
      );
      if (result.rows.length > 1) throw new VaultError("conflict", "Ambiguous native source.");
      const row = result.rows[0];
      if (row?.harness === "codex" && (!row.credential_id || row.credential_version === null || !row.kind))
        throw new VaultError(
          "credential_binding_required",
          "Legacy Codex output has no trustworthy account binding. Stop it and launch a new sandbox with an explicit account.",
        );
      if (!row || row.kind !== "codex_auth" || !row.credential_id || row.credential_version === null) return [];
      const actor: GoldenActor = { userId: row.owner_id, orgId: row.org_id, role: "member" };
      if (broker && (await broker.enrolled(row.credential_id, row.credential_version)))
        return broker.secrets(row.credential_id, row.credential_version);
      const stoppedSecrets = (saved: { secrets: string[]; sourceGeneration: string } | undefined) => {
        if (provider.id === "boat" && !allowStoppedSample && !saved?.sourceGeneration.startsWith("boat:quiesced:"))
          throw new ProviderError({
            provider: "boat",
            code: "unavailable",
            retryable: true,
            message:
              "Native state synchronization is pending. Resume the sandbox to reconcile its private auth before reading archived output.",
          });
        return saved?.secrets ?? [];
      };
      // Explicit replacement/revocation invalidates publication, not the ability to stop old compute.
      if (
        row.current_status !== "active" ||
        row.current_version !== row.credential_version ||
        (row.expires_at !== null &&
          new Date(row.expires_at instanceof Date ? row.expires_at.getTime() : row.expires_at).getTime() <= now())
      ) {
        const known = await sql.query(
          "select 1 from public.model_auth_ownership where account_id=$1::uuid and account_version=$2 and sandbox_id=$3::uuid",
          [row.credential_id, row.credential_version, row.id],
        );
        const retained = await state.redactionState(actor, row.credential_id, row.credential_version, row.id);
        if (!known.rows.length && !retained)
          throw new VaultError(
            "credential_binding_required",
            "Legacy native output has no trustworthy secret registry. Stop the sandbox and reconnect with a fresh account version.",
          );
        const info = await provider.get(providerId);
        if (info.state === "stopped") return stoppedSecrets(retained);

        const generation =
          provider.id === "modal" ? await modalGeneration(sql, providerId, actor) : String(row.lifecycle_generation);
        const raw = await captureNative(provider, providerId, {}, quiesced);
        return state.retire({
          actor,
          accountId: row.credential_id,
          version: row.credential_version,
          sandboxId: row.id,
          authJson: raw,
          generation: `${provider.id}:${quiesced ? "quiesced:" : ""}${generation}`,
          verifySource: async (tx) => {
            const current = await tx.query<{ lifecycle_generation: number }>(
              "select lifecycle_generation from public.sandboxes where id=$1::uuid and deleted_at is null for update",
              [row.id],
            );
            if (
              current.rows[0]?.lifecycle_generation !== row.lifecycle_generation ||
              (provider.id === "modal" && (await modalGeneration(tx, providerId, actor, true)) !== generation)
            )
              throw new VaultError("conflict", "Retired native source changed.");
          },
        });
      }
      const binding = await this.bootstrap(actor, row.credential_id, row.credential_version, row.id);
      if (!binding) return []; // Unmanaged legacy workspaces retain their existing behavior.
      const info = await provider.get(providerId);
      if (info.state === "stopped")
        return stoppedSecrets(await state.read(actor, row.credential_id, row.credential_version, row.id));
      for (let attempt = 0; attempt < 3; attempt++) {
        const saved = await state.read(actor, row.credential_id, row.credential_version, row.id);
        const generation =
          provider.id === "modal" ? await modalGeneration(sql, providerId, actor) : String(row.lifecycle_generation);
        const authJson = await captureNative(provider, providerId, {}, quiesced);
        try {
          await state.publish({
            actor,
            accountId: row.credential_id,
            version: row.credential_version,
            sandboxId: row.id,
            generation: `${provider.id}:${quiesced ? "quiesced:" : ""}${generation}`,
            expectedRevision: saved?.revision ?? 0,
            authJson,
            verifySource: async (tx) => {
              const current = await tx.query<{ lifecycle_generation: number }>(
                "select lifecycle_generation from public.sandboxes where id=$1::uuid and deleted_at is null and credential_id=$2::uuid and credential_version=$3 for update",
                [row.id, row.credential_id, row.credential_version],
              );
              if (
                !current.rows[0] ||
                current.rows[0].lifecycle_generation !== row.lifecycle_generation ||
                (provider.id === "modal" && (await modalGeneration(tx, providerId, actor, true)) !== generation)
              )
                throw new VaultError("conflict", "Native source incarnation changed.");
            },
          });
          return (await state.read(actor, row.credential_id, row.credential_version, row.id))?.secrets ?? [];
        } catch (error) {
          if (!(error instanceof VaultError) || error.code !== "conflict" || attempt === 2) throw error;
        }
      }
      throw new VaultError("conflict", "Native auth publication is not acknowledged.");
    },
    async redactEvents(
      provider: Provider,
      providerId: string,
      caller: { userId: string; orgId: string },
      events: Awaited<ReturnType<Provider["events"]>>["events"],
    ) {
      const pendingCommand = async () => {
        const pending = await sql.query(
          `select 1 from public.sandboxes s join public.model_auth_state state
           on state.account_id=s.credential_id and state.account_version=s.credential_version
           where s.provider=$1::public.sandbox_provider and s.provider_sandbox_id=$2 and s.org_id=$3::uuid
           and s.activity_lease_id is not null and s.activity_until>now()`,
          [provider.id, providerId, caller.orgId],
        );
        if (pending.rows.length)
          throw new ProviderError({
            provider: provider.id,
            code: "unavailable",
            retryable: true,
            message: "Native output synchronization is pending. Retry after the current operation finishes.",
          });
      };
      await pendingCommand();
      const secrets = await this.capture(provider, providerId, caller);
      // Native renewal state only covers Codex. Match exec's static credential
      // redaction using the stored sandbox owner, never the viewing member.
      const owners = await sql.query<{ owner_id: string; org_id: string }>(
        `select s.owner_id,s.org_id from public.sandboxes s where s.provider=$1::public.sandbox_provider
         and s.provider_sandbox_id=$2 and s.org_id=$3::uuid and s.deleted_at is null
         and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$4::uuid)
         and (coalesce(s.visibility,(select visibility from public.goldens g where g.id=s.golden_id))='org' or s.owner_id=$4::uuid)`,
        [provider.id, providerId, caller.orgId, caller.userId],
      );
      if (owners.rows.length !== 1) throw new VaultError("not_found", "No authorized event owner.");
      const owner = owners.rows[0]!;
      secrets.push(
        ...(await exposedSecrets(createSqlVaultStore(sql), encryptionKey, {
          userId: owner.owner_id,
          orgId: owner.org_id,
        })),
      );
      await pendingCommand();
      const safe = (value: unknown): unknown => {
        if (typeof value === "string") return redact(value, secrets);
        if (Array.isArray(value)) return value.map(safe);
        if (value && typeof value === "object")
          return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secrets), safe(item)]));
        return value;
      };
      return events.map((event) => safe(event) as typeof event);
    },
    async beforeStop(provider: Provider, providerId: string, caller: { userId: string; orgId: string }) {
      if ((await provider.get(providerId)).state === "stopped") return;
      let secrets: string[];
      try {
        secrets = await this.capture(provider, providerId, caller);
      } catch (error) {
        // Stopping an unmanaged legacy writer is safe and is required before a
        // fresh explicit import. Never release its output or hydrate its tokens.
        if (error instanceof VaultError && error.code === "credential_binding_required") return;
        throw error;
      }
      if (provider.id !== "boat" || secrets.length === 0) return;
      if (
        broker &&
        (
          await sql.query(
            `select 1 from public.sandboxes s join public.model_auth_state a on a.account_id=s.credential_id and a.account_version=s.credential_version where s.provider=$1 and s.provider_sandbox_id=$2 and a.source_generation like 'server:%'`,
            [provider.id, providerId],
          )
        ).rows.length
      )
        return;
      await sshNativeAuthAdmission(provider, providerId, false);
      await this.capture(provider, providerId, caller, true);
    },
    async beforePrompt(provider: Provider, providerId: string, caller: { userId: string; orgId: string }) {
      await this.beforeResume(provider, providerId, caller);
      const secrets = await this.capture(provider, providerId, caller);
      if (
        provider.id === "boat" &&
        secrets.length > 0 &&
        !(
          broker &&
          (
            await sql.query(
              `select 1 from public.sandboxes s join public.model_auth_state a on a.account_id=s.credential_id and a.account_version=s.credential_version where s.provider=$1 and s.provider_sandbox_id=$2 and a.source_generation like 'server:%'`,
              [provider.id, providerId],
            )
          ).rows.length
        )
      )
        await sshNativeAuthAdmission(provider, providerId, true);
    },
    async publishFromModal(scope: Scope, claims: IngestGrantClaims, authJson: string, expectedRevision: number) {
      const result = await sql.query<{
        id: string;
        credential_id: string;
        credential_version: number;
        current_version: number | null;
        current_status: string | null;
        expires_at: string | Date | null;
      }>(
        `select s.id,s.credential_id,s.credential_version,c.version as current_version,c.status as current_status,c.expires_at
         from public.sandboxes s left join public.credentials c on c.id=s.credential_id
         join public.goldens g on g.id=s.golden_id
         where s.provider='modal' and s.provider_sandbox_id=$1 and s.org_id=$2::uuid and s.owner_id=$3::uuid
         and s.deleted_at is null and s.credential_id is not null and s.credential_version is not null
         and g.modal_workspace=$4 and g.modal_environment=$5 and g.modal_app_id=$6`,
        [
          claims.sandboxId,
          scope.orgId,
          scope.userId,
          scope.binding.workspace,
          scope.binding.environment,
          scope.binding.appId,
        ],
      );
      if (result.rows.length !== 1 || !result.rows[0])
        throw new VaultError("not_found", "No native publication binding.");
      const row = result.rows[0],
        actor: GoldenActor = { userId: scope.userId, orgId: scope.orgId, role: "member" };
      // Removed owners may finish ONLY the already-dispatched native checkpoint.
      // This cannot hydrate or claim a model account and is not a general member bypass.
      const authorizeCleanup = async (tx: Sql) => {
        const permitted = await tx.query(
          `select s.id from public.sandboxes s
           join public.orchestrators o on o.sandbox_id=s.id and o.owner_id=s.owner_id and o.org_id=s.org_id
           join public.orchestrator_operations p on p.orchestrator_id=o.id and p.revision=o.revision
           join public.modal_machines native on native.scope=$1 and native.id=s.provider_sandbox_id
             and native.org_id=s.org_id and native.owner_id=s.owner_id and native.record->>'generation'=$2
           where s.id=$3::uuid and s.credential_id=$4::uuid and s.credential_version=$5 and s.deleted_at is null
           and s.owner_id=$6::uuid and s.org_id=$7::uuid and s.provider='modal'
           and s.orchestrator_native_generation=$2 and o.state in ('stopping','blocked')
           and p.action='stop' and p.actor_id=o.owner_id and p.state in ('pending','uncertain')
           and p.runtime_result->>'state'='uncertain' and p.runtime_result->>'operationId'=p.id::text
           and p.runtime_result->>'orchestratorId'=o.id::text and p.runtime_result->>'sandboxId'=s.id::text
           and p.runtime_result->>'providerSandboxId'=s.provider_sandbox_id
           and p.runtime_result->>'generation'=s.lifecycle_generation::text
           and p.runtime_result->>'physicalGeneration'=$2
           for update of s,o,p,native`,
          [
            scopeKey(scope),
            claims.generation,
            row.id,
            row.credential_id,
            row.credential_version,
            scope.userId,
            scope.orgId,
          ],
        );
        if (!permitted.rows.length || claims.expiresAt <= now())
          throw new VaultError("forbidden", "Native checkpoint cleanup is fenced.");
      };
      if (
        row.current_version !== row.credential_version ||
        row.current_status !== "active" ||
        (row.expires_at !== null &&
          new Date(row.expires_at instanceof Date ? row.expires_at.getTime() : row.expires_at).getTime() <= now())
      ) {
        if (!sql.transaction) throw new VaultError("unavailable", "Native cleanup requires transactions.");
        await sql.transaction(async (tx) => {
          const member = await tx.query(`select 1 from public.members where org_id=$1 and user_id=$2 for share`, [
            scope.orgId,
            scope.userId,
          ]);
          if (!member.rows.length) {
            await authorizeCleanup(tx);
            return;
          }
          const permitted = await tx.query(
            `select s.id from public.sandboxes s
             join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
             join public.modal_machines native on native.scope=$1 and native.id=s.provider_sandbox_id
               and native.org_id=s.org_id and native.owner_id=s.owner_id and native.record->>'generation'=$2
             where s.id=$3::uuid and s.credential_id=$4::uuid and s.credential_version=$5 and s.deleted_at is null
             for update of s,native for share of m`,
            [scopeKey(scope), claims.generation, row.id, row.credential_id, row.credential_version],
          );
          if (!permitted.rows.length || claims.expiresAt <= now())
            throw new VaultError("forbidden", "Native cleanup source is no longer authorized.");
        });
        // The revoked/replaced binding cannot accept usable auth state. ACK only
        // permits private checkpoint scrubbing; the runtime has registered these
        // leaves before emission and sanitizes its journal before snapshotting.
        return { authRevision: expectedRevision, committed: true, discarded: true };
      }
      try {
        const revision = await state.publish({
          actor,
          accountId: row.credential_id,
          version: row.credential_version,
          sandboxId: row.id,
          generation: `modal:${claims.generation}`,
          expectedRevision,
          authJson,
          cleanupAuthorization: authorizeCleanup,
          verifySource: async (tx) => {
            const pinned = await tx.query(
              "select id from public.sandboxes where id=$1::uuid and credential_id=$2::uuid and credential_version=$3 and deleted_at is null for update",
              [row.id, row.credential_id, row.credential_version],
            );
            if (!pinned.rows[0]) throw new VaultError("forbidden", "Native publication account binding changed.");
            const current = await tx.query(
              `select id from public.modal_machines where scope=$1 and id=$2 and org_id=$3::uuid and owner_id=$4::uuid
               and record->>'generation'=$5 for update`,
              [scopeKey(scope), claims.sandboxId, scope.orgId, scope.userId, claims.generation],
            );
            if (!current.rows[0] || claims.expiresAt <= now())
              throw new VaultError("forbidden", "Native publication source generation expired.");
          },
        });
        return { authRevision: revision, committed: true };
      } catch (error) {
        if (!(error instanceof VaultError) || error.code !== "conflict") throw error;
        const revision = await state.publicationRevision(
          actor,
          row.credential_id,
          row.credential_version,
          row.id,
          authorizeCleanup,
        );
        return { authRevision: revision, committed: false };
      }
    },
    /** Compatibility admission for legacy native homes, never shared-session enrollment. */
    async claimLegacy(
      actor: GoldenActor,
      id: string,
      version: number,
      sandboxId: string,
      transaction?: Sql,
    ): Promise<void> {
      if (!sql.transaction && !transaction)
        throw new VaultError("unavailable", "Native credential ownership requires transactions.");
      const claim = async (tx: Sql) => {
        const source = await authorize(tx, actor, id, version);
        // Named rows are not independent OAuth sessions when they contain the
        // same rotating token. Serialize this admission across credential IDs.
        await tx.query("lock table public.model_auth_ownership in share row exclusive mode");
        const incoming = JSON.parse(nativeState(await decryptSecret(new Uint8Array(source), encryptionKey)).authJson)
          .tokens.refresh_token;
        const peers = await tx.query<{ state_enc: Uint8Array }>(
          "select state_enc from public.model_auth_state where account_id<>$1::uuid limit 1001",
          [id],
        );
        if (peers.rows.length > 1000)
          throw new VaultError("unavailable", "Native identity admission requires registry maintenance.");
        for (const peer of peers.rows) {
          const saved = JSON.parse(await decryptSecret(new Uint8Array(peer.state_enc), encryptionKey)) as NativeState;
          if (saved.secrets.includes(incoming)) throw new VaultError("credential_busy", CREDENTIAL_BUSY_MESSAGE);
        }
        // A replaced legacy import has lost the old home's identity entirely.
        // Only same-row enrollment can prove those writers were quiesced.
        const unknownHistory = await tx.query(
          `select 1 from public.credentials c join public.credentials original on original.id=$1::uuid
           join public.sandboxes s on s.credential_id=c.id
           where c.id<>$1::uuid and c.kind='codex_auth' and c.scope=original.scope and c.owner_id=original.owner_id
           and s.credential_version is distinct from c.version
           and not exists(select 1 from public.model_auth_ownership o where o.account_id=c.id and o.account_version=c.version)
           limit 1`,
          [id],
        );
        if (unknownHistory.rows.length) throw new VaultError("credential_busy", CREDENTIAL_BUSY_MESSAGE);
        // A pre-enrollment home can already hold a newer token than its vault
        // import. Fence its upstream identity, not just that stale token string.
        const historical = await tx.query<{ value_enc: Uint8Array; same_owner: boolean }>(
          `select c.value_enc,(c.scope=original.scope and c.owner_id=original.owner_id) as same_owner
           from public.credentials c join public.credentials original on original.id=$1::uuid
           where c.kind='codex_auth' and c.id<>$1::uuid
           and exists(select 1 from public.sandboxes s where s.credential_id=c.id) limit 1001`,
          [id],
        );
        if (historical.rows.length > 1000)
          throw new VaultError("unavailable", "Native identity admission requires registry maintenance.");
        const incomingIdentity = JSON.parse(
          nativeState(await decryptSecret(new Uint8Array(source), encryptionKey)).authJson,
        ).tokens.account_id;
        for (const peer of historical.rows) {
          const peerTokens = JSON.parse(
            nativeState(await decryptSecret(new Uint8Array(peer.value_enc), encryptionKey)).authJson,
          ).tokens;
          // Imported identity labels are not proof of another user's identity.
          // Across owners require an exact secret match, not a forgeable label.
          if (peerTokens.refresh_token === incoming || (peer.same_owner && peerTokens.account_id === incomingIdentity))
            throw new VaultError("credential_busy", CREDENTIAL_BUSY_MESSAGE);
        }
        const previous = (
          await tx.query<{ sandbox_id: string; account_version: number }>(
            "select sandbox_id,account_version from public.model_auth_ownership where account_id=$1::uuid for update",
            [id],
          )
        ).rows[0];
        const sameOwner = previous?.sandbox_id === sandboxId && Number(previous.account_version) === version;
        // A612-bound home can predate203 and already hold a rotated token. Never
        // infer unused credentials from an empty ownership table or a stopped label.
        // The credential lock serializes new admissions; also lock every historical
        // binding before deciding whether an explicit fresh version may be seeded.
        const bindings = await tx.query<{
          id: string;
          credential_version: number | null;
          status: string;
          stopped_at: unknown;
          deleted_at: unknown;
          activity_lease_id: string | null;
          stop_requested_at: unknown;
        }>(
          `select id,credential_version,status::text,stopped_at,deleted_at,activity_lease_id,stop_requested_at
           from public.sandboxes where credential_id=$1::uuid
           and not ($4::boolean and id=$3::uuid and credential_version is not distinct from $2)
           order by id for update`,
          [id, version, sandboxId, sameOwner],
        );
        for (const binding of bindings.rows) {
          if (binding.id === sandboxId) throw new VaultError("credential_busy", CREDENTIAL_BUSY_MESSAGE);
          if (binding.credential_version === null || Number(binding.credential_version) >= version)
            throw new VaultError("credential_busy", CREDENTIAL_BUSY_MESSAGE);
          const terminal =
            (binding.status === "stopped" && binding.stopped_at !== null) ||
            (binding.status === "deleted" && binding.deleted_at !== null) ||
            binding.status === "failed";
          if (!terminal || binding.activity_lease_id !== null || binding.stop_requested_at !== null)
            throw new VaultError("credential_busy", CREDENTIAL_BUSY_MESSAGE);
          // authenticated can edit status/timestamps. A fresh import is not
          // permission to trust those labels while an old native writer lives.
          if (!historicalProvider) throw new VaultError("credential_busy", CREDENTIAL_BUSY_MESSAGE);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const controller = new AbortController();
          try {
            const proof = (async () => {
              const target = await historicalProvider(tx, binding.id);
              let observed: Awaited<ReturnType<Provider["get"]>>;
              try {
                observed = await target.provider.get(target.providerSandboxId, { signal: controller.signal });
              } catch (error) {
                if (error instanceof ProviderError && error.code === "not_found") return true;
                throw error;
              }
              return (
                observed.id === target.providerSandboxId &&
                (observed.state === "stopped" || observed.physicalExitConfirmed === true)
              );
            })();
            const quiescent = await Promise.race([
              proof,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(new VaultError("unavailable", "Historical native observation timed out."));
                }, 10_000);
                timer.unref();
              }),
            ]);
            if (!quiescent) throw new VaultError("credential_busy", CREDENTIAL_BUSY_MESSAGE);
          } catch (error) {
            if (error instanceof VaultError) throw error;
            throw new VaultError("unavailable", "Historical native quiescence could not be verified.");
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
        await tx.query(
          `insert into public.model_auth_ownership(account_id,account_version,sandbox_id)
           values($1::uuid,$2,$3::uuid) on conflict(account_id) do nothing`,
          [id, version, sandboxId],
        );
        const found = await tx.query<{ sandbox_id: string; account_version: number }>(
          "select sandbox_id,account_version from public.model_auth_ownership where account_id=$1::uuid for update",
          [id],
        );
        let row = found.rows[0];
        if (row && Number(row.account_version) !== version) {
          const stopped = await tx.query(
            "select id from public.sandboxes where id=$1::uuid and (status='stopped' and stopped_at is not null or status='deleted' and deleted_at is not null or status='failed') for update",
            [row.sandbox_id],
          );
          if (stopped.rows.length) {
            await tx.query(
              "update public.model_auth_ownership set account_version=$2,sandbox_id=$3::uuid,assigned_at=now() where account_id=$1::uuid",
              [id, version, sandboxId],
            );
            row = { sandbox_id: sandboxId, account_version: version };
          }
        }
        if (!row || row.sandbox_id !== sandboxId || Number(row.account_version) !== version)
          throw new VaultError("credential_busy", CREDENTIAL_BUSY_MESSAGE);
        await state.initialize(tx, id, version, await decryptSecret(new Uint8Array(source), encryptionKey));
      };
      if (transaction) await claim(transaction);
      else await sql.transaction!(claim);
    },
    /** Uses the persisted binding, never the current default or imported auth file. */
    async assertSandbox(actor: GoldenActor, sandboxId: string, _resuming: boolean, _userExec = false): Promise<void> {
      const result = await sql.query<{
        credential_id: string | null;
        credential_version: number | null;
        harness: string;
        kind: string | null;
      }>(
        `select s.credential_id,s.credential_version,s.harness,c.kind
         from public.sandboxes s left join public.credentials c on c.id=s.credential_id
         where s.id=$1::uuid and s.owner_id=$2::uuid and s.org_id=$3::uuid and s.deleted_at is null
`,
        [sandboxId, actor.userId, actor.orgId],
      );
      const row = result.rows[0];
      if (!row) throw new VaultError("not_found", "No native sandbox binding.");
      if (row.harness === "codex" && (!row.credential_id || row.credential_version === null || !row.kind))
        throw new VaultError(
          "credential_binding_required",
          "Legacy Codex renewal has no trustworthy account binding. Stop it and launch a new sandbox with an explicit account.",
        );
      if (!row.credential_id || row.credential_version === null || row.kind !== "codex_auth") return;
      if (broker && (await broker.enrolled(row.credential_id, row.credential_version))) {
        await sql.transaction!(async (tx) => {
          await authorize(tx, actor, row.credential_id!, row.credential_version!);
        });
        return;
      }
      const known = await sql.query(
        "select 1 from public.model_auth_ownership where account_id=$1::uuid and (not $3::boolean or account_version=$2)",
        [row.credential_id, row.credential_version, _userExec],
      );
      if (known.rows.length) {
        if (_userExec) {
          const current = await sql.query(
            `select 1 from public.sandboxes s join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
             join public.model_auth_state state on state.account_id=s.credential_id and state.account_version=s.credential_version
             where s.credential_id=$1::uuid and s.credential_version=$2 and s.id=$3::uuid
             and s.org_id=$4::uuid and s.owner_id=$5::uuid and s.deleted_at is null`,
            [row.credential_id, row.credential_version, sandboxId, actor.orgId, actor.userId],
          );
          if (!current.rows.length)
            throw new VaultError("not_found", "Native redaction owner is no longer authorized.");
        } else await this.assertOwned(actor, row.credential_id, Number(row.credential_version), sandboxId, true);
      } else if (!_userExec) {
        throw new VaultError(
          "credential_binding_required",
          "Legacy native renewal is not enrolled. Stop the sandbox, import a fresh account version, then launch a new sandbox.",
        );
      }
    },
    /** Called at the provider's actual pre-resume/restore boundary, not a racy preflight. */
    async beforeResume(provider: Provider, providerId: string, caller: { userId: string; orgId: string }) {
      const result = await sql.query<{
        id: string;
        owner_id: string;
        org_id: string;
        application_secret_tainted: boolean;
      }>(
        `select s.id,s.owner_id,s.org_id,s.application_secret_tainted from public.sandboxes s
         where s.provider=$1::public.sandbox_provider and s.provider_sandbox_id=$2
         and s.org_id=$3::uuid and s.deleted_at is null
         and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$4::uuid)
         and (coalesce(s.visibility,(select g.visibility from public.goldens g where g.id=s.golden_id))='org'
              or s.owner_id=$4::uuid)`,
        [provider.id, providerId, caller.orgId, caller.userId],
      );
      if (result.rows.length > 1) throw new VaultError("conflict", "Ambiguous native sandbox identity.");
      const row = result.rows[0];
      // No sandbox row means a golden builder, which never receives model auth.
      if (row) {
        if (row.application_secret_tainted)
          throw new ProviderError({
            provider: provider.id,
            code: "unavailable",
            message: "Application-secret exposed sandboxes cannot resume or restore retained disks.",
            retryable: false,
          });
        try {
          await this.assertSandbox({ userId: row.owner_id, orgId: row.org_id, role: "member" }, row.id, true);
        } catch (error) {
          if (error instanceof VaultError)
            throw new ProviderError({
              provider: provider.id,
              code:
                error.code === "conflict" || error.code === "credential_busy"
                  ? "conflict"
                  : error.code === "not_found"
                    ? "not_found"
                    : "unavailable",
              message: error.message,
              retryable: false,
            });
          throw error;
        }
      }
    },
    /** Run before every send/resume, after pinned-account authorization. */
    async assertOwned(
      actor: GoldenActor,
      id: string,
      version: number,
      sandboxId: string,
      admitTurn = false,
    ): Promise<void> {
      if (!sql.transaction) throw new VaultError("unavailable", "Native credential ownership requires transactions.");
      await sql.transaction(async (tx) => {
        await authorize(tx, actor, id, version);
        const found = await tx.query<{ sandbox_id: string; account_version: number }>(
          "select sandbox_id,account_version from public.model_auth_ownership where account_id=$1::uuid",
          [id],
        );
        const row = found.rows[0];
        if (!row || row.sandbox_id !== sandboxId || Number(row.account_version) !== version)
          throw new VaultError(
            "conflict",
            "This sandbox no longer owns its subscription session. Stop it and launch a new sandbox with the intended account.",
          );
        // Admission itself destroys the initial launch's no-native-work proof.
        // A later dispatch may be accepted even when its receipt/publication is lost.
        // Bootstrap only checks ownership; it must not invalidate pre-start cleanup.
        if (admitTurn)
          await tx.query(
            "update public.model_auth_state set source_generation='admission:turn' where account_id=$1::uuid and account_version=$2 and source_generation in ('launch:unallocated','launch:never-started')",
            [id, version],
          );
      });
    },
  };
}
export type ModelAuthOwnership = ReturnType<typeof createModelAuthOwnership>;

/** Honest UI capability: consent runs in the user's native CLI, never this service. */
export const modelAuthCapabilities = {
  hostedOAuth: false,
  nativeCLI: { codex_auth: "armada creds login codex" },
  nativeSubscriptionParallelSandboxes: false,
  nativeSubscriptionResume: true,
  nativeSubscriptionExec: true,
  claude: {
    login: null,
    import: "armada creds import claude --name <name> --file <private-token-file>",
    preparation: "Run the official claude setup-token locally. Model-only tokens cannot read profile allowance.",
  },
  codex: {
    login: "armada creds login codex --name <name>",
    import: "armada creds import codex --name <name> --file <private-auth-json>",
    preparation: "Install official Codex locally. Device login requires an eligible ChatGPT account.",
  },
  provisioning:
    "Hosted OAuth and rotating-session reassignment require approved provider eligibility and private refresh-state transport.",
} as const;
