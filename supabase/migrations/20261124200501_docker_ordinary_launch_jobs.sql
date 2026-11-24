begin;

-- Install after ordinary admissions and workers on the previous release have drained.
-- Leave template and routine receipts in their active store.
lock table public.docker_launch_requests in share mode;

do $$
begin
  if exists (
    select 1 from public.docker_launch_requests d join public.sandboxes s on s.id=d.sandbox_id
    where d.async_launch and d.result_enc is null and s.status in ('starting','ready','running')
  ) then raise exception 'drain unresolved ordinary Docker launches before receipt backfill'; end if;
end;
$$;

insert into public.jobs (kind,sandbox_id,org_id,generation,idem_key,request_owner_id,request_digest,
  state,deadline_at,max_attempts,payload_enc,outcome)
select 'launch',s.id,s.org_id,s.lifecycle_generation,
  format('["request","%s","launch","%s",%s]',s.org_id,s.owner_id,to_json(format('["docker","%s"]',s.id))),
  s.owner_id,d.request_hash,
  case when d.result_enc is null then 'failed' else 'done' end,
  s.expires_at,1,d.request_enc,
  jsonb_build_object('docker_actor_epoch',d.actor_epoch::text,'docker_receipt',encode(d.result_enc,'hex'))
from public.docker_launch_requests d join public.sandboxes s on s.id=d.sandbox_id
where d.async_launch and s.provider='docker';

-- Setup, follow-up and inspection all use the admitted launch manifest. Template
-- admission still owns its synchronous receipt until its own caller cutover.
create view public.docker_launch_manifests with (security_invoker=true) as
select sandbox_id, actor_epoch, request_hash, request_enc, result_enc, async_launch, worker_expires_at
from public.docker_launch_requests where not async_launch
union all
select sandbox_id,(outcome->>'docker_actor_epoch')::bigint,request_digest,payload_enc,
  decode(outcome->>'docker_receipt','hex'),true,lease_until
from public.jobs where kind='launch' and outcome ? 'docker_actor_epoch';
revoke all on public.docker_launch_manifests from public,anon,authenticated;
grant select on public.docker_launch_manifests to service_role;

do $$
declare
  definition text := pg_get_functiondef(
    'public.project_sandbox_status(uuid,uuid,bigint,public.sandbox_status)'::regprocedure);
begin
  if position('public.docker_launch_requests' in definition) = 0 then
    raise exception 'cannot find Docker launch readiness source';
  end if;
  execute replace(definition, 'public.docker_launch_requests', 'public.docker_launch_manifests');
end;
$$;

commit;
