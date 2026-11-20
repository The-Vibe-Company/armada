begin;

do $migration$
declare
  anchor constant text := '  if p_code = ''native_launch_ready'' then';
  parts text[] := string_to_array(pg_get_functiondef(
    'public.sandbox_transition(uuid,bigint,public.sandbox_status[],public.sandbox_status,text,text,jsonb,text,timestamp with time zone,timestamp with time zone,uuid,uuid)'::regprocedure
  ), anchor);
begin
  if cardinality(parts) is distinct from 2 then
    raise exception 'cannot locate the native launch readiness branch in sandbox_transition';
  end if;
  execute parts[1] || $edge$  if p_code = 'unleased_native_launch' then
    if (p_to_state in ('ready', 'running', 'failed')) is not true
      or p_actor is distinct from (case when p_to_state = 'running' then 'native_turn' else 'lifecycle_runner' end)
      or p_activity_lease is not null or p_reconcile_lease is not null or p_effects is distinct from '[]'::jsonb
      or p_stop_requested_at is not null or p_stopped_at is not null
      or (p_to_state <> 'failed' and p_status_reason is not null) then
      raise exception 'invalid unleased native launch transition' using errcode = '22023';
    end if;
    if sandbox.status <> 'starting' or sandbox.provider not in ('boat', 'modal')
      or sandbox.boat_runtime or sandbox.runtime_transport is not null
      or sandbox.activity_lease_id is not null or sandbox.activity_until is not null
      or sandbox.reconcile_lease_until >= clock_timestamp()
      or sandbox.stop_requested_at is not null or sandbox.stopped_at is not null or sandbox.deleted_at is not null
      or sandbox.task_prompt_id is not null or cardinality(sandbox.conversation_ids) <> 0 then
      return query select false, null::bigint;
      return;
    end if;
    update public.sandboxes set status = p_to_state, status_reason = p_status_reason,
      transition_context = jsonb_build_object('actor', p_actor, 'code', p_code) where id = p_id;
    return query select true, sandbox.lifecycle_generation;
    return;
  end if;
$edge$ || anchor || parts[2];
end;
$migration$;

create function public.settle_unleased_native_launch(
  p_id uuid, p_generation bigint, p_status public.sandbox_status, p_reason text,
  p_prompt_id text, p_conversations text[]
)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  if (p_status = 'running' and (nullif(p_prompt_id, '') is null or cardinality(p_conversations) is distinct from 1
       or nullif(p_conversations[1], '') is null))
    or (p_status <> 'running' and (p_prompt_id is not null or p_conversations is not null)) then
    raise exception 'invalid unleased native launch receipt' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.sandbox_transition(
      p_id, p_generation, array['starting']::public.sandbox_status[], p_status,
      case when p_status = 'running' then 'native_turn' else 'lifecycle_runner' end,
      'unleased_native_launch', '[]'::jsonb, p_reason, null, null, null, null
    ) where applied
  ) then
    return false;
  end if;
  if p_status = 'running' then
    update public.sandboxes set task_prompt_id = p_prompt_id, conversation_ids = p_conversations where id = p_id;
  end if;
  return true;
end;
$$;

revoke all on function public.settle_unleased_native_launch(uuid,bigint,public.sandbox_status,text,text,text[])
  from public, anon, authenticated;
grant execute on function public.settle_unleased_native_launch(uuid,bigint,public.sandbox_status,text,text,text[])
  to service_role;

commit;
