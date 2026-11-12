-- Otto is an isolated read-only observer. All writes use the server connection.
create table public.otto_facts (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.orgs(id),
 repository text not null,
 subject text not null,
 kind text not null,
 value text not null check(value in ('true','false','unknown')),
 observed_at timestamptz not null default now(),
 source text not null,
 source_id text not null,
 completeness text not null check(completeness in ('complete','partial','unknown')),
 evidence jsonb not null,
 unique(org_id,repository,source,source_id,subject,kind)
);
create index otto_facts_read on public.otto_facts(org_id,repository,observed_at desc,id desc);
alter table public.otto_facts enable row level security;
revoke all on public.otto_facts from public,anon,authenticated;
grant select,insert on public.otto_facts to service_role;
create function public.otto_facts_immutable() returns trigger language plpgsql set search_path=public as $$
begin raise exception 'Otto facts are append-only'; end $$;
create trigger otto_facts_immutable before update or delete on public.otto_facts
 for each row execute function public.otto_facts_immutable();
create trigger otto_facts_no_truncate before truncate on public.otto_facts
 for each statement execute function public.otto_facts_immutable();
revoke all on function public.otto_facts_immutable() from public,anon,authenticated;
-- ETags cache only successfully fetched, validated pages. No credentials/raw payloads.
create table public.otto_github_pages (
 org_id uuid not null references public.orgs(id), repository text not null,
 path text not null, etag text, items jsonb not null, next_path text,
 primary key(org_id,repository,path)
);
alter table public.otto_github_pages enable row level security;
revoke all on public.otto_github_pages from public,anon,authenticated;
grant select,insert,update on public.otto_github_pages to service_role;
