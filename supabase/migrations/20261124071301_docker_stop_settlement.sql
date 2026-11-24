begin;

do $migration$
declare
  anchor constant text := '      stop_requested_at = case';
  parts text[] := string_to_array(pg_get_functiondef(
    'public.sandbox_transition(uuid,bigint,public.sandbox_status[],public.sandbox_status,text,text,jsonb,text,timestamp with time zone,timestamp with time zone,uuid,uuid)'::regprocedure
  ), anchor);
begin
  if cardinality(parts) is distinct from 2 then
    raise exception 'cannot locate stop intent settlement in sandbox_transition';
  end if;
  execute parts[1] || anchor || $settlement$
        when s.provider = 'docker' and s.status = 'stopping' and p_to_state = 'stopped'
          and p_actor = 'lifecycle_runner' and p_code = 'docker_stop_completed' then null$settlement$ || parts[2];
end;
$migration$;

-- A previously confirmed idle pause can already have a retained checkpoint.
-- Only repair rows whose latest transition proves settlement in this generation.
update public.sandboxes s
set stop_requested_at = null
where s.provider = 'docker' and s.status = 'stopped' and s.status_reason = 'idle_paused'
  and s.stop_requested_at is not null and s.stopped_at is not null
  and s.deleted_at is null and s.expires_at > clock_timestamp()
  and exists (
    select 1 from (
      select from_status, to_status, generation, actor, code
      from public.sandbox_transitions
      where sandbox_id = s.id
      order by id desc limit 1
    ) latest
    where latest.from_status = 'stopping' and latest.to_status = 'stopped'
      and latest.generation = s.lifecycle_generation
      and latest.actor = 'lifecycle_runner' and latest.code = 'docker_stop_completed'
  );

commit;
