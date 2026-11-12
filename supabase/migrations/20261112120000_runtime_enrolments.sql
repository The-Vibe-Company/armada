-- Private Boat runtime bootstrap authority. No user-JWT grants, including sealed configuration.
create table public.runtime_enrolments (
 sandbox_id uuid primary key references public.sandboxes(id) on delete cascade,
 lifecycle_generation bigint not null,
 epoch bigint not null default 0 check(epoch >= 0),
 enrolment_hash text unique check(enrolment_hash ~ '^[0-9a-f]{64}$'),
 enrolment_expires_at timestamptz,
 configuration_enc bytea,
 runtime_hash text unique check(runtime_hash ~ '^[0-9a-f]{64}$'),
 check ((enrolment_hash is null and enrolment_expires_at is null and configuration_enc is null)
     or (enrolment_hash is not null and enrolment_expires_at is not null and configuration_enc is not null)),
 check(runtime_hash is null or (epoch > 0 and enrolment_hash is null))
);
alter table public.runtime_enrolments enable row level security;
revoke all on public.runtime_enrolments from public,anon,authenticated;
grant all on public.runtime_enrolments to service_role;

create function public.revoke_runtime_enrolment_on_sandbox_change() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if new.lifecycle_generation is distinct from old.lifecycle_generation
    or new.status in ('stopping','stopped','deleted','failed') or new.stop_requested_at is not null or new.deleted_at is not null then
  update public.runtime_enrolments set enrolment_hash=null,enrolment_expires_at=null,
   configuration_enc=null,runtime_hash=null where sandbox_id=new.id;
 end if;
 return new;
end $$;
create trigger revoke_runtime_enrolment_on_sandbox_change after update of lifecycle_generation,status,stop_requested_at,deleted_at on public.sandboxes
 for each row execute function public.revoke_runtime_enrolment_on_sandbox_change();

create function public.revoke_runtime_enrolment_on_member_removal() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 update public.runtime_enrolments r set enrolment_hash=null,enrolment_expires_at=null,
  configuration_enc=null,runtime_hash=null from public.sandboxes s
  where r.sandbox_id=s.id and s.org_id=old.org_id and s.owner_id=old.user_id;
 return old;
end $$;
create trigger revoke_runtime_enrolment_on_member_removal after delete on public.members
 for each row execute function public.revoke_runtime_enrolment_on_member_removal();
revoke all on function public.revoke_runtime_enrolment_on_sandbox_change() from public,anon,authenticated;
revoke all on function public.revoke_runtime_enrolment_on_member_removal() from public,anon,authenticated;
