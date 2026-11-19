-- Preserve the transactional producers. One committed delivery creates one job,
-- regardless of which producer wrote it. A conflicting insert fires no trigger.
-- Fence legacy consumers before taking the backfill snapshot.
begin;
lock table public.outbound_webhook_deliveries in share row exclusive mode;

create function public.fence_outbound_webhook_legacy_claim() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- During deploy overlap, accept settlement only from a live pre-cutover claim.
  if new.lease_until is not null or old.lease_until is null
    or old.lease_until <= clock_timestamp() then
    return null;
  end if;
  return new;
end;
$$;
revoke all on function public.fence_outbound_webhook_legacy_claim() from public, anon, authenticated;

create trigger outbound_webhook_legacy_claim_fence
  before update of lease_until on public.outbound_webhook_deliveries
  for each row execute function public.fence_outbound_webhook_legacy_claim();

create function public.enqueue_outbound_webhook_job() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.jobs (id, kind, idem_key, org_id, run_after, max_attempts)
  select new.id, 'webhook', 'webhook:' || new.id, e.org_id, new.next_attempt_at, 2147483647
  from public.outbound_webhook_endpoints e where e.id = new.endpoint_id;
  return new;
end;
$$;
revoke all on function public.enqueue_outbound_webhook_job() from public, anon, authenticated;

create trigger outbound_webhook_job_on_delivery
  after insert on public.outbound_webhook_deliveries
  for each row execute function public.enqueue_outbound_webhook_job();

-- A shared job claim is not necessarily a send (for example while waiting for
-- a public prompt alias). The delivery receipt retains the five-send budget.
insert into public.jobs (id, kind, idem_key, org_id, run_after, max_attempts)
select d.id, 'webhook', 'webhook:' || d.id, e.org_id,
  greatest(d.next_attempt_at, d.lease_until), 2147483647
from public.outbound_webhook_deliveries d
join public.outbound_webhook_endpoints e on e.id = d.endpoint_id
where e.enabled and d.delivered_at is null and d.attempts < 5;

commit;
