import {
  type GoldenActor,
  type Provider,
  type Sql,
  sshNativeAuthAdmission,
  sshPrivateAuthState,
  VaultError,
} from "@armada/core/server";
import { nativeWorkspaceCommandPending, recordNativeWorkspaceCommand, settleNativeWorkspaceCommand } from "./data.ts";
import {
  hasStrictNativeDrainStop,
  requestNativeSubscriptionStop,
  STRICT_NATIVE_DRAIN_STOP,
} from "./sandbox-lifecycle.ts";
import { captureFinalOutputs } from "./sandbox-outputs.ts";
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
  provider: "boat" | "modal";
  provider_sandbox_id: string | null;
};
function needsSubscriptionCheckpoint(source: Source) {
  return source.provider === "modal";
}
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
/** Upgrade observable native writers, never reserve an account or require historical cleanup.
 * Armada runtime guests already use epoch-fenced access-only auth; never run native
 * SSH inspection, drain or stable-capability installation against those guests. */
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
  async function recheckLocked(source: Source, tx: Sql, activeBoat = false) {
    const current = await tx.query<{ stop_generation: string }>(
      `select s.stop_generation::text as stop_generation from public.sandboxes s join public.credentials c on c.id=s.credential_id
       where s.id=$1 and s.org_id=$2 and s.owner_id=$3 and s.credential_id=$4
       and s.credential_version is not distinct from $5::integer and s.lifecycle_generation=$6
       and not s.boat_runtime and s.runtime_transport is distinct from 'dialout'
       and s.provider::text=$7 and s.provider_sandbox_id=$8 and s.deleted_at is null and not s.native_drain_pending
       and (not $9::boolean or (s.provider='boat' and s.status in ('starting','ready','running')
         and s.stop_requested_at is null and s.stopped_at is null))
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
        activeBoat,
      ],
    );
    const [row] = current.rows;
    if (!row) throw new VaultError("conflict", "Subscription sandbox changed during native upgrade.");
    // Read the marker after taking the sandbox lock so an admission that won
    // the lock while this statement was waiting is visible.
    if (await hasStrictNativeDrainStop(tx, source.id))
      throw new VaultError("conflict", "Native sandbox preservation is pending.");
    return row.stop_generation;
  }
  async function recheck(source: Source) {
    if (!sql.transaction) throw new VaultError("unavailable", "Subscription native upgrade requires transactions.");
    await sql.transaction(async (tx) => {
      await recheckLocked(source, tx);
    });
  }
  async function upgradeBoat(source: Source, target: Target, version: number) {
    const actor: GoldenActor = { userId: source.owner_id, orgId: source.org_id, role: "member" };
    const grant = authority.configuration(actor, source.credential_id, version, source.id);
    const readMode = () => transports.read(target.provider, target.providerSandboxId, {}, false, grant.capability);
    if ((await readMode()) === "null") return;
    const transaction = sql.transaction?.bind(sql);
    if (!transaction) throw new VaultError("unavailable", "Subscription native upgrade requires transactions.");
    const stopEpoch = await transaction(async (tx) => {
      const currentEpoch = await recheckLocked(source, tx, true);
      if (!(await recordNativeWorkspaceCommand(tx, source.id, source.lifecycle_generation)))
        throw new SubscriptionTemporaryError();
      return currentEpoch;
    });
    const recheckCommand = async (tx: Sql) => {
      if ((await recheckLocked(source, tx, true)) !== stopEpoch)
        throw new VaultError("conflict", "Subscription sandbox stopped during native upgrade.");
    };
    const settleCommand = () =>
      transaction(async (tx) => {
        await recheckCommand(tx);
        if (!(await settleNativeWorkspaceCommand(tx, source.id, source.lifecycle_generation)))
          throw new VaultError("conflict", "Native workspace command evidence changed.");
      });
    const settleAndRetry = async (error: SubscriptionTemporaryError) => {
      await settleCommand().catch(() => {});
      throw error;
    };
    const mode = await readMode().catch(() => settleAndRetry(new SubscriptionTemporaryError()));
    if (mode === "null") {
      await settleCommand();
      return;
    }
    await transaction(recheckCommand);
    // Drain the old process before private observation. Pending configuration
    // already has its scoped grant but still needs the paused legacy marker removed.
    await transports.admission(target.provider, target.providerSandboxId, false);
    let transferError: unknown;
    if (mode !== "pending") {
      await transaction(recheckCommand);
      await observe(target.provider, target.providerSandboxId, actor, true);
      await transaction(recheckCommand);
      const latest = await transports.read(target.provider, target.providerSandboxId, {}, true, grant.capability);
      if (latest !== "null" && latest !== "pending") {
        try {
          await authority.transferLegacy(actor, source.credential_id, version, latest, recheckCommand);
        } catch (error) {
          transferError = error;
        }
      }
    }
    // A received temporary vendor failure did not spend this observed token.
    // Keep it private and paused so the next automatic attempt can hand it off.
    if (transferError instanceof SubscriptionTemporaryError) await settleAndRetry(transferError);
    // Even an uncertain upstream renewal must not leave an independent native
    // refresh writer behind. Keep its observed leaves sealed, then remove raw auth.
    const account = await sql.query(
      "select id from public.credentials where id=$1 and version=$2 and status='active' and (expires_at is null or expires_at>now())",
      [source.credential_id, version],
    );
    if (!account.rows.length) throw new VaultError("conflict", "Subscription account changed during native upgrade.");
    await transaction(recheckCommand);
    await transports.configure(target.provider, target.providerSandboxId, grant);
    await transaction(recheckCommand);
    if ((await readMode()) !== "null")
      throw new VaultError("unavailable", "Subscription native upgrade could not be confirmed.");
    await settleCommand();
    if (transferError) throw transferError;
  }
  async function subscriptionStopPending(tx: Sql, source: Source) {
    const pending = await tx.query(
      `select s.id from public.sandboxes s where s.id=$1 and s.status='stopping' and s.stop_requested_at is not null
       and s.reconcile_after < 'infinity'::timestamptz
       and s.provider=$7 and s.provider_sandbox_id=$2 and s.credential_id=$3
       and s.credential_version is not distinct from $4::integer
       and s.org_id=$5 and s.owner_id=$6 and s.deleted_at is null and not s.native_drain_pending
       and not s.boat_runtime and s.runtime_transport is distinct from 'dialout'
       and not ${STRICT_NATIVE_DRAIN_STOP}
       and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=s.owner_id)
       and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)`,
      [
        source.id,
        source.provider_sandbox_id,
        source.credential_id,
        source.credential_version,
        source.org_id,
        source.owner_id,
        source.provider,
      ],
    );
    return pending.rows.length > 0;
  }
  async function handOffSubscriptionStop(source: Source) {
    if (!sql.transaction) throw new VaultError("unavailable", "Subscription native upgrade requires transactions.");
    let verified = false;
    let retry: boolean;
    try {
      retry = await sql.transaction(async (tx) => {
        await recheckLocked(source, tx);
        verified = true;
        return (
          (await requestNativeSubscriptionStop(tx, source.id, source.lifecycle_generation, source.provider)) ||
          needsSubscriptionCheckpoint(source) ||
          (await subscriptionStopPending(tx, source))
        );
      });
    } catch (error) {
      if (!verified) throw error;
      throw new SubscriptionTemporaryError();
    }
    if (retry) throw new SubscriptionTemporaryError();
  }
  async function upgrade(source: Source, target: Target, version: number) {
    if (target.provider.id !== source.provider || target.providerSandboxId !== source.provider_sandbox_id)
      throw new VaultError("conflict", "Subscription provider binding changed.");
    await recheck(source);
    const physical = await target.provider.get(target.providerSandboxId, { signal: AbortSignal.timeout(10_000) });
    if (physical.id !== target.providerSandboxId)
      throw new VaultError("conflict", "Subscription provider identity changed.");
    if (physical.state === "stopped") return;
    await recheck(source);
    if (needsSubscriptionCheckpoint(source)) {
      await handOffSubscriptionStop(source);
      return;
    }
    if (source.credential_version !== version) {
      await captureFinalOutputs(sql, target.provider, source.id, { signal: AbortSignal.timeout(10_000) }).catch(
        () => {},
      );
      await handOffSubscriptionStop(source);
      return;
    }
    await upgradeBoat(source, target, version);
  }
  async function once(source: Source, resolve: () => Target | Promise<Target>, version: number) {
    await recheck(source);
    const key = `${source.id}:${source.lifecycle_generation}:${version}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const work = Promise.resolve()
      .then(resolve)
      .then((target) => upgrade(source, target, version))
      .finally(() => {
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
         and s.harness='codex' and s.provider in ('boat','modal') and not s.boat_runtime
         and s.runtime_transport is distinct from 'dialout' and s.deleted_at is null and s.status not in ('failed','stopped','deleted')
         and ((c.scope='user' and s.owner_id=c.owner_id) or (c.scope='org' and s.org_id=c.owner_id)) order by s.id`,
        [id],
      );
      for (const source of sources.rows) {
        try {
          await once(source, () => resolveStoredSandbox(sql, source.id), version);
        } catch (error) {
          if (error instanceof SubscriptionTemporaryError) throw error;
          // WARNING: A competing admission can advance the generation before this replica rechecks its source.
          const requiresStop = needsSubscriptionCheckpoint(source) || source.credential_version !== version;
          const unresolved = requiresStop
            ? await subscriptionStopPending(sql, source)
            : await nativeWorkspaceCommandPending(sql, source.id);
          if (unresolved) throw new SubscriptionTemporaryError();
        }
      }
    },
    async prepareTurn(provider: Provider, id: string, caller: { userId: string; orgId: string }) {
      if (provider.id !== "boat") return;
      const sources = await sql.query<Source>(
        `select s.id,s.org_id,s.owner_id,s.credential_id,s.credential_version,s.lifecycle_generation,s.provider::text,s.provider_sandbox_id
         from public.sandboxes s join public.credentials c on c.id=s.credential_id and c.version=s.credential_version
         where s.harness='codex' and not s.boat_runtime and s.runtime_transport is distinct from 'dialout' and s.provider='boat' and s.provider_sandbox_id=$1 and s.org_id=$2 and s.deleted_at is null
         and c.kind='codex_auth' and c.status='active' and (c.expires_at is null or c.expires_at>now())
         and ((c.scope='user' and c.owner_id=s.owner_id) or (c.scope='org' and c.owner_id=s.org_id))
         and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$3)
         and (coalesce(s.visibility,(select g.visibility from public.goldens g where g.id=s.golden_id))='org' or s.owner_id=$3)`,
        [id, caller.orgId, caller.userId],
      );
      if (!sources.rows.length) return;
      if (sources.rows.length !== 1) throw new VaultError("conflict", "Subscription native source is ambiguous.");
      const source = sources.rows[0]!;
      await once(source, () => ({ provider, providerSandboxId: id }), source.credential_version!);
    },
  };
}
