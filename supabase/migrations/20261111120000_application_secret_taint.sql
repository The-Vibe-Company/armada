-- Gates only: no application-secret delivery is enabled by this migration.
-- Service-owned, irreversible lifetime marker; never infer taint from current grants.
alter table public.sandboxes add column application_secret_tainted boolean not null default false;
comment on column public.sandboxes.application_secret_tainted is
  'Permanent application-secret exposure marker, committed before hydration. Forbids preservation and disk reuse.';

create function public.enforce_application_secret_taint() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.application_secret_tainted and not new.application_secret_tainted then
    raise exception 'Application-secret taint is irreversible';
  end if;
  if new.application_secret_tainted then
    delete from public.sandbox_work_recovery where sandbox_id=new.id;
    new.preservation_note := 'Unpushed work was not preserved: application-secret exposure forbids archives and disk reuse; resume and recovery are unavailable.';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_application_secret_taint() from public, anon, authenticated;
create trigger enforce_application_secret_taint before update of application_secret_tainted
  on public.sandboxes for each row execute function public.enforce_application_secret_taint();

-- Also close late archive writes, including a collector that started before taint.
create function public.reject_tainted_work_recovery() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform 1 from public.sandboxes where id=new.sandbox_id
    and not application_secret_tainted for share;
  if not found then raise exception 'Work recovery unavailable'; end if;
  return new;
end;
$$;
revoke all on function public.reject_tainted_work_recovery() from public, anon, authenticated;
create trigger reject_tainted_work_recovery before insert or update on public.sandbox_work_recovery
  for each row execute function public.reject_tainted_work_recovery();
-- No JWT write grant: existing sandbox SELECT access includes this non-secret flag.
