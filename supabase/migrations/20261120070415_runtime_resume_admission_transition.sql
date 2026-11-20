-- Journal request-owned retained runtime resume admission without duplicating its dispatch.
begin;
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
  p_reconcile_lease uuid,
  p_activity_lease uuid
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
  docker_resume boolean;
  docker_stop boolean;
  docker_refusal boolean := (p_code = 'docker_resume_refusal_stop') is true;
  retained_resume boolean := (p_code = 'runtime_resume_admitted') is true;
  failed_resume_request boolean := p_activity_lease is not null and not retained_resume;
  interrupted_resume boolean := not failed_resume_request and (
    p_actor = 'runtime_resume' and p_code = 'runtime_resume_unenrolled' and p_to_state = 'stopping'
  ) is true;
  reconciler_stop boolean := (
    p_actor = 'reconciler'
    and p_code in ('stop_requested', 'expired', 'idle_paused', 'work_merged')
    and p_to_state = 'stopping'
  ) is true;
  docker_expiry boolean;
  docker_cleanup boolean;
  self_finish boolean := (p_actor = 'finish' and p_code = 'agent_finished' and p_to_state = 'stopping') is true;
  checkpointed_idle boolean :=
    (p_actor = 'idle'
      and p_code in ('runtime_checkpoint_idle_paused', 'runtime_checkpoint_work_merged')
      and p_to_state = 'stopping') is true;
