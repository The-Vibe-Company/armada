import {
  type AccountCandidate,
  type CredentialKind,
  choose,
  type Harness,
  harnessesForCredential,
  VaultError,
} from "@armada/core";
import type { Sql } from "@armada/core/server";

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

export async function chooseLaunchPoolAccount(
  sql: Sql,
  userId: string,
  harness: Harness,
  preference: LaunchAccountDefault,
  now: () => number,
) {
  const { credentialIds, model } = preference;
  const { rows } = await sql.query<{
    id: string;
    kind: CredentialKind;
    version: number;
    status: string;
    expires_at: Date | string | null;
    code: string | null;
    resets_at: Date | string | null;
  }>(
    `select c.id,c.kind,c.version,c.status,c.expires_at,e.code,e.resets_at
     from public.credentials c
     left join public.account_exhaustion e on e.account_id=c.id and e.account_version=c.version
     where c.id=any($1::uuid[]) and c.scope='user' and c.owner_id=$2`,
    [credentialIds, userId],
  );
  const candidates = new Map<string, AccountCandidate>(
    rows.map((row) => [
      row.id,
      {
        scope: "user",
        version: row.version,
        status: row.status,
        expiresAt: row.expires_at == null ? null : new Date(row.expires_at).toISOString(),
        harnesses: harnessesForCredential(row.kind),
        ...(row.code && row.resets_at != null
          ? { exhaustion: { version: row.version, code: row.code, resetsAt: new Date(row.resets_at).toISOString() } }
          : {}),
      },
    ]),
  );
  const decision = choose({ harness, credentialIds, model }, undefined, { candidates, now: now() });
  if (decision.kind === "account") return decision;

  const reasons = decision.skips.map(({ reason }, index) =>
    reason.code === "account_exhausted"
      ? `#${index + 1}: exhausted until ${reason.resetsAt}`
      : `#${index + 1}: ${reason.code}`,
  );
  throw new VaultError("conflict", `No eligible account in the launch pool (${reasons.join(", ")}).`);
}
