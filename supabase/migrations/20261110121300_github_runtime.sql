-- GitHub-only runtime capabilities. No refresh token, access token, or decryption surface.
create table public.github_runtime_capabilities (
  revision bigserial unique,
  hash text primary key check (hash ~ '^[a-f0-9]{64}$'),
  sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
  binding jsonb not null,
  expires_at timestamptz not null
);
create index on public.github_runtime_capabilities(sandbox_id);
alter table public.github_runtime_capabilities enable row level security;
revoke all on public.github_runtime_capabilities from anon, authenticated;
grant all on public.github_runtime_capabilities to service_role;

-- A durable pre-request consumption fence survives an uncertain HTTP/SQL commit outcome.
-- A reconnect installs different ciphertext and therefore a different fence identity.
create table public.github_refresh_fences (
  user_id uuid not null references auth.users(id) on delete cascade,
  refresh_hash text not null check (refresh_hash ~ '^[a-f0-9]{64}$'),
  primary key(user_id,refresh_hash)
);
alter table public.github_refresh_fences enable row level security;
revoke all on public.github_refresh_fences from anon, authenticated;
grant all on public.github_refresh_fences to service_role;
grant usage, select on sequence public.github_runtime_capabilities_revision_seq to service_role;

-- Reconnect/revoke is an authority epoch; ordinary access/refresh rotation is not.
alter table public.github_connections add column connection_epoch uuid not null default gen_random_uuid();
create function public.fence_github_connection_epoch() returns trigger
language plpgsql set search_path=public as $$
begin
 if new.github_id is distinct from old.github_id
    or new.revoked_at is distinct from old.revoked_at
    or (new.access_token_enc is null and new.refresh_token_enc is distinct from old.refresh_token_enc) then
  new.connection_epoch := gen_random_uuid();
 end if;
 return new;
end $$;
revoke all on function public.fence_github_connection_epoch() from public,anon,authenticated;
create trigger fence_github_connection_epoch before update on public.github_connections
for each row execute function public.fence_github_connection_epoch();

-- Restore only the sandbox's already-issued redaction leaves over private bootstrap.
-- A broker restart must not forget an access token still held by an older child process.
create table public.github_runtime_issued (
 sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
 owner_id uuid not null references auth.users(id) on delete cascade,
 physical_generation text not null,
 hash text not null check(hash ~ '^[a-f0-9]{64}$'),
 token_enc bytea not null,
 primary key(sandbox_id,owner_id,physical_generation,hash)
);
alter table public.github_runtime_issued enable row level security;
revoke all on public.github_runtime_issued from public,anon,authenticated;
grant all on public.github_runtime_issued to service_role;
