import {
  type AccountCandidate,
  type AccountPool,
  type AccountSkip,
  type CredentialKind,
  choose,
  type Harness,
  harnessesForCredential,
  LaunchError,
  MODEL_CATALOG,
  OPENCODE_CONNECTION_PROVIDER,
  VaultError,
} from "@armada/core";
import type { Sql } from "@armada/core/server";
import { AccountCapacityRefusal, type CapacityAccount, checkAccountLimits } from "./account-capacity.ts";

export interface LaunchAccountDefault {
  credentialId: string | null;
  credentialIds: string[];
  model: string | null;
}

export async function readLaunchAccountDefault(sql: Sql, userId: string, harness: Harness) {
  return (
    await sql.query<LaunchAccountDefault>(
      `select credential_id as "credentialId", credential_ids as "credentialIds", model
       from public.agent_defaults where user_id=$1 and harness=$2`,
      [userId, harness],
    )
  ).rows[0];
}

async function readPoolAccounts(sql: Sql, userId: string, ids: readonly string[]) {
  const { rows } = await sql.query<
    CapacityAccount & {
      id: string;
      kind: CredentialKind;
      version: number;
      status: string;
      expires_at: Date | string | null;
      code: string | null;
      resets_at: Date | string | null;
    }
  >(
    `select c.id,c.kind,c.name,c.version,c.status,c.expires_at,c.max_agents,c.model_limits,e.code,e.resets_at
     from public.credentials c
     left join public.account_exhaustion e on e.account_id=c.id and e.account_version=c.version
     where c.id=any($1::uuid[]) and c.scope='user' and c.owner_id=$2`,
    [ids, userId],
  );
  return new Map(
    rows.map((row) => {
      const candidate: AccountCandidate = {
        scope: "user",
        version: row.version,
        status: row.status,
        expiresAt: row.expires_at == null ? null : new Date(row.expires_at).toISOString(),
        harnesses: harnessesForCredential(row.kind),
        ...(row.code && row.resets_at != null
          ? { exhaustion: { version: row.version, code: row.code, resetsAt: new Date(row.resets_at).toISOString() } }
          : {}),
      };
      return [row.id, { ...row, ...candidate }];
    }),
  );
}

export async function chooseLaunchPoolAccount(
  sql: Sql,
  userId: string,
  harness: Harness,
  preference: LaunchAccountDefault,
  now: () => number,
) {
  const { credentialIds, model } = preference;
  const candidates = await readPoolAccounts(sql, userId, credentialIds);
  const decision = choose({ harness, credentialIds, model }, undefined, { candidates, now: now() });
  if (decision.kind === "account") return decision;
  throw poolRefusal(decision.skips);
}

function poolRefusal(skips: AccountSkip[]) {
  const reasons = skips.map(({ reason }, index) =>
    reason.code === "account_exhausted"
      ? `#${index + 1}: exhausted until ${reason.resetsAt}`
      : `#${index + 1}: ${reason.code}`,
  );
  return new VaultError("credential_refused", `No eligible account in the launch pool (${reasons.join(", ")}).`);
}

export async function admitAccount<T extends { credentialVersion: number; model: string }>(
  tx: Sql,
  userId: string,
  pool: AccountPool,
  sandboxId: string,
  prepared: ReadonlyMap<string, T>,
) {
  // WARNING: Keep lock acquisition in ID order and read capacity after the lock statement.
  const locked = await tx.query<{ id: string }>(
    `select id from public.credentials
     where id=any($1::uuid[]) and scope='user' and owner_id=$2 order by id for update`,
    [pool.credentialIds, userId],
  );
  const candidates = await readPoolAccounts(
    tx,
    userId,
    locked.rows.map(({ id }) => id),
  );
  const skips: AccountSkip[] = [];
  const now = Date.now();
  for (const credentialId of pool.credentialIds) {
    const decision = choose({ ...pool, credentialIds: [credentialId] }, undefined, { candidates, now });
    if (decision.kind !== "account") {
      skips.push(...decision.skips);
      continue;
    }
    const candidate = prepared.get(credentialId);
    if (!candidate) {
      skips.push({ credentialId, reason: { code: "incompatible_model" } });
      continue;
    }
    if (candidate.credentialVersion !== decision.credentialVersion) {
      skips.push({ credentialId, reason: { code: "account_version_changed" } });
      continue;
    }
    try {
      await checkAccountLimits(tx, candidates.get(credentialId)!, credentialId, sandboxId, candidate.model);
      return { credentialId, candidate, skips };
    } catch (error) {
      if (!(error instanceof AccountCapacityRefusal)) throw error;
      skips.push({ credentialId, reason: { code: error.reason } });
    }
  }
  throw poolRefusal(skips);
}

function poolCandidateRefused(error: unknown) {
  if (error instanceof VaultError) return ["credential_refused", "missing_credential", "invalid"].includes(error.code);
  return (
    error instanceof LaunchError &&
    error.code === "invalid_request" &&
    (error.message.startsWith("Choose a Morph plan model") ||
      error.message.startsWith(`Choose an ${OPENCODE_CONNECTION_PROVIDER}/<model>`))
  );
}

export async function preparePoolCandidates<T>(
  sql: Sql,
  userId: string,
  pool: AccountPool,
  prepare: (credentialId: string, model: string) => Promise<T>,
) {
  const model = pool.model ?? MODEL_CATALOG[pool.harness].defaultModel;
  const prepared = new Map<string, T>();
  for (const credentialId of new Set(pool.credentialIds)) {
    try {
      prepared.set(credentialId, await prepare(credentialId, model));
    } catch (error) {
      if (!poolCandidateRefused(error)) throw error;
    }
  }
  if (prepared.size) return prepared;

  const candidates = await readPoolAccounts(sql, userId, pool.credentialIds);
  const now = Date.now();
  throw poolRefusal(
    pool.credentialIds.flatMap((credentialId) => {
      const decision = choose({ ...pool, credentialIds: [credentialId] }, undefined, { candidates, now });
      const incompatible: AccountSkip = { credentialId, reason: { code: "incompatible_model" } };
      return decision.kind === "account" ? [incompatible] : decision.skips;
    }),
  );
}
