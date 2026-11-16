import { ACCOUNT_WORKING_PREDICATE, accountWorkingCountSql, type Sql, VaultError } from "@armada/core/server";

/** Caller holds the account row lock. Pending allocations count until their outcome is known. */
export async function admitAccountCapacity(
  tx: Sql,
  accountId: string,
  sandboxId: string,
  model?: string,
): Promise<void> {
  const account = (
    await tx.query<{ name: string; max_agents: number | null; model_limits: Record<string, number> }>(
      "select name,max_agents,model_limits from public.credentials where id=$1 for update",
      [accountId],
    )
  ).rows[0];
  if (!account) return;
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
  if (current.rows.length) return; // Replays of accepted work keep their slot after a limit is lowered.
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
