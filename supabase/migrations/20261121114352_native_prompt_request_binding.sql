begin;

-- Only a fenced native send acknowledgement can establish this identity.
-- The queue's historical sandbox-level prompt aliases cannot establish it.
alter table public.native_webhook_prompts add column acknowledged_request_id uuid;

create unique index native_webhook_prompts_acknowledged_request
  on public.native_webhook_prompts(sandbox_id, acknowledged_request_id)
  where acknowledged_request_id is not null;

commit;
