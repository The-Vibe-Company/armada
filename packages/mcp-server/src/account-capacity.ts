import {
  ACCOUNT_WORKING_PREDICATE,
  accountWorkingCountSql,
  type CredentialBinding,
  type Sql,
  VaultError,
} from "@armada/core/server";

interface CapacityAccount {
  name: string;
  max_agents: number | null;
  model_limits: Record<string, number>;
}

/** New allocations check quota health before reserving capacity for the resolved binding. */
export async function admitLaunchAccount(
  tx: Sql,
  binding: CredentialBinding,
  sandboxId: string,
  model?: string,
  now: () => number = Date.now,
) {
  const account = (
    await tx.query<CapacityAccount & { resets_at: Date | string | null }>(
      `select c.name,c.max_agents,c.model_limits,e.resets_at from public.credentials c
       left join public.account_exhaustion e on e.account_id=c.id and e.account_version=c.version
       where c.id=$1 and c.version=$2 for update of c`,
      [binding.credentialId, binding.credentialVersion],
    )
  ).rows[0];
  if (!account) throw new VaultError("credential_refused", "The selected credential changed before launch.");
  const reset = account.resets_at == null ? undefined : new Date(account.resets_at);
  if (reset && reset.getTime() > now())
    throw new VaultError("conflict", `Account ${account.name} is exhausted until ${reset.toISOString()}.`);
  await reserveAccountCapacity(tx, account, binding.credentialId, sandboxId, model);
}

export async function admitAccountCapacity(tx: Sql, accountId: string, sandboxId: string, model?: string) {
  const account = (
    await tx.query<CapacityAccount>(
      "select name,max_agents,model_limits from public.credentials where id=$1 for update",
      [accountId],
    )
  ).rows[0];
  if (account) await reserveAccountCapacity(tx, account, accountId, sandboxId, model);
}

async function reserveAccountCapacity(
  tx: Sql,
  account: CapacityAccount,
  accountId: string,
  sandboxId: string,
  model?: string,
) {
  if (!Object.keys(account.model_limits ?? {}).length && account.max_agents == null) return;
  if (Object.keys(account.model_limits ?? {}).length)
    model ??= (await tx.query<{ model: string }>("select model from public.sandboxes where id=$1", [sandboxId])).rows[0]
      ?.model;
  const modelLimit = model ? account.model_limits?.[model] : undefined;
  const current = await tx.query(
    `select s.id from public.sandboxes s where s.id=$1 and s.credential_id=$2 and ${ACCOUNT_WORKING_PREDICATE}
     union select r.sandbox_id from public.account_agent_reservations r where r.sandbox_id=$1 and r.account_id=$2
       and not exists(select 1 from public.sandboxes ended where ended.id=r.sandbox_id
         and (ended.deleted_at is not null or ended.stopped_at is not null)
          and not exists(select 1 from public.account_turn_queue q where q.sandbox_id=ended.id
            and q.state='dispatching' and q.dispatch_generation=ended.lifecycle_generation))`,
    [sandboxId, accountId],
  );
  if (current.rows.length) return;
  const result = await tx.query<{ running: string | number }>(
    `select ${accountWorkingCountSql("$1", "$2")} as running`,
    [accountId, sandboxId],
  );
  const running = Number(result.rows[0]?.running ?? 0);
  if (account.max_agents != null && running >= account.max_agents)
    throw new VaultError(
      "conflict",
      `Account ${account.name} is at its limit: ${running}/${account.max_agents} agents working; wait for a turn to finish, raise the limit, or pick another account.`,
    );
  if (modelLimit !== undefined) {
    const used = Number(
      (
        await tx.query<{ running: string }>(`select ${accountWorkingCountSql("$1", "$2", "$3")} as running`, [
          accountId,
          sandboxId,
          model,
        ])
      ).rows[0]?.running ?? 0,
    );
    if (used >= modelLimit)
      throw new VaultError(
        "conflict",
        `Model ${model} on account ${account.name} is at its limit: ${used}/${modelLimit} agents working.`,
      );
  }
  await tx.query(
    "insert into public.account_agent_reservations(sandbox_id,account_id,model) values($1,$2,$3) on conflict(sandbox_id) do nothing",
    [sandboxId, accountId, model ?? null],
  );
}
