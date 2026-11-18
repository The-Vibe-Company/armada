import { isFinalPromptStatus, type Provider, type Sql } from "@armada/core/server";

/** Observe durable native turn identities independently of stop/current-task state.
 * The resolver retains owner/source authority, including for terminal machines.
 */
export function createNativeWebhookPrompts(
  sql: Sql,
  providerFor: (id: string) => Promise<Pick<Provider, "id" | "getPrompt">>,
) {
  const pending = new Set<Promise<boolean>>();
  let stopped = false;
  async function observe(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    // A final claim whose worker was cancelled or crashed leaves an expired lease
    // on an exhausted receipt that no claim will ever select again. Releasing the
    // lease and counting the drop in one statement makes the accounting exactly-once:
    // a live settlement needs the lease, and a released lease is never re-finalized.
    await sql.query(
      `with exhausted as (
        update public.native_webhook_prompts p set lease_id=null,lease_until=null
        from (
          select sandbox_id,prompt_id from public.native_webhook_prompts
          where completed_at is null and failures>=5 and lease_id is not null and lease_until<now()
          for update skip locked limit 100
        ) x where p.sandbox_id=x.sandbox_id and p.prompt_id=x.prompt_id
        returning p.org_id
      ) insert into public.org_langfuse_export_stats as stats(org_id,dropped)
        select e.org_id,count(*) from exhausted e join public.org_langfuse c on c.org_id=e.org_id and c.enabled
        group by e.org_id
        on conflict(org_id) do update set dropped=stats.dropped+excluded.dropped`,
    );
    signal.throwIfAborted();
    const lease = crypto.randomUUID();
    const row = (
      await sql.query<{
        sandbox_id: string;
        prompt_id: string;
        provider: string;
        provider_sandbox_id: string;
      }>(
        `with candidate as (
          select p.sandbox_id,p.prompt_id from public.native_webhook_prompts p
          join public.sandboxes s on s.id=p.sandbox_id
          where p.completed_at is null and p.failures<5 and p.next_attempt_at<=now()
            and (p.lease_until is null or p.lease_until<now())
            and s.provider=p.provider and s.provider_sandbox_id=p.provider_sandbox_id
            and s.owner_id=p.owner_id and s.org_id=p.org_id
            and not s.boat_runtime and s.runtime_transport is distinct from 'dialout'
            and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=s.owner_id)
          order by p.next_attempt_at,p.sandbox_id,p.prompt_id for update of p skip locked limit 1
        ) update public.native_webhook_prompts p set failures=p.failures+1,lease_id=$1::uuid,lease_until=now()+interval '60 seconds'
          from candidate c where p.sandbox_id=c.sandbox_id and p.prompt_id=c.prompt_id
          returning p.sandbox_id,p.prompt_id,p.provider,p.provider_sandbox_id`,
        [lease],
      )
    ).rows[0];
    if (!row) return false;
    let status: string | null = null;
    let failed = false;
    try {
      signal.throwIfAborted();
      const provider = await providerFor(row.sandbox_id);
      signal.throwIfAborted();
      if (provider.id !== row.provider) throw Error("Native receipt provider binding changed.");
      const receipt = await provider.getPrompt({
        sandboxId: row.provider_sandbox_id,
        promptId: row.prompt_id,
        signal,
      });
      if (receipt.promptId !== row.prompt_id) throw Error("Native receipt identity mismatch.");
      if (receipt.done && isFinalPromptStatus(receipt.status)) status = receipt.status;
    } catch {
      // Neither transcript nor provider errors belong in the durable metadata.
      failed = true;
    }
    signal.throwIfAborted();
    // Settlement and enqueue are one transaction; owner/physical-target fences
    // prevent publishing observations made under superseded provider authority.
    await sql.query(
      `with settled as (
        update public.native_webhook_prompts p set
          completed_at=case when $4::text is not null then now() else null end,
          -- Reserve on claim so shutdown/crash/timeouts also consume a retry.
          -- A successful running observation refunds its reservation.
          failures=p.failures-case when $5 then 0 else 1 end,
          next_attempt_at=now()+(case when $5 then least(3600,30*power(2,p.failures-1)) else 30 end * interval '1 second'),
          lease_id=null,lease_until=null
        from public.sandboxes s where p.sandbox_id=$1::uuid and p.prompt_id=$2 and p.lease_id=$3::uuid
          and p.lease_until>clock_timestamp() and s.id=p.sandbox_id
          and s.provider=p.provider and s.provider_sandbox_id=p.provider_sandbox_id
          and s.owner_id=p.owner_id and s.org_id=p.org_id
          and not s.boat_runtime and s.runtime_transport is distinct from 'dialout'
          and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=s.owner_id)
        returning p.sandbox_id,p.prompt_id,p.org_id,p.failures
      ), abandoned as (
        -- The final failed observation abandons the receipt, so its turn never
        -- reaches settlement: count it as a durable Langfuse drop.
        insert into public.org_langfuse_export_stats as stats(org_id,dropped)
        select s.org_id,1 from settled s join public.org_langfuse c on c.org_id=s.org_id and c.enabled
        where $5 and s.failures>=5
        on conflict(org_id) do update set dropped=stats.dropped+1
      ) select public.enqueue_webhook_turn(sandbox_id,prompt_id,$4::text) from settled
        where $4::text is not null`,
      [row.sandbox_id, row.prompt_id, lease, status, failed],
    );
    return true;
  }
  return {
    stopAdmission() {
      stopped = true;
    },
    async reconcileOne(signal: AbortSignal): Promise<boolean> {
      signal.throwIfAborted();
      if (stopped || pending.size >= 4) return false;
      const work = observe(signal);
      pending.add(work);
      let abort = () => {};
      const cancelled = new Promise<boolean>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      void work.finally(() => pending.delete(work)).catch(() => {});
      try {
        return await Promise.race([work, cancelled]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    async drain() {
      await Promise.allSettled([...pending]);
    },
  };
}
