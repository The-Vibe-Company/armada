alter table public.golden_build_jobs drop constraint golden_build_jobs_failure_reason_check;
alter table public.golden_build_jobs add constraint golden_build_jobs_failure_reason_check
  check (failure_reason is null or failure_reason in ('skillpack_integrity_failed', 'provider_payment_required'));
