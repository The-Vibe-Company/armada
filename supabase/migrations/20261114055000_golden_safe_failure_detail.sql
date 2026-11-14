-- Only trusted build diagnostics use detail:; arbitrary provider/command output must never be persisted here.
alter table public.golden_build_jobs drop constraint golden_build_jobs_failure_reason_check;
alter table public.golden_build_jobs add constraint golden_build_jobs_failure_reason_check
  check (failure_reason is null
    or failure_reason in ('skillpack_integrity_failed', 'provider_payment_required', 'provider_snapshot_rejected')
    or (failure_reason like 'detail:%' and length(failure_reason) between 8 and 1024));

-- Preserve the closed SSH subphase as the actual failed step, not checkout_baseline.
alter table public.golden_build_jobs drop constraint golden_build_jobs_phase_check;
alter table public.golden_build_jobs add constraint golden_build_jobs_phase_check
  check (phase in ('queued', 'authorization', 'builder', 'checkout_credentials',
    'checkout_baseline', 'secret_scan', 'snapshot', 'persist', 'complete',
    'ssh', 'checkout', 'bun', 'chromium', 'harness', 'skillpack', 'init',
    'ownership', 'credential_cleanup', 'inline_scan'));
