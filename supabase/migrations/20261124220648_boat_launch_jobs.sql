begin;

alter table public.sandboxes
  alter column provider_sandbox_id drop not null,
  drop constraint sandboxes_provider_sandbox_id_chk,
  add constraint sandboxes_provider_sandbox_id_chk check (
    (provider_sandbox_id is not null and char_length(provider_sandbox_id) between 1 and 200)
    or (provider_sandbox_id is null and (provider = 'modal' or (provider = 'boat' and boat_runtime)) and status in ('starting', 'failed', 'deleted'))
  );

-- Only the initial Boat bind uses a separate guard. All other writes retain their existing guards.
create function public.is_boat_launch_binding(prior public.sandboxes, next public.sandboxes)
returns boolean language sql immutable set search_path = '' as $$
  select prior.provider='boat' and next.provider='boat' and prior.boat_runtime and next.boat_runtime
    and prior.provider_sandbox_id is null and next.provider_sandbox_id is not null
$$;

drop trigger sandboxes_provider_guard on public.sandboxes;
create trigger sandboxes_provider_insert_guard before insert on public.sandboxes
for each row execute function public.sandboxes_provider_guard();
create trigger sandboxes_provider_guard before update on public.sandboxes
for each row when (not public.is_boat_launch_binding(old, new)) execute function public.sandboxes_provider_guard();

drop trigger sandboxes_guard on public.sandboxes;
create trigger sandboxes_guard_insert before insert on public.sandboxes
for each row execute function public.sandboxes_guard();
create trigger sandboxes_guard before update on public.sandboxes
for each row when (not public.is_boat_launch_binding(old, new)) execute function public.sandboxes_guard();

create function public.guard_boat_launch_binding() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_setting('role', true) in ('authenticated', 'anon')
    or new.status <> 'starting' or new.deleted_at is not null or new.stopped_at is not null
    or (tg_op = 'UPDATE' and (
      old.status <> 'starting' or new.lifecycle_generation is distinct from old.lifecycle_generation
      or new.boat_id is distinct from new.provider_sandbox_id
      or (new.id, new.golden_id, new.org_id, new.owner_id, new.harness, new.created_at)
        is distinct from (old.id, old.golden_id, old.org_id, old.owner_id, old.harness, old.created_at)
      or not exists (select 1 from public.goldens g where g.id=new.golden_id and g.org_id=new.org_id
        and (g.visibility='org' or g.owner_id=new.owner_id))
    ))
    or not exists (
      select 1 from public.jobs j
      where j.kind='launch' and j.sandbox_id=new.id and j.org_id=new.org_id
        and j.request_owner_id=new.owner_id and j.generation=new.lifecycle_generation
        and j.payload_enc is not null and (
          (tg_op='INSERT' and j.state='queued')
          or (tg_op='UPDATE' and j.state='leased' and j.lease_until>clock_timestamp()
            and j.outcome #>> '{modal_machine,entry,operation}'='create'
            and j.outcome #>> '{modal_machine,entry,phase}'='allocated'
            and j.outcome #>> '{modal_machine,entry,machineId}'=new.provider_sandbox_id)
        )
    ) then
    raise exception 'Boat launch identity requires a fenced launch job' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger boat_launch_unbound_guard after insert on public.sandboxes
for each row when (new.provider='boat' and new.boat_runtime and new.provider_sandbox_id is null)
execute function public.guard_boat_launch_binding();
create trigger boat_launch_bind_guard before update on public.sandboxes
for each row when (public.is_boat_launch_binding(old, new)) execute function public.guard_boat_launch_binding();

-- Apply after stopping predecessor ingress and draining its synchronous admissions.
lock table public.ordinary_launch_receipts, public.ordinary_launch_snapshot_intents in share mode nowait;

do $$
declare
  migrated bigint;
begin
  if exists (select 1 from public.ordinary_launch_snapshot_intents where provider = 'boat') then
    raise exception 'Boat launch backfill blocked by unresolved snapshot intents';
  end if;

  insert into public.jobs (
    kind, sandbox_id, generation, idem_key, org_id, request_owner_id, request_digest,
    state, deadline_at, max_attempts, outcome, created_at
  )
  select 'launch', r.id, 1,
    format('["request","%s","launch","%s",%s]', r.org_id, r.owner_id,
      to_json(format('["ordinary",%s]', to_json(r.request_key)))),
    r.org_id, r.owner_id, r.fingerprint,
    case when r.response #>> '{sandbox,id}' = r.id::text and r.failure is null then 'done' else 'failed' end,
    r.created_at, 1,
    case
      when r.failure is not null then jsonb_build_object('receipt','refused','failure',r.failure)
      when r.response #>> '{sandbox,id}' = r.id::text then '{"receipt":"accepted"}'::jsonb
      else '{"receipt":"unknown"}'::jsonb
    end, r.created_at
  from public.ordinary_launch_receipts r
  where r.authority #>> '{target,provider}' = 'boat'
  on conflict (idem_key) do update set state=excluded.state, outcome=excluded.outcome
  where jobs.kind=excluded.kind and jobs.sandbox_id=excluded.sandbox_id and jobs.org_id=excluded.org_id
    and jobs.request_owner_id=excluded.request_owner_id and jobs.request_digest=excluded.request_digest
    and jobs.generation=1 and jobs.payload_enc is null and (
      (jobs.state='failed' and jobs.outcome='{"receipt":"unknown"}'::jsonb)
      or (jobs.state=excluded.state and jobs.outcome=excluded.outcome)
    );
  get diagnostics migrated = row_count;
  if migrated <> (select count(*) from public.ordinary_launch_receipts where authority #>> '{target,provider}'='boat') then
    raise exception 'Boat launch backfill conflicts with an existing receipt';
  end if;
end;
$$;


commit;
