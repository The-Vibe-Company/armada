-- Viewer-scoped detections preserve private-resource visibility without cross-viewer inference.
create table public.otto_orphan_days (
 org_id uuid not null references public.orgs(id), repository text not null,
 observer_id uuid not null references auth.users(id),
 day text not null check(day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'), kind text not null check(kind in ('pr','sandbox')),
 external_id text not null, reason text not null,
 first_seen_at timestamptz not null, last_seen_at timestamptz not null,
 resource jsonb not null,
 primary key(org_id,repository,observer_id,day,kind,external_id,reason)
);
alter table public.otto_orphan_days enable row level security;
revoke all on public.otto_orphan_days from public,anon,authenticated;
grant select,insert,update on public.otto_orphan_days to service_role;
