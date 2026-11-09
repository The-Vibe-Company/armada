import type { GoldenActor, Provider, Sql } from "@armada/core/server";
import { decryptSecret, ProviderError, sshPrivateAuthState, VaultError } from "@armada/core/server";

import type { IngestGrantClaims, Scope } from "@armada/provider-modal";
import { scopeKey } from "@armada/provider-modal";
import { createNativeStateStore } from "./model-auth-state.ts";

/**
 * Durable exclusive native-session ownership. Never expires or reassigns a
 * refresh-bearing session merely because a server crashed or a sandbox stopped.
 * API keys and model-only Claude tokens do not use this ownership gate.
 */
export function createModelAuthOwnership(
  sql: Sql,
  encryptionKey?: string,
  captureNative: typeof sshPrivateAuthState = sshPrivateAuthState,
  now: () => number = Date.now,
) {
  const state = createNativeStateStore(sql, encryptionKey);
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
    async managed(sandboxId: string): Promise<boolean> {
      return (
        (await sql.query("select 1 from public.model_auth_ownership where sandbox_id=$1::uuid limit 1", [sandboxId]))
          .rows.length > 0
      );
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
      if (!enrolled.rows.length) return undefined; // Legacy state is not silently rebound or replaced.
      await this.assertOwned(actor, id, version, sandboxId);
      const saved = await state.read(actor, id, version, sandboxId);
      return { authJson: saved?.authJson, revision: saved?.revision ?? 0 };
    },
    async capture(
      provider: Provider,
      providerId: string,
      caller: { userId: string; orgId: string },
    ): Promise<string[]> {
      const result = await sql.query<{
        id: string;
        owner_id: string;
        org_id: string;
        credential_id: string | null;
        credential_version: number | null;
        kind: string;
        lifecycle_generation: number;
        current_version: number | null;
        current_status: string | null;
        expires_at: string | Date | null;
      }>(
        `select s.id,s.owner_id,s.org_id,s.credential_id,s.credential_version,c.kind,s.lifecycle_generation,
         c.version as current_version,c.status as current_status,c.expires_at
         from public.sandboxes s left join public.credentials c on c.id=s.credential_id
         where s.provider=$1::public.sandbox_provider and s.provider_sandbox_id=$2 and s.org_id=$3::uuid
         and s.deleted_at is null and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$4::uuid)
         and (coalesce(s.visibility,(select visibility from public.goldens g where g.id=s.golden_id))='org' or s.owner_id=$4::uuid)`,
        [provider.id, providerId, caller.orgId, caller.userId],
      );
      if (result.rows.length > 1) throw new VaultError("conflict", "Ambiguous native source.");
      const row = result.rows[0];
      if (!row || row.kind !== "codex_auth" || !row.credential_id || row.credential_version === null) return [];
      const actor: GoldenActor = { userId: row.owner_id, orgId: row.org_id, role: "member" };
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
        if (!known.rows.length) return [];
        const info = await provider.get(providerId);
        if (info.state === "stopped") return []; // Never resume stopped compute just to redact.
        const generation =
          provider.id === "modal" ? await modalGeneration(sql, providerId, actor) : String(row.lifecycle_generation);
        const raw = await captureNative(provider, providerId);
        return state.retire({
          actor,
          accountId: row.credential_id,
          version: row.credential_version,
          sandboxId: row.id,
          authJson: raw,
          generation: `${provider.id}:${generation}`,
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
        return (await state.read(actor, row.credential_id, row.credential_version, row.id))?.secrets ?? [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const saved = await state.read(actor, row.credential_id, row.credential_version, row.id);
        const generation =
          provider.id === "modal" ? await modalGeneration(sql, providerId, actor) : String(row.lifecycle_generation);
        const authJson = await captureNative(provider, providerId);
        try {
          await state.publish({
            actor,
            accountId: row.credential_id,
            version: row.credential_version,
            sandboxId: row.id,
            generation: `${provider.id}:${generation}`,
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
    async beforePrompt(provider: Provider, providerId: string, caller: { userId: string; orgId: string }) {
      await this.beforeResume(provider, providerId, caller);
      await this.capture(provider, providerId, caller);
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
      if (
        row.current_version !== row.credential_version ||
        row.current_status !== "active" ||
        (row.expires_at !== null &&
          new Date(row.expires_at instanceof Date ? row.expires_at.getTime() : row.expires_at).getTime() <= now())
      ) {
        if (!sql.transaction) throw new VaultError("unavailable", "Native cleanup requires transactions.");
        await sql.transaction(async (tx) => {
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
        const current = await state.read(actor, row.credential_id, row.credential_version, row.id);
        return { authRevision: current?.revision ?? 0, committed: false };
      }
    },
    /** Must run after resolution, BEFORE provider fork/credential hydration. */
    async claim(actor: GoldenActor, id: string, version: number, sandboxId: string): Promise<void> {
      if (!sql.transaction) throw new VaultError("unavailable", "Native credential ownership requires transactions.");
      await sql.transaction(async (tx) => {
        const source = await authorize(tx, actor, id, version);
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
            "select id from public.sandboxes where id=$1::uuid and status='stopped' and stopped_at is not null for update",
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
          throw new VaultError(
            "conflict",
            "credential_busy: native session already belongs to another sandbox or revision.",
          );
        await state.initialize(tx, id, version, await decryptSecret(new Uint8Array(source), encryptionKey));
      });
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
      if (!row.credential_id || row.credential_version === null || row.kind !== "codex_auth") return;
      const known = await sql.query("select 1 from public.model_auth_ownership where account_id=$1::uuid", [
        row.credential_id,
      ]);
      if (known.rows.length) {
        if (_userExec) {
          const current = await sql.query(
            `select 1 from public.model_auth_ownership o join public.members m on m.org_id=$4::uuid and m.user_id=$5::uuid
             where o.account_id=$1::uuid and o.account_version=$2 and o.sandbox_id=$3::uuid`,
            [row.credential_id, row.credential_version, sandboxId, actor.orgId, actor.userId],
          );
          if (!current.rows.length)
            throw new VaultError("not_found", "Native redaction owner is no longer authorized.");
        } else await this.assertOwned(actor, row.credential_id, Number(row.credential_version), sandboxId);
      }
    },
    /** Called at the provider's actual pre-resume/restore boundary, not a racy preflight. */
    async beforeResume(provider: Provider, providerId: string, caller: { userId: string; orgId: string }) {
      const result = await sql.query<{ id: string; owner_id: string; org_id: string }>(
        `select s.id,s.owner_id,s.org_id from public.sandboxes s
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
        try {
          await this.assertSandbox({ userId: row.owner_id, orgId: row.org_id, role: "member" }, row.id, true);
        } catch (error) {
          if (error instanceof VaultError)
            throw new ProviderError({
              provider: provider.id,
              code: error.code === "conflict" ? "conflict" : error.code === "not_found" ? "not_found" : "unavailable",
              message: error.message,
              retryable: false,
            });
          throw error;
        }
      }
    },
    /** Run before every send/resume, after pinned-account authorization. */
    async assertOwned(actor: GoldenActor, id: string, version: number, sandboxId: string): Promise<void> {
      if (!sql.transaction) throw new VaultError("unavailable", "Native credential ownership requires transactions.");
      await sql.transaction(async (tx) => {
        await authorize(tx, actor, id, version);
        const found = await tx.query<{ sandbox_id: string; account_version: number }>(
          "select sandbox_id,account_version from public.model_auth_ownership where account_id=$1::uuid",
          [id],
        );
        const row = found.rows[0];
        if (!row || row.sandbox_id !== sandboxId || Number(row.account_version) !== version)
          throw new VaultError("conflict", "credential_busy: native session ownership does not match this sandbox.");
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
