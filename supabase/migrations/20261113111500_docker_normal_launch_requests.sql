-- Service-owned launch reconciliation; user task text is sealed, never a host job.
create table public.docker_launch_requests (
 sandbox_id uuid primary key references public.sandboxes(id) on delete cascade,
 actor_epoch bigint not null check(actor_epoch > 0),
 request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
 request_enc bytea not null check(octet_length(request_enc) > 28),
 result_enc bytea check(result_enc is null or octet_length(result_enc) > 28),
 created_at timestamptz not null default now()
);
alter table public.docker_launch_requests enable row level security;
revoke all on public.docker_launch_requests from public,anon,authenticated;
grant all on public.docker_launch_requests to service_role;
