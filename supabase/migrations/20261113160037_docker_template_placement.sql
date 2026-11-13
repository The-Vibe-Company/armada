-- Docker template admissions have no golden operation to fence. Golden-backed
-- admissions continue to acquire their real snapshot fence in the claim transaction.
alter table public.template_launch_requests
  alter column golden_operation_fence_id drop not null;
