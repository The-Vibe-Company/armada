import {
  type GoldenActor,
  type Provider,
  ProviderError,
  type Sql,
  sshNativeAuthAdmission,
  sshPrivateAuthState,
  VaultError,
} from "@armada/core/server";
import { configureBoatSubscription } from "./subscription-boat.ts";
import { type SubscriptionConfiguration, SubscriptionTemporaryError } from "./subscription-broker.ts";

type Target = { provider: Provider; providerSandboxId: string };
type Source = {
  id: string;
  org_id: string;
  owner_id: string;
  credential_id: string;
  credential_version: number | null;
  lifecycle_generation: number;
  provider: string;
  provider_sandbox_id: string | null;
};
export interface SubscriptionMigrationTransports {
  admission: typeof sshNativeAuthAdmission;
  read: typeof sshPrivateAuthState;
  configure: typeof configureBoatSubscription;
}
export interface SubscriptionMigrationAuthority {
  configuration(actor: GoldenActor, accountId: string, version: number, sandboxId: string): SubscriptionConfiguration;
  transferLegacy(
    actor: GoldenActor,
    accountId: string,
    version: number,
    authJson: string,
    verifySource: (tx: Sql) => Promise<void>,
  ): Promise<unknown>;
}
/** Upgrade observable native writers, never reserve an account or require historical cleanup. */
export function createSubscriptionMigration(
  sql: Sql,
  resolveStoredSandbox: (sql: Sql, id: string) => Promise<Target>,
  observe: (
    provider: Provider,
    id: string,
    caller: { userId: string; orgId: string },
    quiesced: boolean,
  ) => Promise<unknown>,
  authority: SubscriptionMigrationAuthority,
  transports: SubscriptionMigrationTransports = {
    admission: sshNativeAuthAdmission,
    read: sshPrivateAuthState,
    configure: configureBoatSubscription,
  },
) {
  const pending = new Map<string, Promise<void>>();
  async function recheck(source: Source, tx: Sql = sql) {
    const current = await tx.query(
      `select s.id from public.sandboxes s join public.credentials c on c.id=s.credential_id
       where s.id=$1 and s.org_id=$2 and s.owner_id=$3 and s.credential_id=$4
       and s.credential_version is not distinct from $5::integer and s.lifecycle_generation=$6
       and s.provider::text=$7 and s.provider_sandbox_id=$8 and s.deleted_at is null
       and ((c.scope='user' and c.owner_id=s.owner_id) or (c.scope='org' and c.owner_id=s.org_id))
       and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=s.owner_id) for update of s`,
      [
        source.id,
        source.org_id,
        source.owner_id,
        source.credential_id,
        source.credential_version,
        source.lifecycle_generation,
        source.provider,
        source.provider_sandbox_id,
      ],
    );
    if (!current.rows.length) throw new VaultError("conflict", "Subscription sandbox changed during native upgrade.");
  }
  async function upgradeBoat(source: Source, target: Target, version: number) {
    const actor: GoldenActor = { userId: source.owner_id, orgId: source.org_id, role: "member" };
    const grant = authority.configuration(actor, source.credential_id, version, source.id);
    const mode = await transports.read(target.provider, target.providerSandboxId, {}, false, grant.capability);
    if (mode === "null") return;
    await recheck(source);
    // Drain the old process before private observation. Pending configuration
    // already has its scoped grant but still needs the paused legacy marker removed.
    await transports.admission(target.provider, target.providerSandboxId, false);
    let transferError: unknown;
    if (mode !== "pending") {
      await observe(target.provider, target.providerSandboxId, actor, true);
      const latest = await transports.read(target.provider, target.providerSandboxId, {}, true, grant.capability);
      if (latest !== "null" && latest !== "pending") {
        try {
          await authority.transferLegacy(actor, source.credential_id, version, latest, (tx) => recheck(source, tx));
        } catch (error) {
          transferError = error;
        }
      }
    }
    // A received temporary vendor failure did not spend this observed token.
    // Keep it private and paused so the next automatic attempt can hand it off.
    if (transferError instanceof SubscriptionTemporaryError) throw transferError;
    // Even an uncertain upstream renewal must not leave an independent native
    // refresh writer behind. Keep its observed leaves sealed, then remove raw auth.
    await recheck(source);
    const account = await sql.query(
      "select id from public.credentials where id=$1 and version=$2 and status='active' and (expires_at is null or expires_at>now())",
      [source.credential_id, version],
    );
    if (!account.rows.length) throw new VaultError("conflict", "Subscription account changed during native upgrade.");
    await transports.configure(target.provider, target.providerSandboxId, grant);
    if ((await transports.read(target.provider, target.providerSandboxId, {}, false, grant.capability)) !== "null")
      throw new VaultError("unavailable", "Subscription native upgrade could not be confirmed.");
    await recheck(source);
    if (transferError) throw transferError;
  }
  async function waitStopped(target: Target) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new VaultError("unavailable", "Subscription native stop is not confirmed.");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopped = await Promise.race([
        target.provider.get(target.providerSandboxId, { signal: AbortSignal.timeout(remaining) }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new VaultError("unavailable", "Subscription native stop is not confirmed.")),
            remaining,
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (stopped.id !== target.providerSandboxId)
        throw new VaultError("conflict", "Subscription provider identity changed.");
      if (stopped.state === "stopped") return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
    }
  }
  async function upgrade(source: Source, target: Target, version: number) {
    if (target.provider.id !== source.provider || target.providerSandboxId !== source.provider_sandbox_id)
      throw new VaultError("conflict", "Subscription provider binding changed.");
    const physical = await target.provider.get(target.providerSandboxId, { signal: AbortSignal.timeout(10_000) });
    if (physical.id !== target.providerSandboxId)
      throw new VaultError("conflict", "Subscription provider identity changed.");
    if (physical.state === "stopped") return;
    if (source.credential_version !== version || target.provider.id === "modal") {
      // Older/unknown pins are not repointed. Stopping prevents future native
      // rotations when possible; Modal stop publishes its private checkpoint.
      await recheck(source);
      try {
        await target.provider.stop({ sandboxId: target.providerSandboxId });
      } catch (error) {
        if (
          !(
            target.provider.id === "modal" &&
            error instanceof ProviderError &&
            error.provider === "modal" &&
            error.providerCode === "lifecycle_lease_busy"
          )
        )
          throw error;
        // Another replica owns the healthy stop/checkpoint. Observe completion,
        // never redispatch stop and consume its provider recovery budget.
      }
      if (target.provider.id === "modal") await waitStopped(target);
      else {
        const stopped = await target.provider.get(target.providerSandboxId, { signal: AbortSignal.timeout(10_000) });
        if (stopped.id !== target.providerSandboxId || stopped.state !== "stopped")
          throw new VaultError("unavailable", "Subscription native stop is not confirmed.");
      }
      return;
    }
    if (target.provider.id === "boat") await upgradeBoat(source, target, version);
  }
  function once(source: Source, target: Target, version: number) {
    const key = `${source.id}:${source.lifecycle_generation}:${version}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const work = upgrade(source, target, version).finally(() => {
      if (pending.get(key) === work) pending.delete(key);
    });
    pending.set(key, work);
    return work;
  }
  return {
    async prepareAccount(actor: GoldenActor, id: string, version: number) {
      const allowed = await sql.query(
        `select c.id from public.credentials c where c.id=$1 and c.version=$2 and c.status='active' and c.kind='codex_auth'
         and (c.expires_at is null or c.expires_at>now())
         and ((c.scope='user' and c.owner_id=$3) or (c.scope='org' and c.owner_id=$4))
         and exists(select 1 from public.members m where m.user_id=$3 and m.org_id=$4)`,
        [id, version, actor.userId, actor.orgId],
      );
      if (!allowed.rows.length)
        throw new VaultError("credential_refused", "The subscription account is no longer authorized.");
      const sources = await sql.query<Source>(
        `select s.id,s.org_id,s.owner_id,s.credential_id,s.credential_version,s.lifecycle_generation,s.provider::text,s.provider_sandbox_id
         from public.sandboxes s join public.credentials c on c.id=s.credential_id where c.id=$1
         and s.harness='codex' and s.deleted_at is null and s.status not in ('failed','stopped','deleted')
         and ((c.scope='user' and s.owner_id=c.owner_id) or (c.scope='org' and s.org_id=c.owner_id)) order by s.id`,
        [id],
      );
      for (const source of sources.rows) {
        try {
          await once(source, await resolveStoredSandbox(sql, source.id), version);
        } catch (error) {
          if (error instanceof SubscriptionTemporaryError) throw error;
          /* Unknown/absent history never becomes a new account admission refusal. */
        }
      }
    },
    async prepareTurn(provider: Provider, id: string, caller: { userId: string; orgId: string }) {
      if (provider.id !== "boat") return;
      const sources = await sql.query<Source>(
        `select s.id,s.org_id,s.owner_id,s.credential_id,s.credential_version,s.lifecycle_generation,s.provider::text,s.provider_sandbox_id
         from public.sandboxes s join public.credentials c on c.id=s.credential_id and c.version=s.credential_version
         where s.harness='codex' and s.provider='boat' and s.provider_sandbox_id=$1 and s.org_id=$2 and s.deleted_at is null
         and c.kind='codex_auth' and c.status='active' and (c.expires_at is null or c.expires_at>now())
         and ((c.scope='user' and c.owner_id=s.owner_id) or (c.scope='org' and c.owner_id=s.org_id))
         and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$3)
         and (coalesce(s.visibility,(select g.visibility from public.goldens g where g.id=s.golden_id))='org' or s.owner_id=$3)`,
        [id, caller.orgId, caller.userId],
      );
      if (!sources.rows.length) return;
      if (sources.rows.length !== 1) throw new VaultError("conflict", "Subscription native source is ambiguous.");
      const source = sources.rows[0]!;
      await once(source, { provider, providerSandboxId: id }, source.credential_version!);
    },
  };
}
