-- New sandboxes have complete Armada lifecycle records; legacy histories remain unknown.
alter table public.sandboxes
  add column usage_runtime_seconds double precision,
  add column usage_running_since timestamptz,
  add column usage_turns jsonb;

create function public.track_sandbox_runtime() returns trigger
language plpgsql set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    new.usage_runtime_seconds := 0;
    if new.stopped_at is null and new.deleted_at is null then
      new.usage_running_since := clock_timestamp();
    end if;
  elsif old.usage_runtime_seconds is not null then
    if old.usage_running_since is not null and
       (new.stopped_at is not null or new.deleted_at is not null) then
      new.usage_runtime_seconds := old.usage_runtime_seconds + greatest(0,
        extract(epoch from (least(coalesce(new.stopped_at, new.deleted_at), clock_timestamp()) - old.usage_running_since)));
      new.usage_running_since := null;
    elsif old.usage_running_since is null and new.stopped_at is null and new.deleted_at is null
      and old.stopped_at is not null then
      new.usage_running_since := clock_timestamp();
    end if;
  end if;
  return new;
end $$;
revoke all on function public.track_sandbox_runtime() from public, anon, authenticated;
create trigger sandbox_runtime before insert or update of stopped_at, deleted_at
on public.sandboxes for each row execute function public.track_sandbox_runtime();

-- SQL helper is privileged: the calling query must enforce its existing visibility rule.
create function public.sandbox_usage(s public.sandboxes) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'computeSeconds', case when s.usage_runtime_seconds is null then null
      -- An open interval has no confirmed end: return only completed intervals.
      when s.usage_running_since is not null then null else s.usage_runtime_seconds end,
    'turnCount', s.usage_turns->'turnCount',
    'turns', coalesce(s.usage_turns->'turns', '[]'::jsonb))
$$;
revoke all on function public.sandbox_usage(public.sandboxes) from public, anon, authenticated;
grant execute on function public.sandbox_usage(public.sandboxes) to service_role;
