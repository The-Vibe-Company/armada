-- Include open recorded intervals as Armada-observed elapsed time, not provider-billed seconds.
-- Unknown histories remain null; lifecycle tracking still invalidates missing boundaries.
create or replace function public.sandbox_usage(s public.sandboxes) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'computeSeconds', case when s.usage_runtime_seconds is null then null
      else s.usage_runtime_seconds + case when s.usage_running_since is not null
        then greatest(0, extract(epoch from (statement_timestamp() - s.usage_running_since)))
        else 0 end end,
    'turnCount', s.usage_turns->'turnCount',
    'turns', coalesce(s.usage_turns->'turns', '[]'::jsonb))
$$;
revoke all on function public.sandbox_usage(public.sandboxes) from public, anon, authenticated;
grant execute on function public.sandbox_usage(public.sandboxes) to service_role;
