begin;

-- Run after draining the synchronous Modal producers, before enabling job admission.
-- A single snapshot supplies both the insert and the verification.
create function public.backfill_modal_launch_receipts()
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  verified_count bigint;
  source_count bigint;
begin
  with source as materialized (
    select r.id, r.org_id, r.owner_id, r.fingerprint, r.created_at,
      pg_catalog.format('["request","%s","launch","%s",%s]', r.org_id, r.owner_id,
        pg_catalog.to_json(pg_catalog.format('["ordinary",%s]', pg_catalog.to_json(r.request_key)))) as idem_key,
      case
        when r.authority #>> '{target,provider}' = 'modal'
          and r.failure is not null
          then pg_catalog.jsonb_build_object('receipt', 'refused', 'failure', r.failure)
        when r.authority #>> '{target,provider}' = 'modal'
          and r.response #>> '{sandbox,id}' = r.id::text
          then '{"receipt":"accepted"}'::jsonb
        else '{"receipt":"unknown"}'::jsonb
      end as outcome
    from public.ordinary_launch_receipts r
  ), inserted as (
    insert into public.jobs (
      kind, sandbox_id, generation, idem_key, org_id, request_owner_id, request_digest,
      state, deadline_at, max_attempts, outcome, created_at
    )
    select 'launch', id, 1, idem_key, org_id, owner_id, fingerprint,
      case when outcome->>'receipt' = 'accepted' then 'done' else 'failed' end,
      created_at, 1, outcome, created_at
    from source
    order by idem_key
    on conflict (idem_key) do nothing
    returning idem_key
  )
  select count(*), count(*) filter (where i.idem_key is not null or (
    j.kind = 'launch' and j.sandbox_id = s.id and j.generation = 1
    and j.org_id = s.org_id and j.request_owner_id = s.owner_id and j.request_digest = s.fingerprint
    and j.state = case when s.outcome->>'receipt' = 'accepted' then 'done' else 'failed' end
    and j.payload_enc is null and j.outcome = s.outcome
  ))
  into source_count, verified_count
  from source s
  left join inserted i using (idem_key)
  left join public.jobs j using (idem_key);

  if source_count <> verified_count then
    raise exception 'Modal launch receipt backfill conflicts with an existing job';
  end if;
  return verified_count;
end;
$$;

revoke execute on function public.backfill_modal_launch_receipts() from public, anon, authenticated;
grant execute on function public.backfill_modal_launch_receipts() to service_role;

commit;
