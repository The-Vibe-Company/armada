-- What a fresh Supabase database already provides before the first migration.
-- Tests and `bun run db:types` apply this, then supabase/migrations. Production
-- does not: Supabase Auth owns the auth schema and these roles.

create role authenticated nologin nobypassrls;
create role service_role nologin bypassrls;

create schema auth;

create table auth.users (
  id uuid primary key
);

create function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

grant usage on schema auth to authenticated, service_role;
grant execute on function auth.uid() to authenticated, service_role;
