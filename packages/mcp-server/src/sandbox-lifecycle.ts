import type { Provider, Sql } from "@armada/core/server";

import { preserveBeforeStop } from "./work-preservation.ts";

/** One bounded batch in the existing server loop. SQL leases serialize replicas; generation
 * fencing prevents an old observation from publishing over a newly admitted resume. */
export function createSandboxLifecycle(sql: Sql, providerFor: (id: string) => Promise<Provider>) {
  const pending = new Set<Promise<unknown>>();
  // Cancellation bounds the scheduling lane without pretending an in-flight SDK stop
  // was undone. Raw operations remain tracked and their results cannot publish late.
  async function operation<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    const running = work();
    pending.add(running);
    const settled = running.finally(() => pending.delete(running));
    if (!signal) return settled;
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      settled.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  }
  return {
    async drain(): Promise<void> {
      await Promise.allSettled([...pending]);
    },
    async reconcileOne(signal?: AbortSignal): Promise<boolean> {
      signal?.throwIfAborted();
      const token = crypto.randomUUID();
      const row = (
        await sql.query<{
          id: string;
          provider_sandbox_id: string;
          lifecycle_generation: number;
          expires_at: Date | string;
          status: string;
          stop_requested_at: Date | string | null;
        }>(
          `update public.sandboxes s set reconcile_lease=$1::uuid,
          reconcile_lease_until=now()+interval '2 minutes'
        where s.id=(select candidate.id from public.sandboxes candidate
          join public.members m on m.org_id=candidate.org_id and m.user_id=candidate.owner_id
          where candidate.status not in ('stopped','deleted')
          and not exists(select 1 from public.orchestrators parent where parent.sandbox_id=candidate.id)
          and not (candidate.status='failed' and candidate.stopped_at is not null)
          and candidate.reconcile_after<=now()
          and (candidate.activity_until is null or candidate.activity_until<now())
          and (candidate.reconcile_lease_until is null or candidate.reconcile_lease_until<now())
          order by candidate.reconcile_after limit 1 for update of candidate skip locked)
        returning s.id,s.provider_sandbox_id,s.lifecycle_generation,s.expires_at,s.status::text as status,s.stop_requested_at`,
          [token],
        )
      ).rows[0];
      if (!row) return false;
      let terminal = false;
      let physicalExit = false;
      let error: string | null = null;
      try {
        // Uses persisted owner membership, source credential visibility and pinned Modal App.
        const provider = await operation(signal, () => providerFor(row.id));
        let info = await operation(signal, () => provider.get(row.provider_sandbox_id));
        physicalExit = info.physicalExitConfirmed === true;
        if (
          !physicalExit &&
          !["stopped", "deleted"].includes(info.state) &&
          (row.stop_requested_at !== null ||
            row.status === "stopping" ||
            new Date(row.expires_at).getTime() <= Date.now())
        ) {
          signal?.throwIfAborted();
          const owned = await sql.query<{ id: string }>(
            `update public.sandboxes
            set reconcile_lease_until=now()+interval '2 minutes'
            where id=$1::uuid and reconcile_lease=$2::uuid and lifecycle_generation=$3
              and reconcile_lease_until>now() and (activity_until is null or activity_until<now()) returning id`,
            [row.id, token, row.lifecycle_generation],
          );
          if (!owned.rows[0]) return true;
          signal?.throwIfAborted();
          await preserveBeforeStop(sql, provider, row.id, row.provider_sandbox_id).catch(() => {});
          signal?.throwIfAborted();
          await operation(signal, () => provider.stop({ sandboxId: row.provider_sandbox_id }));
          info = await operation(signal, () => provider.get(row.provider_sandbox_id));
        }
        signal?.throwIfAborted();
        physicalExit = info.physicalExitConfirmed === true;
        terminal = physicalExit || ["stopped", "deleted"].includes(info.state);
        if (!terminal && new Date(row.expires_at).getTime() <= Date.now())
          error = "Lifetime expired; provider stop is not yet confirmed. Retrying.";
      } catch {
        // No provider exception text: SDK errors may contain credential-bearing requests.
        error = "Provider lifecycle observation unavailable. Retrying without deleting retained data.";
      }
      await sql.query(
        `update public.sandboxes set
        -- A failed launch keeps its diagnostic even after its machine is confirmed stopped.
        status=case when $7 then 'failed'::public.sandbox_status when $4 and status <> 'failed' then 'stopped'::public.sandbox_status else status end,
        status_reason=case when $7 then coalesce(status_reason,'Provider confirmed physical exit without a new verified recovery checkpoint.') else status_reason end,
        stop_requested_at=case when $4 then null else stop_requested_at end,
        stopped_at=case when $4 then coalesce(stopped_at,now()) else stopped_at end,
        last_observed_at=case when $5::text is null then now() else last_observed_at end,
        lifecycle_error=$5::text,reconcile_after=now()+interval '1 minute',
        reconcile_lease=case when $6 then reconcile_lease else null end,
        reconcile_lease_until=case when $6 then reconcile_lease_until else null end
        where id=$1::uuid and reconcile_lease=$2::uuid and lifecycle_generation=$3
          and (activity_until is null or activity_until<now())`,
        [row.id, token, row.lifecycle_generation, terminal, error, signal?.aborted ?? false, physicalExit],
      );
      return true;
    },
  };
}
