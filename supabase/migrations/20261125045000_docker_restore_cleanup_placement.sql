begin;

do $migration$
declare
  original text := pg_get_functiondef('public.sandboxes_provider_guard()'::regprocedure);
  revised text;
begin
  revised := replace(
    original,
    'if old.status <> ''starting'' or new.status <> ''starting''',
    'if old.status not in (''starting'', ''stopping'', ''stopped'', ''failed'') or new.status is distinct from old.status'
  );
  revised := replace(
    revised,
    'target.machine_generation = old.lifecycle_generation',
    '(target.machine_generation = old.lifecycle_generation
      or (old.status in (''stopping'', ''stopped'', ''failed'')
        and target.machine_generation = old.lifecycle_generation - 1))
     and (old.status = ''starting'' or receipt.result_machine_id is not null)'
  );
  if revised = original
    or position('target.machine_generation = old.lifecycle_generation - 1' in revised) = 0
    or position('new.status is distinct from old.status' in revised) = 0
  then
    raise exception 'Docker restore placement guard changed before cleanup cutover';
  end if;
  execute revised;
end
$migration$;

commit;
