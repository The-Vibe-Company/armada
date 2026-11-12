import { decryptSecret, encryptSecret, type GoldenActor, type Sql, VaultError } from "@armada/core/server";

export interface NativeState {
  authJson: string;
  secrets: string[];
  retired?: boolean;
  brokerDeliveries?: Record<string, number>;
}
export function nativeState(raw: string): NativeState {
  try {
    if (Buffer.byteLength(raw) > 65536) throw Error();
    const value = JSON.parse(raw);
    if (
      !value.tokens ||
      typeof value.tokens.refresh_token !== "string" ||
      typeof value.tokens.access_token !== "string" ||
      typeof value.tokens.account_id !== "string"
    )
      throw Error();
    const leaves = (v: unknown): string[] =>
      typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(leaves) : [];
    return { authJson: raw, secrets: [raw, ...leaves(value)] };
  } catch {
    throw new VaultError("invalid", "Invalid private native auth state.");
  }
}

/** No public DTO or user JWT can reach plaintext from this store. */
export function createNativeStateStore(sql: Sql, key: string | undefined) {
  async function owner(
    tx: Sql,
    actor: GoldenActor,
    accountId: string,
    version: number,
    sandboxId: string,
    cleanupAuthorization?: (tx: Sql) => Promise<void>,
  ) {
    const member = await tx.query(
      "select user_id from public.members where user_id=$1::uuid and org_id=$2::uuid for share",
      [actor.userId, actor.orgId],
    );
    if (!member.rows.length) {
      if (!cleanupAuthorization) throw new VaultError("not_found", "Native state membership was revoked.");
      await cleanupAuthorization(tx);
    }
    const rows = await tx.query<{ value_enc: Uint8Array }>(
      `select c.value_enc from public.credentials c
       join public.sandboxes s on s.credential_id=c.id and s.credential_version=c.version
       where c.id=$1::uuid and c.version=$2 and c.status='active' and c.kind='codex_auth'
       and s.id=$3::uuid and s.owner_id=$4::uuid and s.org_id=$5::uuid and s.deleted_at is null
       and (c.expires_at is null or c.expires_at>now())
       and ((c.scope='user' and c.owner_id=$4::uuid) or (c.scope='org' and c.owner_id=$5::uuid))
       and ($6::boolean or exists(select 1 from public.members m where m.user_id=$4::uuid and m.org_id=$5::uuid))
       for update of c,s`,
      [accountId, version, sandboxId, actor.userId, actor.orgId, !member.rows.length && !!cleanupAuthorization],
    );
    const row = rows.rows[0];
    if (!row) throw new VaultError("not_found", "Private native state binding is no longer authorized.");
    return row.value_enc;
  }
  async function persist(tx: Sql, accountId: string, version: number, retained: NativeState) {
    if (Buffer.byteLength(JSON.stringify(retained)) > 4 * 1024 * 1024)
      throw new VaultError("unavailable", "Native secret redaction budget exceeded.");
    await tx.query(
      "update public.model_auth_state set state_enc=$3::bytea,updated_at=now() where account_id=$1::uuid and account_version=$2",
      [accountId, version, await encryptSecret(JSON.stringify(retained), key)],
    );
  }
  async function appendRedaction(
    tx: Sql,
    accountId: string,
    version: number,
    previous: NativeState,
    observed: NativeState,
    sandboxId: string,
  ) {
    const retained: NativeState = { ...previous, secrets: [...new Set([...previous.secrets, ...observed.secrets])] };
    if (previous.brokerDeliveries) {
      retained.brokerDeliveries = { ...previous.brokerDeliveries };
      delete retained.brokerDeliveries[sandboxId];
    }
    // Observing a native refresh-bearing home invalidates its earlier access-only
    // delivery proof without changing broker auth, revision or source ownership.
    await persist(tx, accountId, version, retained);
    return retained.secrets;
  }
  async function sharedState(tx: Sql, accountId: string, version: number): Promise<NativeState> {
    const result = await tx.query<{ state_enc: Uint8Array; source_generation: string }>(
      "select state_enc,source_generation from public.model_auth_state where account_id=$1::uuid and account_version=$2 for update",
      [accountId, version],
    );
    const row = result.rows[0];
    if (!row?.source_generation.startsWith("server:"))
      throw new VaultError("unavailable", "Shared private state is unavailable.");
    return JSON.parse(await decryptSecret(new Uint8Array(row.state_enc), key)) as NativeState;
  }
  return {
    /** Sealed evidence that this exact guest incarnation received access-only auth. */
    async recordBrokerDelivery(input: {
      accountId: string;
      version: number;
      sandboxId: string;
      generation: number | null;
      authorize(tx: Sql): Promise<void>;
    }): Promise<void> {
      if (!sql.transaction) throw new VaultError("unavailable", "Private delivery evidence requires transactions.");
      await sql.transaction(async (tx) => {
        await input.authorize(tx);
        const previous = await sharedState(tx, input.accountId, input.version);
        const retained: NativeState = {
          ...previous,
          brokerDeliveries: { ...previous.brokerDeliveries },
        };
        if (input.generation === null) delete retained.brokerDeliveries?.[input.sandboxId];
        else retained.brokerDeliveries![input.sandboxId] = input.generation;
        await persist(tx, input.accountId, input.version, retained);
      });
    },
    async hasBrokerDelivery(input: {
      accountId: string;
      version: number;
      sandboxId: string;
      generation: number;
      authorize(tx: Sql): Promise<void>;
    }): Promise<boolean> {
      if (!sql.transaction) throw new VaultError("unavailable", "Private delivery evidence requires transactions.");
      return sql.transaction(async (tx) => {
        await input.authorize(tx);
        const state = await sharedState(tx, input.accountId, input.version);
        return state.brokerDeliveries?.[input.sandboxId] === input.generation;
      });
    },
    /** Redaction may outlive authorization to hydrate or refresh the account. */
    async redactionState(actor: GoldenActor, accountId: string, version: number, sandboxId: string) {
      const result = await sql.query<{ state_enc: Uint8Array; source_generation: string }>(
        `select state.state_enc,state.source_generation from public.model_auth_state state
         join public.sandboxes s on s.credential_id=state.account_id and s.credential_version=state.account_version
         join public.members m on m.org_id=s.org_id and m.user_id=$4::uuid
         where state.account_id=$1::uuid and state.account_version=$2 and s.id=$3::uuid
         and s.owner_id=$4::uuid and s.org_id=$5::uuid and s.deleted_at is null`,
        [accountId, version, sandboxId, actor.userId, actor.orgId],
      );
      return result.rows[0]
        ? {
            secrets: (JSON.parse(await decryptSecret(new Uint8Array(result.rows[0].state_enc), key)) as NativeState)
              .secrets,
            sourceGeneration: result.rows[0].source_generation,
          }
        : undefined;
    },
    /** Shell execution can change auth even when it automatically resumes a VM. */
    async invalidateRedaction(actor: GoldenActor, sandboxId: string) {
      await sql.query(
        `update public.model_auth_state state set source_generation='redaction:unacknowledged-exec'
         from public.sandboxes s, public.members m
         where s.id=$1::uuid and s.owner_id=$2::uuid and s.org_id=$3::uuid and s.deleted_at is null
         and m.org_id=s.org_id and m.user_id=s.owner_id
         and state.account_id=s.credential_id and state.account_version=s.credential_version
         and state.source_generation not like 'server:%'`,
        [sandboxId, actor.userId, actor.orgId],
      );
    },
    /** Authenticated cleanup may retain leaves without reviving a replaced login. */
    async observeRedaction(input: {
      accountId: string;
      version: number;
      authJson: string;
      sandboxId: string;
      authorize(tx: Sql): Promise<void>;
    }): Promise<void> {
      const observed = nativeState(input.authJson);
      if (!sql.transaction) throw new VaultError("unavailable", "Private redaction state requires transactions.");
      await sql.transaction(async (tx) => {
        await input.authorize(tx);
        const result = await tx.query<{ state_enc: Uint8Array }>(
          "select state_enc from public.model_auth_state where account_id=$1::uuid and account_version=$2 for update",
          [input.accountId, input.version],
        );
        const row = result.rows[0];
        if (!row) throw new VaultError("unavailable", "Retired native identity is unknown.");
        const previous = JSON.parse(await decryptSecret(new Uint8Array(row.state_enc), key)) as NativeState;
        if (JSON.parse(previous.authJson).tokens.account_id !== JSON.parse(observed.authJson).tokens.account_id)
          throw new VaultError("conflict", "Retired native identity changed.");
        await appendRedaction(tx, input.accountId, input.version, previous, observed, input.sandboxId);
      });
    },
    /** Redaction-only retired state can never hydrate or revive a replaced/revoked binding. */
    async retire(input: {
      actor: GoldenActor;
      accountId: string;
      version: number;
      sandboxId: string;
      authJson: string;
      generation: string;
      verifySource(tx: Sql): Promise<void>;
    }): Promise<string[]> {
      const observed = nativeState(input.authJson);
      if (!sql.transaction) throw new VaultError("unavailable", "Private redaction state requires transactions.");
      return sql.transaction(async (tx) => {
        const allowed = await tx.query(
          `select c.id from public.credentials c
           join public.sandboxes s on s.credential_id=c.id
           join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
           where c.id=$1::uuid and s.credential_version=$2 and s.id=$3::uuid and s.owner_id=$4::uuid and s.org_id=$5::uuid
           and ((c.scope='user' and c.owner_id=$4::uuid) or (c.scope='org' and c.owner_id=$5::uuid))
           and (c.version<>$2 or c.status<>'active' or c.expires_at<=now())
           for update of c,s for share of m`,
          [input.accountId, input.version, input.sandboxId, input.actor.userId, input.actor.orgId],
        );
        if (!allowed.rows.length) throw new VaultError("not_found", "Retired native state is not authorized.");
        await input.verifySource(tx);
        const result = await tx.query<{ state_enc: Uint8Array; auth_revision: number; source_generation: string }>(
          "select state_enc,auth_revision,source_generation from public.model_auth_state where account_id=$1::uuid and account_version=$2 for update",
          [input.accountId, input.version],
        );
        const row = result.rows[0];
        if (!row) throw new VaultError("unavailable", "Retired native identity is unknown.");
        const previous = JSON.parse(await decryptSecret(new Uint8Array(row.state_enc), key)) as NativeState;
        if (JSON.parse(previous.authJson).tokens.account_id !== JSON.parse(observed.authJson).tokens.account_id)
          throw new VaultError("conflict", "Retired native identity changed.");
        if (row.source_generation.startsWith("server:"))
          return appendRedaction(tx, input.accountId, input.version, previous, observed, input.sandboxId);
        if (previous.retired && previous.authJson === observed.authJson) {
          await tx.query(
            "update public.model_auth_state set source_generation=$3,updated_at=now() where account_id=$1::uuid and account_version=$2",
            [input.accountId, input.version, input.generation],
          );
          return previous.secrets;
        }
        const retired: NativeState = {
          authJson: observed.authJson,
          secrets: [...new Set([...previous.secrets, ...observed.secrets])],
          retired: true,
        };
        if (Buffer.byteLength(JSON.stringify(retired)) > 4 * 1024 * 1024)
          throw new VaultError("unavailable", "Native secret redaction budget exceeded.");
        await tx.query(
          `update public.model_auth_state set state_enc=$3::bytea,auth_revision=auth_revision+1,source_generation=$4,updated_at=now()
          where account_id=$1::uuid and account_version=$2`,
          [input.accountId, input.version, await encryptSecret(JSON.stringify(retired), key), input.generation],
        );
        return retired.secrets;
      });
    },
    async read(actor: GoldenActor, accountId: string, version: number, sandboxId: string) {
      if (!sql.transaction) throw new VaultError("unavailable", "Private native state requires transactions.");
      return sql.transaction(async (tx) => {
        await owner(tx, actor, accountId, version, sandboxId);
        const result = await tx.query<{ state_enc: Uint8Array; auth_revision: number; source_generation: string }>(
          "select state_enc,auth_revision,source_generation from public.model_auth_state where account_id=$1::uuid and account_version=$2",
          [accountId, version],
        );
        const row = result.rows[0];
        if (!row) return undefined;
        const state = JSON.parse(await decryptSecret(new Uint8Array(row.state_enc), key)) as NativeState;
        nativeState(state.authJson);
        if (state.retired) throw new VaultError("conflict", "Native binding requires explicit reconnect.");
        return { ...state, revision: row.auth_revision, sourceGeneration: row.source_generation };
      });
    },
    /** Cleanup can reconcile an ACK revision, never hydrate private native auth. */
    async publicationRevision(
      actor: GoldenActor,
      accountId: string,
      version: number,
      sandboxId: string,
      cleanupAuthorization: (tx: Sql) => Promise<void>,
    ) {
      if (!sql.transaction) throw new VaultError("unavailable", "Native revision requires transactions.");
      return sql.transaction(async (tx) => {
        await owner(tx, actor, accountId, version, sandboxId, cleanupAuthorization);
        const result = await tx.query<{ auth_revision: number }>(
          "select auth_revision from public.model_auth_state where account_id=$1::uuid and account_version=$2",
          [accountId, version],
        );
        return result.rows[0]?.auth_revision ?? 0;
      });
    },
    async publish(input: {
      actor: GoldenActor;
      accountId: string;
      version: number;
      sandboxId: string;
      generation: string;
      expectedRevision: number;
      authJson: string;
      /** Private checkpoint-only service authorization; never accepted from runner JSON. */
      cleanupAuthorization?(tx: Sql): Promise<void>;
      /** Recheck the provider incarnation under this same transaction before sealed publication. */
      verifySource(tx: Sql): Promise<void>;
    }): Promise<number> {
      const next = nativeState(input.authJson);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
        throw new VaultError("invalid", "Invalid native auth revision.");
      if (!sql.transaction) throw new VaultError("unavailable", "Private native state requires transactions.");
      return sql.transaction(async (tx) => {
        const original = await owner(
          tx,
          input.actor,
          input.accountId,
          input.version,
          input.sandboxId,
          input.cleanupAuthorization,
        );
        const originalAuth = nativeState(await decryptSecret(new Uint8Array(original), key));
        if (JSON.parse(originalAuth.authJson).tokens.account_id !== JSON.parse(next.authJson).tokens.account_id)
          throw new VaultError("conflict", "Native identity changed; reconnect the account explicitly.");
        await input.verifySource(tx);
        const result = await tx.query<{ state_enc: Uint8Array; auth_revision: number; source_generation: string }>(
          "select state_enc,auth_revision,source_generation from public.model_auth_state where account_id=$1::uuid and account_version=$2 for update",
          [input.accountId, input.version],
        );
        const row = result.rows[0];
        // Account/state locks serialize this with broker adoption. A legacy
        // preflight may have run earlier, but never owns shared renewal writes.
        const previous = row
          ? (JSON.parse(await decryptSecret(new Uint8Array(row.state_enc), key)) as NativeState)
          : undefined;
        if (previous) {
          const oldAccount = JSON.parse(previous.authJson).tokens.account_id;
          if (oldAccount !== JSON.parse(next.authJson).tokens.account_id)
            throw new VaultError("conflict", "Native identity changed; reconnect the account explicitly.");
          if (row?.source_generation.startsWith("server:")) {
            await appendRedaction(tx, input.accountId, input.version, previous, next, input.sandboxId);
            return row.auth_revision;
          }
          // An ACK lost after COMMIT can be retried without another rotation or revision.
          if (previous.authJson === next.authJson) {
            await tx.query(
              "update public.model_auth_state set source_generation=$3,updated_at=now() where account_id=$1::uuid and account_version=$2",
              [input.accountId, input.version, input.generation],
            );
            return row?.auth_revision ?? 0;
          }
        }
        const revision = row?.auth_revision ?? 0;
        if (revision !== input.expectedRevision) throw new VaultError("conflict", "Native auth revision changed.");
        const state: NativeState = {
          authJson: next.authJson,
          secrets: [...new Set([...originalAuth.secrets, ...(previous?.secrets ?? []), ...next.secrets])],
        };
        if (Buffer.byteLength(JSON.stringify(state)) > 4 * 1024 * 1024)
          throw new VaultError("unavailable", "Native secret redaction budget exceeded.");
        const sealed = await encryptSecret(JSON.stringify(state), key);
        const nextRevision = revision + 1;
        await tx.query(
          `insert into public.model_auth_state(account_id,account_version,auth_revision,state_enc,source_generation)
          values($1::uuid,$2,$3,$4::bytea,$5) on conflict(account_id,account_version) do update
          set auth_revision=excluded.auth_revision,state_enc=excluded.state_enc,
          source_generation=excluded.source_generation,updated_at=now()`,
          [input.accountId, input.version, nextRevision, sealed, input.generation],
        );
        return nextRevision;
      });
    },
  };
}
export type NativeStateStore = ReturnType<typeof createNativeStateStore>;
