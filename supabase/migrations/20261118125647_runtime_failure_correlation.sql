-- Server-generated request IDs for asynchronous runtime failure reports.
-- Both mailbox tables already deny access to anon and authenticated roles.
alter table public.runtime_enrolments add column correlation_id uuid;
alter table public.runtime_commands add column correlation_id uuid;
-- The Docker launch queue can defer a prompt before it reaches the runtime mailbox.
alter table public.docker_queued_prompts add column correlation_id uuid;
