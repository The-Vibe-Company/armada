-- Preserve the enrolled epoch only when publishing an empty owned launch under its live lease.
-- Existing running-turn handoffs and all stop/replacement revocations remain unchanged.
create or replace function public.revoke_runtime_enrolment_on_sandbox_change() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if ((old.boat_runtime and new.boat_runtime) or
     (old.runtime_transport='dialout' and new.runtime_transport='dialout'))
    and new.lifecycle_generation=old.lifecycle_generation+1
    and old.stop_requested_at is null and new.stop_requested_at is null
    and old.deleted_at is null and new.deleted_at is null
    and (
      (old.status='starting' and new.status='ready'
       and old.activity_lease_id is not null and old.activity_until>now()
       and new.activity_lease_id is null and new.activity_until is null
       and old.task_prompt_id is null and new.task_prompt_id is null
       and cardinality(old.conversation_ids)=0 and cardinality(new.conversation_ids)=0
       and old.provider is not distinct from new.provider
       and old.provider_sandbox_id is not distinct from new.provider_sandbox_id
       and old.golden_id is not distinct from new.golden_id
       and old.owner_id is not distinct from new.owner_id and old.org_id is not distinct from new.org_id
       and old.harness is not distinct from new.harness
       and old.credential_id is not distinct from new.credential_id
       and old.credential_version is not distinct from new.credential_version
       and old.model is not distinct from new.model
       and old.reasoning_effort is not distinct from new.reasoning_effort
       and old.expires_at is not distinct from new.expires_at
       and old.stopped_at is null and new.stopped_at is null
       and not old.application_secret_tainted and not new.application_secret_tainted)
      or
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
