begin;

-- Other synchronous providers participate in the same ordinary key namespace
-- before Modal switches producers. The backfill verifies the same terminal row.
create function public.reserve_ordinary_launch_job_key()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.jobs (
    kind, sandbox_id, generation, idem_key, org_id, request_owner_id, request_digest,
    state, deadline_at, max_attempts, outcome, created_at
  )
  values (
    'launch', new.id, 1,
    pg_catalog.format('["request","%s","launch","%s",%s]', new.org_id, new.owner_id,
      pg_catalog.to_json(pg_catalog.format('["ordinary",%s]', pg_catalog.to_json(new.request_key)))),
    new.org_id, new.owner_id, new.fingerprint,
    'failed', new.created_at, 1, '{"receipt":"unknown"}'::jsonb, new.created_at
  )
  on conflict (idem_key) do nothing;

  if not found then
    raise exception using errcode = 'A2760', message = 'Ordinary launch key is already reserved';
  end if;
  return new;
end;
$$;

revoke execute on function public.reserve_ordinary_launch_job_key() from public, anon, authenticated;
grant execute on function public.reserve_ordinary_launch_job_key() to service_role;

create trigger ordinary_launch_shared_key
after insert on public.ordinary_launch_receipts
for each row
when (new.authority #>> '{target,provider}' in ('boat', 'docker'))
execute function public.reserve_ordinary_launch_job_key();

commit;
