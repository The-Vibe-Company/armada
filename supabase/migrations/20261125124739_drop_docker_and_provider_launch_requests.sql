begin;

-- v14.2.2 has no runtime writers for docker_launch_requests or provider_launch_requests.
-- Preserve any historical non-async Docker launch manifests in public.jobs before
-- removing the legacy view branch and dropping both tables.
lock table public.docker_launch_requests in share mode;

insert into public.jobs (
  kind, sandbox_id, org_id, generation, idem_key, request_owner_id, request_digest,
  state, deadline_at, max_attempts, payload_enc, outcome, created_at
)
select
  'launch',
  s.id,
  s.org_id,
  s.lifecycle_generation,
  format('["request","%s","launch","%s",%s]', s.org_id, s.owner_id, to_json(format('["docker","%s"]', s.id))),
  s.owner_id,
  d.request_hash,
  case when d.result_enc is null then 'failed' else 'done' end,
  s.expires_at,
  1,
  d.request_enc,
  jsonb_build_object(
    'docker_actor_epoch', d.actor_epoch::text,
    'docker_receipt', encode(d.result_enc, 'hex'),
    'docker_async_launch', false
  ),
  d.created_at
from public.docker_launch_requests d
join public.sandboxes s on s.id = d.sandbox_id
where not d.async_launch
  and s.provider = 'docker'
  and not exists (
    select 1
    from public.jobs j
    where j.kind = 'launch'
      and j.sandbox_id = s.id
      and j.outcome ? 'docker_actor_epoch'
  )
on conflict (idem_key) do nothing;

create or replace view public.docker_launch_manifests with (security_invoker=true) as
select
  sandbox_id,
  (outcome->>'docker_actor_epoch')::bigint as actor_epoch,
  request_digest as request_hash,
  payload_enc as request_enc,
  decode(outcome->>'docker_receipt', 'hex') as result_enc,
  coalesce((outcome->>'docker_async_launch')::boolean, true) as async_launch,
  lease_until as worker_expires_at
from public.jobs
where kind = 'launch' and outcome ? 'docker_actor_epoch';

revoke all on public.docker_launch_manifests from public, anon, authenticated;
grant select on public.docker_launch_manifests to service_role;

drop table public.docker_launch_requests;
drop table public.provider_launch_requests;

commit;
