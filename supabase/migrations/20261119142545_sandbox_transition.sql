-- Existing writers keep their predicates and the opt-in trigger during rollout.
-- Admission inserts the initial row and job together, outside this update API.
create function public.sandbox_transition(
  p_id uuid,
  p_expected_generation bigint,
  p_from_states public.sandbox_status[],
  p_to_state public.sandbox_status,
  p_actor text,
  p_code text,
  p_effects jsonb
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
    ('starting', 'failed', array['lifecycle_runner'], array[]::text[]),
    ('running', 'failed', array['lifecycle_runner'], array[]::text[]),
    ('ready', 'failed', array['lifecycle_runner'], array[]::text[]),
    ('stopping', 'failed', array['lifecycle_runner'], array[]::text[]),
    ('stopping', 'stopped', array['lifecycle_runner'], array['output_publication', 'webhook']),
    ('stopped', 'deleted', array['delete_job', 'retention_job'], array['webhook', 'metadata_retirement']),
    ('failed', 'deleted', array['delete_job', 'retention_job'], array['webhook', 'metadata_retirement'])
  ) as edge(source, target, actors, effects)
  where edge.source = sandbox.status::text and edge.target = p_to_state::text;

  if (p_actor = any(allowed_actors)) is not true or (p_code ~ '^[a-z][a-z0-9_]{0,63}$') is not true
    or jsonb_typeof(p_effects) is distinct from 'array' then
    raise exception 'invalid sandbox transition' using errcode = '22023';
  end if;

  if p_to_state = 'starting' then
    if jsonb_array_length(p_effects) <> 1 then
      raise exception 'resume requires one job' using errcode = '22023';
    end if;
    sandbox.lifecycle_generation := sandbox.lifecycle_generation + 1;
  end if;

  update public.sandboxes s
  set status = p_to_state,
      lifecycle_generation = sandbox.lifecycle_generation,
      status_reason = case p_to_state
        when 'starting' then null
        when 'failed' then p_code
        when 'deleted' then case when p_code in ('retention_elapsed', 'disk_pressure') then p_code end
        else s.status_reason
      end,
      stop_requested_at = case p_to_state
        when 'starting' then null
        when 'stopping' then coalesce(s.stop_requested_at, clock_timestamp())
        else s.stop_requested_at
      end,
      stopped_at = case p_to_state
        when 'starting' then null
        when 'stopped' then coalesce(s.stopped_at, clock_timestamp())
        else s.stopped_at
      end,
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

revoke all on function public.sandbox_transition(uuid, bigint, public.sandbox_status[], public.sandbox_status, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.sandbox_transition(uuid, bigint, public.sandbox_status[], public.sandbox_status, text, text, jsonb)
  to service_role;
