import type { CredentialBinding, GoldenActor, Harness, Sql } from "@armada/core/server";
import { VaultError } from "@armada/core/server";
import { admitAccountCapacity, admitLaunchAccount, releaseAccountCapacity } from "./account-capacity.ts";
import { chooseLaunchPoolAccount, type LaunchAccountDefault, readLaunchAccountDefault } from "./launch-account-pool.ts";
import { createNativeStateStore } from "./model-auth-state.ts";
import { createSubscriptionBroker } from "./subscription-broker.ts";

/**
 * Private subscription state and redaction. Subscription accounts are shared;
 * account authorization and sandbox pins do not confer exclusive ownership.
 */
export function createModelAuthOwnership(
  sql: Sql,
  encryptionKey?: string,
  now: () => number = Date.now,
  subscription?: {
    origin: string;
    fetch?: typeof fetch;
    prepareAccount?(actor: GoldenActor, id: string, version: number): Promise<void>;
  },
) {
  const state = createNativeStateStore(sql, encryptionKey);
  const broker = subscription
    ? createSubscriptionBroker(sql, encryptionKey, subscription.origin, subscription.fetch, subscription.prepareAccount)
    : undefined;
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
    launchAccountDefault: (userId: string, harness: Harness) => readLaunchAccountDefault(sql, userId, harness),
    chooseLaunchPoolAccount: (userId: string, harness: Harness, preference: LaunchAccountDefault) =>
      chooseLaunchPoolAccount(sql, userId, harness, preference, now),
    async admitCapacity(accountId: string, sandboxId: string, model?: string) {
      await sql.transaction!((tx) => admitAccountCapacity(tx, accountId, sandboxId, model));
    },
    async admitLaunch(binding: CredentialBinding, sandboxId: string, model?: string) {
      await sql.transaction!((tx) => admitLaunchAccount(tx, binding, sandboxId, model, now));
    },
    async admitSandboxCapacity(sandboxId: string) {
      await sql.transaction!(async (tx) => {
        const row = (
          await tx.query<{ credential_id: string | null }>("select credential_id from public.sandboxes where id=$1", [
            sandboxId,
          ])
        ).rows[0];
        if (row?.credential_id) await admitAccountCapacity(tx, row.credential_id, sandboxId);
      });
    },
    releaseCapacity: (sandboxId: string) => releaseAccountCapacity(sql, sandboxId),
    async bootstrap(actor: GoldenActor, id: string, version: number, sandboxId: string) {
      await sql.transaction!(async (tx) => {
        await authorize(tx, actor, id, version);
      });
      const saved = await state.read(actor, id, version, sandboxId);
      return { authJson: saved?.authJson, revision: saved?.revision ?? 0, secrets: saved?.secrets ?? [] };
    },
    async assertSandbox(actor: GoldenActor, sandboxId: string, _resuming: boolean, _userExec = false) {
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
  };
}
export type ModelAuthOwnership = ReturnType<typeof createModelAuthOwnership>;

/** Honest UI capability: consent runs in the user's native CLI, never this service. */
export const modelAuthCapabilities = {
  hostedOAuth: false,
  nativeCLI: { codex_auth: "armada account login codex" },
  nativeSubscriptionParallelSandboxes: true,
  nativeSubscriptionResume: true,
  nativeSubscriptionExec: true,
  claude: {
    login: null,
    import: "armada account import claude --name <name> --file <private-token-file>",
    preparation: "Run the official claude setup-token locally. Model-only tokens cannot read profile allowance.",
  },
  codex: {
    login: "armada account login codex --name <name>",
    import: "armada account import codex --name <name> --file <private-auth-json>",
    preparation: "Install official Codex locally. Device login requires an eligible ChatGPT account.",
  },
  provisioning:
    "Hosted OAuth and rotating-session reassignment require approved provider eligibility and private refresh-state transport.",
} as const;
