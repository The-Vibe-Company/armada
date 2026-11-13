-- Activity completion fences observations, not the runtime just admitted by launch.
-- Transfer only a live epoch on the initial starting -> running lease completion;
-- every stop, replacement, failed launch and later generation change still revokes.
create or replace function public.revoke_runtime_enrolment_on_sandbox_change() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if old.boat_runtime and new.boat_runtime
    and old.status='starting' and new.status='running'
    and old.activity_lease_id is not null and old.activity_until>now()
    and new.activity_lease_id is null and new.activity_until is null
    and new.lifecycle_generation=old.lifecycle_generation+1
    and new.task_prompt_id is not null
    and old.stop_requested_at is null and new.stop_requested_at is null
    and old.deleted_at is null and new.deleted_at is null then
  update public.runtime_enrolments set lifecycle_generation=new.lifecycle_generation
   where sandbox_id=new.id and lifecycle_generation=old.lifecycle_generation
     and runtime_hash is not null;
  if found then return new; end if;
 end if;
 if new.lifecycle_generation is distinct from old.lifecycle_generation
    or new.status in ('stopping','stopped','deleted','failed') or new.stop_requested_at is not null or new.deleted_at is not null then
  update public.runtime_enrolments set enrolment_hash=null,enrolment_expires_at=null,
   configuration_enc=null,runtime_hash=null where sandbox_id=new.id;
 end if;
 return new;
end $$;
revoke all on function public.revoke_runtime_enrolment_on_sandbox_change() from public,anon,authenticated;
