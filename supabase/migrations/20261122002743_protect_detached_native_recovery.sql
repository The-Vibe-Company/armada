begin;

-- Taint still purges both archives through the installed sandbox trigger.
alter function public.enforce_application_secret_taint() security definer;
revoke execute on function public.enforce_application_secret_taint() from service_role;

-- A direct service delete could remove recovery while provider deletion is in flight.
revoke delete on table public.native_drain_recovery from service_role;

commit;
