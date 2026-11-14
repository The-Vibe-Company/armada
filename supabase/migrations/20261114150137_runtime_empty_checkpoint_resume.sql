-- Server-owned restore mode is durable across uncertain dispatch/reconciliation.
-- No plaintext prompt or user-JWT authority is introduced.
alter table public.runtime_resumes add column empty_checkpoint boolean not null default false,
  add constraint runtime_resumes_empty_conversation check (
    not empty_checkpoint or conversation_id = 'first_' || request_id::text
  );
