import type { GoldenActor, Provider, Sql } from "@armada/core/server";
import {
  createSqlVaultStore,
  ProviderError,
  redact,
  sshNativeAuthAdmission,
  sshPrivateAuthState,
  VaultError,
} from "@armada/core/server";

import type { IngestGrantClaims, Scope } from "@armada/provider-modal";
import { scopeKey } from "@armada/provider-modal";
import { exposedSecrets } from "./launch-credentials.ts";
import { createNativeStateStore } from "./model-auth-state.ts";
import { createSubscriptionBroker } from "./subscription-broker.ts";

/**
 * Private subscription state and redaction. Subscription accounts are shared;
 * account authorization and sandbox pins do not confer exclusive ownership.
 */
export function createModelAuthOwnership(
  sql: Sql,
  encryptionKey?: string,
  captureNative: typeof sshPrivateAuthState = sshPrivateAuthState,
  now: () => number = Date.now,
  subscription?: { origin: string; fetch?: typeof fetch },
) {
  const state = createNativeStateStore(sql, encryptionKey);
  const broker = subscription
    ? createSubscriptionBroker(sql, encryptionKey, subscription.origin, subscription.fetch)
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
            `select 1 from public.sandboxes s join public.model_auth_state state
          on state.account_id=s.credential_id and state.account_version=s.credential_version
          where s.id=$1::uuid limit 1`,
            [sandboxId],
          )
        ).rows.length > 0
      );
    },
    async bootstrap(actor: GoldenActor, id: string, version: number, sandboxId: string) {
      await sql.transaction!(async (tx) => {
        await authorize(tx, actor, id, version);
      });
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
        const retained = await state.redactionState(actor, row.credential_id, row.credential_version, row.id);
        if (!retained)
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
      // Once adopted, only the broker publishes renewal state. An old runner's
      // checkpoint may be acknowledged/scrubbed but cannot overwrite shared auth.
      if (broker && (await broker.enrolled(row.credential_id, row.credential_version)))
        return { authRevision: expectedRevision, committed: true, discarded: true };
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
        if (broker && (await broker.enrolled(row.credential_id, row.credential_version)))
          return { authRevision: revision, committed: true, discarded: true };
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
      if (_userExec) return; // Redaction-only shell inspection does not hydrate model credentials.
      await sql.transaction!(async (tx) => {
        await authorize(tx, actor, row.credential_id!, row.credential_version!);
      });
      if (broker) await broker.enroll(actor, row.credential_id, row.credential_version);
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
  };
}
export type ModelAuthOwnership = ReturnType<typeof createModelAuthOwnership>;

/** Honest UI capability: consent runs in the user's native CLI, never this service. */
export const modelAuthCapabilities = {
  hostedOAuth: false,
  nativeCLI: { codex_auth: "armada creds login codex" },
  nativeSubscriptionParallelSandboxes: true,
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
