begin;

create or replace function public.revoke_runtime_enrolment_on_sandbox_change() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.lifecycle_generation is distinct from old.lifecycle_generation
     or new.status in ('stopping','stopped','deleted','failed')
     or new.stop_requested_at is not null or new.deleted_at is not null then
    update public.runtime_enrolments
      set enrolment_hash=null,enrolment_expires_at=null,configuration_enc=null,runtime_hash=null
      where sandbox_id=new.id;
  end if;
  return new;
end $$;

revoke all on function public.revoke_runtime_enrolment_on_sandbox_change() from public,anon,authenticated;

commit;
