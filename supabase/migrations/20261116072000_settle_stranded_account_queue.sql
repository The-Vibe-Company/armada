-- Forward-only repair. Do not replay a request with durable dispatch evidence.
-- A failed receipt is deliberately not a claim that the underlying turn failed.
update public.account_turn_queue q set state='failed',
  failure_reason='Queued receipt already has dispatch evidence; inspect sandbox history before resending.'
from public.sandboxes s where s.id=q.sandbox_id and q.state='queued'
  and (s.task_prompt_id=q.request_id::text or s.activity_lease_id=q.request_id
    or exists(select 1 from public.runtime_commands c where c.sandbox_id=s.id
      and c.request_id in ('follow_'||q.request_id::text,'docker_prompt_'||q.request_id::text,'resume_'||q.request_id::text))
    or exists(select 1 from public.runtime_resumes r where r.sandbox_id=s.id and r.request_id=q.request_id)
    or exists(select 1 from public.docker_host_jobs j where j.bound_sandbox_id=s.id and j.request_id=q.request_id));

-- Preserve live and idle-paused work for the dispatcher. A stop after acceptance
-- invalidates paused work; deletion, expiry and an in-progress stop cannot run.
update public.account_turn_queue q set state='failed',
  failure_reason='Queued prompt cannot start: sandbox stopped, deleted, expired, or stopping.'
from public.sandboxes s where s.id=q.sandbox_id and q.state='queued'
  and (s.deleted_at is not null or s.expires_at<=now() or s.stop_requested_at is not null
    or s.status not in ('ready','running','stopped')
    or (s.status='stopped' and s.lifecycle_generation<>q.queued_generation));
