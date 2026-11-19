-- Terminal reconciler evidence must accompany the status write for timestamp,
-- authority, metering and webhook triggers. Keep the seven-argument entry point
-- for other callers and for the overlapping server release.
create or replace function public.sandbox_transition(
  p_id uuid,
  p_expected_generation bigint,
  p_from_states public.sandbox_status[],
  p_to_state public.sandbox_status,
  p_actor text,
  p_code text,
  p_effects jsonb,
  p_status_reason text,
  p_stop_requested_at timestamptz,
  p_stopped_at timestamptz,
  p_reconcile_lease uuid
)
returns table (applied boolean, generation bigint)
language plpgsql
set search_path = ''
as $$
declare
  sandbox public.sandboxes;
  allowed_actors text[];
  allowed_effects text[];
  effect record;
begin
  select s.* into sandbox from public.sandboxes s where s.id = p_id for update;
  if not found or sandbox.lifecycle_generation is distinct from p_expected_generation
    or (sandbox.status = any(p_from_states)) is not true then
    return query select false, null::bigint;
    return;
  end if;

  -- ready is the persisted availability state during the writer rollout.
  select edge.actors, edge.effects into allowed_actors, allowed_effects
  from (values
    ('stopped', 'starting', array['resume_admission'], array['resume']),
    ('starting', 'running', array['runtime_enrolment'], array['turn_dispatch']),
    ('starting', 'ready', array['runtime_enrolment'], array['turn_dispatch']),
    ('starting', 'stopping', array['owner', 'finish', 'expiry', 'idle'], array['stop']),
    ('running', 'stopping', array['owner', 'finish', 'expiry', 'idle'], array['stop']),
    ('ready', 'stopping', array['owner', 'finish', 'expiry', 'idle'], array['stop']),
    ('starting', 'failed', array['lifecycle_runner', 'docker_host', 'reconciler'], array[]::text[]),
    ('running', 'failed', array['lifecycle_runner', 'docker_host', 'reconciler'], array[]::text[]),
    ('ready', 'failed', array['lifecycle_runner', 'docker_host', 'reconciler'], array[]::text[]),
    ('stopping', 'failed', array['lifecycle_runner', 'reconciler'], array[]::text[]),
    ('ready', 'stopped', array['reconciler'], array['output_publication', 'webhook']),
    ('running', 'stopped', array['reconciler'], array['output_publication', 'webhook']),
    ('stopping', 'stopped', array['lifecycle_runner', 'reconciler'], array['output_publication', 'webhook']),
    ('stopped', 'deleted', array['delete_job', 'retention_job'], array['webhook', 'metadata_retirement']),
    ('failed', 'deleted', array['delete_job', 'retention_job'], array['webhook', 'metadata_retirement'])
  ) as edge(source, target, actors, effects)
  where edge.source = sandbox.status::text and edge.target = p_to_state::text;

  if (p_actor = any(allowed_actors)) is not true or (p_code ~ '^[a-z][a-z0-9_]{0,63}$') is not true
    or (p_actor = 'reconciler') is distinct from (p_reconcile_lease is not null)
    or jsonb_typeof(p_effects) is distinct from 'array' then
    raise exception 'invalid sandbox transition' using errcode = '22023';
  end if;

  if p_actor = 'reconciler' and (
    sandbox.reconcile_lease is distinct from p_reconcile_lease
    or (sandbox.reconcile_lease_until > clock_timestamp()) is not true
  ) then
    return query select false, null::bigint;
    return;
  end if;

  if p_to_state in ('starting', 'stopping') and jsonb_array_length(p_effects) <> 1 then
    raise exception 'sandbox transition requires one lifecycle job' using errcode = '22023';
  end if;

  -- Reconciliation records proven exit on failed rows before deletion.
  if sandbox.status = 'failed' and p_to_state = 'deleted' and sandbox.stopped_at is null then
    raise exception 'failed sandbox exit is unconfirmed' using errcode = '22023';
  end if;

  if p_to_state = 'starting' then
    sandbox.lifecycle_generation := sandbox.lifecycle_generation + 1;
  end if;

  update public.sandboxes s
  set status = p_to_state,
      lifecycle_generation = sandbox.lifecycle_generation,
      status_reason = case when p_actor = 'reconciler' then p_status_reason else case p_to_state
        when 'starting' then null
        when 'stopping' then case
          when p_code in ('expired', 'idle_paused', 'agent_finished', 'work_merged') then p_code
          else s.status_reason
        end
        when 'failed' then p_code
        when 'deleted' then case when p_code in ('retention_elapsed', 'disk_pressure') then p_code end
        else s.status_reason
      end end,
      stop_requested_at = case when p_actor = 'reconciler' then p_stop_requested_at else case p_to_state
        when 'starting' then null
        when 'stopping' then coalesce(s.stop_requested_at, clock_timestamp())
        else s.stop_requested_at
      end end,
      stopped_at = case when p_actor = 'reconciler' then p_stopped_at else case p_to_state
        when 'starting' then null
        when 'stopped' then coalesce(s.stopped_at, clock_timestamp())
        else s.stopped_at
      end end,
      deleted_at = case when p_to_state = 'deleted' then clock_timestamp() else s.deleted_at end,
      transition_context = jsonb_build_object('actor', p_actor, 'code', p_code)
  where s.id = p_id;

  for effect in select * from jsonb_to_recordset(p_effects) as item(
    kind text, idem_key text, max_attempts integer, deadline_at timestamptz, payload_enc bytea
  ) loop
    if (effect.kind = any(allowed_effects)) is not true
      or (effect.idem_key ~ '^[a-zA-Z0-9_.:-]{1,200}$') is not true
      or (effect.max_attempts > 0) is not true
      or (isfinite(effect.deadline_at)) is not true then
      raise exception 'invalid sandbox transition effect' using errcode = '22023';
    end if;

    insert into public.jobs (kind, sandbox_id, org_id, generation, idem_key, max_attempts, deadline_at, payload_enc)
    values (
      effect.kind, p_id, sandbox.org_id, sandbox.lifecycle_generation,
      -- Match the jobs store's internal key so a handoff shares a single intent.
      format('["internal",%s,%s,%s,%s,%s]', to_json(sandbox.org_id), to_json(effect.kind),
        to_json(p_id), sandbox.lifecycle_generation, to_json(effect.idem_key)),
      effect.max_attempts, effect.deadline_at, effect.payload_enc
    )
    on conflict (idem_key) do nothing;
  end loop;

  -- #2796 appends the event_log reference here, in this transaction.
  return query select true, sandbox.lifecycle_generation;
end
$$;

revoke all on function public.sandbox_transition(uuid, bigint, public.sandbox_status[], public.sandbox_status, text, text, jsonb, text, timestamptz, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.sandbox_transition(uuid, bigint, public.sandbox_status[], public.sandbox_status, text, text, jsonb, text, timestamptz, timestamptz, uuid)
  to service_role;

create or replace function public.sandbox_transition(
  p_id uuid,
  p_expected_generation bigint,
  p_from_states public.sandbox_status[],
  p_to_state public.sandbox_status,
  p_actor text,
  p_code text,
  p_effects jsonb
)
returns table (applied boolean, generation bigint)
language sql
set search_path = ''
as $$
  select * from public.sandbox_transition(p_id, p_expected_generation, p_from_states, p_to_state,
    p_actor, p_code, p_effects, null::text, null::timestamptz, null::timestamptz, null::uuid)
$$;
