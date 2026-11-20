-- Add the native launch settlement to the existing status writer.
begin;
do $migration$
declare
  anchor constant text := '  if p_code = ''native_provider_phase'' then';
  parts text[] := string_to_array(pg_get_functiondef(
    'public.sandbox_transition(uuid,bigint,public.sandbox_status[],public.sandbox_status,text,text,jsonb,text,timestamp with time zone,timestamp with time zone,uuid,uuid)'::regprocedure
  ), anchor);
begin
  if cardinality(parts) is distinct from 2 then
    raise exception 'cannot locate the native phase branch in sandbox_transition';
  end if;
  execute parts[1] || $edge$  if p_code = 'native_launch_ready' then
    if p_actor is distinct from 'lifecycle_runner' or p_to_state is distinct from 'ready'
      or p_activity_lease is null or p_effects is distinct from '[]'::jsonb
      or p_reconcile_lease is not null or p_stop_requested_at is not null or p_stopped_at is not null then
      raise exception 'invalid native launch readiness' using errcode = '22023';
    end if;
    if sandbox.provider not in ('boat', 'modal') or sandbox.boat_runtime or sandbox.runtime_transport is not null
      or sandbox.status <> 'starting' or sandbox.activity_lease_id is distinct from p_activity_lease
      or sandbox.stop_requested_at is not null or sandbox.stopped_at is not null or sandbox.deleted_at is not null
      or sandbox.task_prompt_id is not null or cardinality(sandbox.conversation_ids) <> 0 then
      return query select false, null::bigint;
      return;
    end if;
    -- An expired activity deadline permits observation. A matching launch token
    -- may still settle until the observer records durable stop or exit evidence.
    update public.sandboxes set status = 'ready', lifecycle_generation = sandbox.lifecycle_generation + 1,
      activity_lease_id = null, activity_until = null, reconcile_lease = null, reconcile_lease_until = null,
      transition_context = jsonb_build_object('actor', p_actor, 'code', p_code) where id = p_id;
    return query select true, sandbox.lifecycle_generation + 1;
    return;
  end if;
$edge$ || anchor || parts[2];
end;
$migration$;
commit;
