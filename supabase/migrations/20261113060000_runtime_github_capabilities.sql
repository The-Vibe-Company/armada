-- Github-only epoch capabilities. Access material uses existing sealed issued-history storage.
create sequence public.runtime_github_revision_seq;
create table public.runtime_github_capabilities (
 sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
 epoch bigint not null check(epoch>0),
 revision bigint not null default nextval('public.runtime_github_revision_seq'),
 hash text not null unique check(hash ~ '^[a-f0-9]{64}$'),
 binding jsonb not null,
 expires_at timestamptz not null,
 delivered_at timestamptz,
 acquisition_count bigint not null default 0 check(acquisition_count>=0),
 last_accessed_at timestamptz,
 primary key(sandbox_id,epoch)
);
alter table public.runtime_github_capabilities enable row level security;
revoke all on public.runtime_github_capabilities from public,anon,authenticated;
revoke all on sequence public.runtime_github_revision_seq from public,anon,authenticated;
grant all on public.runtime_github_capabilities to service_role;
grant usage,select on sequence public.runtime_github_revision_seq to service_role;
