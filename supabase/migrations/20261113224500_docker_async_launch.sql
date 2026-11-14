-- Durable normal-owner launch continuations. No new JWT access or credentials.
alter table public.docker_launch_requests
  add column async_launch boolean not null default false,
  add column worker_id uuid,
  add column worker_expires_at timestamptz;
