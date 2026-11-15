import { type Sql, VaultError } from "@armada/core/server";

/** Caller holds the account row lock. Pending allocations count until their outcome is known. */
export async function admitAccountCapacity(tx: Sql, accountId: string, sandboxId: string): Promise<void> {
  const account = (
    await tx.query<{ name: string; max_agents: number | null }>(
      "select name,max_agents from public.credentials where id=$1 for update",
      [accountId],
    )
  ).rows[0];
  if (!account || account.max_agents == null) return;
  const current = await tx.query(
    "select id from public.sandboxes where id=$1 and credential_id=$2 and deleted_at is null and stopped_at is null and status in ('starting','ready','running')",
    [sandboxId, accountId],
  );
  if (current.rows.length) return; // Existing agents keep running after a limit is lowered.
  const result = await tx.query<{ running: string | number }>(
    `select count(*) as running from (
      select id from public.sandboxes where credential_id=$1 and id<>$2
        and deleted_at is null and stopped_at is null and status in ('starting','ready','running')
      union select r.sandbox_id from public.account_agent_reservations r
        where r.account_id=$1 and r.sandbox_id<>$2
        and not exists(select 1 from public.sandboxes s where s.id=r.sandbox_id and s.deleted_at is null and s.stopped_at is null and s.status in ('starting','ready','running'))
    ) active`,
    [accountId, sandboxId],
  );
  const running = Number(result.rows[0]?.running ?? 0);
  if (running >= account.max_agents)
    throw new VaultError(
      "conflict",
      `Account ${account.name} is at its limit: ${running}/${account.max_agents} agents running; stop one, raise the limit, or pick another account.`,
    );
  await tx.query(
    "insert into public.account_agent_reservations(sandbox_id,account_id) values($1,$2) on conflict(sandbox_id) do nothing",
    [sandboxId, accountId],
  );
}
