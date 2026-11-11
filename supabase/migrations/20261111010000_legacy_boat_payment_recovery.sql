-- Eligibility is captured once. New ambiguous attempts must never qualify.
alter table public.golden_build_jobs
  add column legacy_payment_recovery_eligible boolean not null default false;
update public.golden_build_jobs
set legacy_payment_recovery_eligible = true
where provider = 'boat' and state = 'recovery_required' and phase = 'builder'
  and builder_id is null and snapshot is null and golden_id is null and failure_reason is null;

-- Operator-only confirmation of the ORIGINAL provider diagnostic, never an owner API.
create function public.reconcile_legacy_boat_payment_refusal(p_job_id uuid, p_confirmation text)
returns void language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  job public.golden_build_jobs;
begin
  if p_confirmation is distinct from 'provider_payment_required' then
    raise exception 'Confirm the original definitive provider payment refusal before recovery';
  end if;
  select * into job from public.golden_build_jobs where id = p_job_id for update;
  if not found or not job.legacy_payment_recovery_eligible or job.provider <> 'boat'
    or job.phase <> 'builder' or job.builder_id is not null
    or job.snapshot is not null or job.golden_id is not null then
    raise exception 'Job is not an eligible pre-migration Boat allocation refusal';
  end if;
  if job.state = 'failed' and job.failure_reason = 'provider_payment_required' then
    return;
  end if;
  if job.state <> 'recovery_required' or job.failure_reason is not null then
    raise exception 'Job no longer matches the legacy recovery state';
  end if;
  if job.reservation_id is not null then
    perform public.release_golden_backend_slot(job.reservation_id);
  end if;
  update public.golden_build_jobs
  set state = 'failed', error_code = 'build_failed', failure_reason = 'provider_payment_required',
      lease_until = null, updated_at = now()
  where id = p_job_id;
end;
$$;
revoke all on function public.reconcile_legacy_boat_payment_refusal(uuid, text) from public, anon, authenticated;
grant execute on function public.reconcile_legacy_boat_payment_refusal(uuid, text) to service_role;
