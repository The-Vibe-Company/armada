-- Temporary immutable opt-in until Modal common-transport parity and cutover.
alter table public.sandboxes add column runtime_transport text,
  add constraint sandboxes_runtime_transport_target check (
    runtime_transport is null or (runtime_transport='dialout' and provider='modal' and harness='codex' and not boat_runtime)
  );
create function public.guard_sandbox_runtime_transport() returns trigger
language plpgsql set search_path=public as $$
begin
  if new.runtime_transport is distinct from old.runtime_transport then
    raise exception 'Sandbox runtime transport is immutable';
  end if;
  return new;
end;
$$;
create trigger sandbox_runtime_transport_immutable before update of runtime_transport
  on public.sandboxes for each row execute function public.guard_sandbox_runtime_transport();
grant select(runtime_transport) on public.sandboxes to authenticated;
revoke all on function public.guard_sandbox_runtime_transport() from public,anon,authenticated;

-- A live runtime survives ONLY owned, same-epoch running-turn admission/completion.
-- Observation generations still advance; stop/resume/replacement continue to revoke.
create or replace function public.revoke_runtime_enrolment_on_sandbox_change() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if ((old.boat_runtime and new.boat_runtime) or
     (old.runtime_transport='dialout' and new.runtime_transport='dialout'))
    and new.lifecycle_generation=old.lifecycle_generation+1
    and old.stop_requested_at is null and new.stop_requested_at is null
    and old.deleted_at is null and new.deleted_at is null
    and (
      (old.status='starting' and new.status='running'
       and old.activity_lease_id is not null and old.activity_until>now()
       and new.activity_lease_id is null and new.activity_until is null
       and new.task_prompt_id is not null)
      or
      (old.status in ('ready','running') and new.status='running'
       and old.provider_sandbox_id is not distinct from new.provider_sandbox_id
       and old.credential_id is not distinct from new.credential_id
       and old.credential_version is not distinct from new.credential_version
       and old.expires_at is not distinct from new.expires_at
       and old.stopped_at is null and new.stopped_at is null
       and (
         (old.activity_lease_id is null and new.activity_lease_id is not null
          and new.activity_until>now() and new.task_prompt_id is null)
         or
         (old.activity_lease_id is not null and old.activity_until>now()
          and new.activity_lease_id is null and new.activity_until is null
          and new.task_prompt_id is not null)
       ))
    ) then
  update public.runtime_enrolments set lifecycle_generation=new.lifecycle_generation
   where sandbox_id=new.id and lifecycle_generation=old.lifecycle_generation and runtime_hash is not null;
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
