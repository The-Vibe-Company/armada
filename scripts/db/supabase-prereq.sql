-- What a fresh Supabase database already provides before the first migration.
-- Tests and `bun run db:types` apply this, then supabase/migrations. Production
-- does not: Supabase Auth owns the auth schema and these roles.

create role anon nologin nobypassrls;
create role authenticated nologin nobypassrls;
create role service_role nologin bypassrls;

-- Supabase's default privileges for objects postgres creates in public: everything, to every
-- API role. A migration that wants less must revoke it.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema auth;

create table auth.users (
  id uuid primary key,
  email text
);

create function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