begin
  select s.* into sandbox from public.sandboxes s where s.id = p_id for update;
  if not found or sandbox.lifecycle_generation is distinct from p_expected_generation
    or (sandbox.status = any(p_from_states)) is not true then
    return query select false, null::bigint;
    return;
  end if;

  if retained_resume then
    if p_actor is distinct from 'resume_admission' or p_to_state is distinct from 'starting'
      or p_activity_lease is null or jsonb_typeof(p_effects) is distinct from 'array'
      or jsonb_array_length(p_effects) <> 0 then
      raise exception 'invalid request-owned runtime resume admission' using errcode = '22023';
    end if;
    if ((sandbox.provider = 'boat' and sandbox.boat_runtime)
        or (sandbox.provider = 'modal' and sandbox.runtime_transport = 'dialout')) is not true
      or sandbox.status <> 'stopped' or sandbox.stopped_at is null
      or sandbox.expires_at <= now() or sandbox.application_secret_tainted
      or sandbox.stop_requested_at is not null or sandbox.deleted_at is not null
      or sandbox.activity_lease_id is not null or sandbox.activity_until >= now()
      or sandbox.reconcile_lease_until >= now()
      or not exists (select 1 from public.runtime_resumes r
        where r.sandbox_id = p_id and r.request_id = p_activity_lease and r.phase = 'dispatched')
      or exists (select 1 from public.account_turn_queue q
        where q.sandbox_id = p_id and q.request_id = p_activity_lease and q.state <> 'dispatching') then
      return query select false, null::bigint;
      return;
    end if;
  end if;

  docker_resume := p_code = 'docker_resume_admitted';
  if docker_resume then
    if sandbox.provider <> 'docker' or p_actor is distinct from 'resume_admission'
      or p_to_state <> 'starting' then
      raise exception 'invalid Docker resume transition' using errcode = '22023';
    end if;
    if sandbox.deleted_at is not null or sandbox.expires_at <= clock_timestamp() then
      return query select false, null::bigint;
      return;
    end if;
  end if;

  docker_stop := coalesce(p_code in ('docker_stop_admitted', 'docker_idle_paused', 'docker_work_merged'), false) or docker_refusal;
  docker_expiry := coalesce(p_code = 'docker_expiry_observed', false);
  docker_cleanup := coalesce(p_actor = 'docker_host' and p_code in ('retention_elapsed', 'disk_pressure'), false);
  if docker_stop or docker_expiry or docker_cleanup then
    if sandbox.provider <> 'docker' or p_reconcile_lease is not null
      or jsonb_typeof(p_effects) is distinct from 'array' or jsonb_array_length(p_effects) <> 0
      or (docker_stop and (p_to_state is distinct from 'stopping' or p_actor is distinct from
        case when docker_refusal then 'docker_host' when p_code = 'docker_stop_admitted' then 'owner' else 'idle' end))
      or (docker_expiry and (p_to_state is distinct from 'stopped' or p_actor is distinct from 'docker_host'))
      or (docker_cleanup and p_to_state is distinct from 'deleted') then
      raise exception 'invalid Docker mailbox transition' using errcode = '22023';
    end if;

    if docker_refusal and (sandbox.stop_requested_at is not null or sandbox.deleted_at is not null
      or sandbox.expires_at <= now()) then
      return query select false, null::bigint;
      return;
    end if;

    -- Replayed observations can fill missing timestamps without adding a state edge.
    if docker_expiry and sandbox.status in ('stopped', 'failed') then
      update public.sandboxes s set stopped_at = coalesce(s.stopped_at, now()),
        stop_requested_at = coalesce(s.stop_requested_at, now()),
        status_reason = case when s.status = 'failed' or s.status_reason in ('agent_finished', 'work_merged')
          then s.status_reason else 'expired' end
      where s.id = p_id;
      return query select true, sandbox.lifecycle_generation;
      return;
    end if;
    if docker_cleanup and sandbox.status = 'deleted' then
      update public.sandboxes s set stopped_at = coalesce(s.stopped_at, now()),
        deleted_at = coalesce(s.deleted_at, now()),
        status_reason = case when s.status_reason in ('retention_elapsed', 'disk_pressure')
          then s.status_reason else p_code end
      where s.id = p_id;
      return query select true, sandbox.lifecycle_generation;
      return;
    end if;
  end if;

  -- ready is the persisted availability state during the writer rollout.
  select edge.actors, edge.effects into allowed_actors, allowed_effects
  from (values
    ('stopped', 'starting', array['resume_admission'], array['resume']),
    ('starting', 'running', array['runtime_enrolment'], array['turn_dispatch']),
    ('starting', 'ready', array['runtime_enrolment'], array['turn_dispatch']),
    ('ready', 'running', array['docker_host'], array[]::text[]),
    ('running', 'ready', array['runtime_turn'], array[]::text[]),
    ('starting', 'stopping', array['owner', 'finish', 'expiry', 'idle'], array['stop']),
    ('running', 'stopping', array['owner', 'finish', 'expiry', 'idle'], array['stop']),
    ('ready', 'stopping', array['owner', 'finish', 'expiry', 'idle'], array['stop']),
    ('starting', 'failed', array['lifecycle_runner', 'docker_host', 'reconciler'], array[]::text[]),
    ('running', 'failed', array['lifecycle_runner', 'docker_host', 'reconciler'], array[]::text[]),
    ('ready', 'failed', array['lifecycle_runner', 'docker_host', 'reconciler'], array[]::text[]),
    ('stopping', 'failed', array['lifecycle_runner', 'reconciler'], array[]::text[]),
    ('ready', 'stopped', array['reconciler', 'runtime_observation'], array['output_publication', 'webhook']),
    ('running', 'stopped', array['reconciler', 'runtime_observation'], array['output_publication', 'webhook']),
    ('stopping', 'stopped', array['lifecycle_runner', 'reconciler'], array['output_publication', 'webhook']),
    ('stopped', 'deleted', array['delete_job', 'retention_job'], array['webhook', 'metadata_retirement']),
    ('failed', 'deleted', array['delete_job', 'retention_job'], array['webhook', 'metadata_retirement'])
  ) as edge(source, target, actors, effects)
  where edge.source = sandbox.status::text and edge.target = p_to_state::text;

  if (docker_refusal and sandbox.status in ('starting', 'failed'))
    or (docker_expiry and sandbox.status in ('starting', 'ready', 'running', 'stopping'))
    or (docker_cleanup and sandbox.status in ('starting', 'ready', 'running', 'stopping', 'stopped', 'failed')) then
    allowed_actors := array['docker_host'];
    allowed_effects := array[]::text[];
  end if;

  if interrupted_resume and sandbox.status = 'starting' and (
    (sandbox.provider = 'boat' and sandbox.boat_runtime)
    or (sandbox.provider = 'modal' and sandbox.runtime_transport = 'dialout')
  ) then
    allowed_actors := array['runtime_resume'];
    allowed_effects := array[]::text[];
  end if;

  if failed_resume_request then
    if p_actor is distinct from 'runtime_resume' or sandbox.status <> 'starting'
      or ((p_to_state = 'stopping' and p_code = 'runtime_resume_unenrolled')
        or (p_to_state = 'failed' and p_code = 'restore_unconfirmed')) is not true
      or jsonb_typeof(p_effects) is distinct from 'array' or jsonb_array_length(p_effects) <> 0 then
      raise exception 'invalid request-owned runtime resume failure' using errcode = '22023';
    end if;
    if ((sandbox.provider = 'boat' and sandbox.boat_runtime)
        or (sandbox.provider = 'modal' and sandbox.runtime_transport = 'dialout')) is not true
      or sandbox.activity_lease_id is distinct from p_activity_lease
      or (sandbox.activity_until > clock_timestamp()) is not true
      or sandbox.reconcile_lease_until > clock_timestamp()
      or sandbox.stop_requested_at is not null or sandbox.deleted_at is not null
      or (p_to_state = 'stopping' and sandbox.application_secret_tainted) then
      return query select false, null::bigint;
      return;
    end if;
    allowed_actors := array['runtime_resume'];
    allowed_effects := array[]::text[];
  end if;

  if reconciler_stop and sandbox.status in ('ready', 'running') then
    allowed_actors := array['reconciler'];
    allowed_effects := array[]::text[];
  end if;

  if (p_actor = any(allowed_actors)) is not true or (p_code ~ '^[a-z][a-z0-9_]{0,63}$') is not true
    or (p_actor = 'reconciler' or interrupted_resume) is distinct from (p_reconcile_lease is not null)
    or jsonb_typeof(p_effects) is distinct from 'array' then
    raise exception 'invalid sandbox transition' using errcode = '22023';
  end if;

  if (p_actor = 'reconciler' or interrupted_resume) and (
    sandbox.reconcile_lease is distinct from p_reconcile_lease
    or (sandbox.reconcile_lease_until > clock_timestamp()) is not true
  ) then
    return query select false, null::bigint;
    return;
  end if;

  if p_actor = 'runtime_observation' and p_stopped_at is null then
    raise exception 'runtime stop observation requires an exit timestamp' using errcode = '22023';
  end if;

  -- Docker resume enqueues its host mailbox job in the admission transaction.
  if docker_resume and jsonb_array_length(p_effects) <> 0 then
    raise exception 'Docker resume uses the host mailbox' using errcode = '22023';
  end if;
  if self_finish then
    if sandbox.stop_requested_at is not null or sandbox.status not in ('ready', 'running') then
      return query select false, null::bigint;
      return;
    end if;
    if jsonb_array_length(p_effects) <> 0 then
      raise exception 'self-finish already has a stop handoff' using errcode = '22023';
    end if;
  end if;
  if interrupted_resume then
    if sandbox.stop_requested_at is not null or sandbox.deleted_at is not null
      or sandbox.expires_at <= clock_timestamp()
      or (sandbox.activity_until <= clock_timestamp()) is not true then
      return query select false, null::bigint;
      return;
    end if;
    if jsonb_array_length(p_effects) <> 0 then
      raise exception 'interrupted resume already has a retained-stop handoff' using errcode = '22023';
    end if;
  end if;
  if checkpointed_idle then
    if jsonb_array_length(p_effects) <> 0 then
      raise exception 'checkpointed runtime idle stop already has a reconciler handoff' using errcode = '22023';
    end if;
    if ((sandbox.provider = 'boat' and sandbox.boat_runtime)
        or (sandbox.provider = 'modal' and sandbox.runtime_transport = 'dialout')) is not true
      or sandbox.status not in ('ready', 'running') or sandbox.stop_requested_at is not null
      or sandbox.deleted_at is not null or sandbox.expires_at <= clock_timestamp()
      or sandbox.application_secret_tainted or sandbox.activity_lease_id is not null
      or sandbox.reconcile_lease_until >= clock_timestamp()
      or not exists (select 1 from public.members m where m.org_id = sandbox.org_id and m.user_id = sandbox.owner_id) then
      return query select false, null::bigint;
      return;
    end if;
  end if;
  if reconciler_stop then
    if jsonb_array_length(p_effects) <> 0 or p_stop_requested_at is null then
      raise exception 'reconciler stop requires a stop intent and uses the existing reconciler' using errcode = '22023';
    end if;
    if sandbox.activity_until >= now() then
      return query select false, null::bigint;
      return;
    end if;
  end if;
  if p_to_state in ('starting', 'stopping') and not reconciler_stop and not interrupted_resume and not self_finish and not checkpointed_idle
    and not failed_resume_request and not retained_resume
    and not coalesce(docker_resume, false) and not docker_stop
    and jsonb_array_length(p_effects) <> 1 then
    raise exception 'sandbox transition requires one lifecycle job' using errcode = '22023';
  end if;

  -- Reconciliation records proven exit on failed rows before deletion.
  if sandbox.status = 'failed' and p_to_state = 'deleted' and sandbox.stopped_at is null and not docker_cleanup then
    raise exception 'failed sandbox exit is unconfirmed' using errcode = '22023';
  end if;

  if p_to_state = 'starting' or self_finish or docker_stop or docker_expiry or docker_cleanup or interrupted_resume
    or failed_resume_request then
    sandbox.lifecycle_generation := sandbox.lifecycle_generation + 1;
  end if;

  if retained_resume then
    update public.sandboxes s
    set status = p_to_state,
        lifecycle_generation = sandbox.lifecycle_generation,
        activity_lease_id = p_activity_lease,
        activity_until = now() + interval '2 minutes',
        reconcile_lease = null,
        reconcile_lease_until = null,
        stopped_at = null,
        stop_requested_at = null,
        status_reason = null,
        task_outcome = null,
        task_prompt_id = null,
        transition_context = jsonb_build_object('actor', p_actor, 'code', p_code)
    where s.id = p_id;
    return query select true, sandbox.lifecycle_generation;
    return;
  end if;

  update public.sandboxes s
  set status = p_to_state,
      lifecycle_generation = sandbox.lifecycle_generation,
      stop_generation = case when interrupted_resume or failed_resume_request or checkpointed_idle
        or (reconciler_stop and s.stop_requested_at is null) or (self_finish and s.provider <> 'docker')
        then s.stop_generation + 1 else s.stop_generation end,
      reconcile_after = case when interrupted_resume or (failed_resume_request and p_to_state = 'stopping') then 'infinity'::timestamptz
        when failed_resume_request then now()
        when self_finish or checkpointed_idle then now() else s.reconcile_after end,
      reconcile_lease = case when interrupted_resume then null else s.reconcile_lease end,
      reconcile_lease_until = case when interrupted_resume then null else s.reconcile_lease_until end,
      activity_lease_id = case when interrupted_resume or failed_resume_request then null else s.activity_lease_id end,
      activity_until = case when interrupted_resume or failed_resume_request then null else s.activity_until end,
      docker_retention_deadline = case when docker_resume then null else s.docker_retention_deadline end,
      status_reason = case
        when docker_expiry then case when s.status_reason in ('agent_finished', 'work_merged')
          then s.status_reason else 'expired' end
        when failed_resume_request then case when p_to_state = 'failed'
          then 'Runtime resume failed before a restored worker was confirmed; cleanup requested.' end
        when docker_refusal or interrupted_resume then null
        when p_code = 'docker_idle_paused' then 'idle_paused'
        when p_code = 'docker_work_merged' then 'work_merged'
        when checkpointed_idle then case when p_code = 'runtime_checkpoint_work_merged'
          then 'work_merged' else 'idle_paused' end
        when p_actor in ('reconciler', 'runtime_observation') then p_status_reason else case p_to_state
        when 'starting' then null
        when 'stopping' then case
          when p_code in ('expired', 'idle_paused', 'agent_finished', 'work_merged') then p_code
          else s.status_reason
        end
        when 'failed' then p_code
        when 'deleted' then case when p_code in ('retention_elapsed', 'disk_pressure') then p_code end
        else s.status_reason
      end end,
      stop_requested_at = case
        when failed_resume_request then now()
        when docker_stop or docker_expiry then coalesce(s.stop_requested_at, now())
        when p_actor = 'reconciler' then p_stop_requested_at else case p_to_state
        when 'starting' then null
        when 'stopping' then coalesce(s.stop_requested_at, clock_timestamp())
        else s.stop_requested_at
      end end,
      stopped_at = case
        when docker_expiry or docker_cleanup then coalesce(s.stopped_at, now())
        when p_actor in ('reconciler', 'runtime_observation') then p_stopped_at else case p_to_state
        when 'starting' then null
        when 'stopped' then coalesce(s.stopped_at, clock_timestamp())
        else s.stopped_at
      end end,
      deleted_at = case when docker_cleanup then coalesce(s.deleted_at, now()) when p_to_state = 'deleted' then clock_timestamp() else s.deleted_at end,
      transition_context = jsonb_build_object('actor', p_actor, 'code', p_code)
  where s.id = p_id and (not (interrupted_resume or reconciler_stop) or exists (
    select 1 from public.members m where m.org_id = s.org_id and m.user_id = s.owner_id
  ));
  if not found then
    return query select false, null::bigint;
    return;
  end if;

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

commit;
