-- Keep the aggregate under the same sandbox and stage visibility rules as the detail read.
create function public.sandbox_launch_percentiles(target_org uuid)
returns table (provider text, kind text, count bigint, "p50Ms" double precision, "p90Ms" double precision)
language sql stable security invoker set search_path = '' as $$
  with samples as (
    select s.provider::text as provider,
           case when accepted.activation = 1 then 'launch' else 'resume' end as kind,
           greatest(0, extract(epoch from (ready.at - accepted.at)) * 1000)::double precision as ms
      from public.sandboxes s
      join public.sandbox_launch_stages accepted on accepted.sandbox_id = s.id and accepted.stage = 'accepted'
      join public.sandbox_launch_stages ready on ready.sandbox_id = accepted.sandbox_id
        and ready.activation = accepted.activation and ready.stage = 'harness_ready'
     where s.org_id = target_org and accepted.at >= statement_timestamp() - interval '720 hours'
  )
  select provider, kind, count(*),
         percentile_disc(0.5) within group (order by ms),
         percentile_disc(0.9) within group (order by ms)
    from samples
   group by provider, kind
   order by provider, kind
$$;
revoke all on function public.sandbox_launch_percentiles(uuid) from public, anon, authenticated;
grant execute on function public.sandbox_launch_percentiles(uuid) to authenticated;
