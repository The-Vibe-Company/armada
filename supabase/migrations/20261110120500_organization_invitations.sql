-- Additive: old member writers remain valid; no triggers, mail, or membership backfill.
create table public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  email text not null check (email = lower(trim(email))),
  role public.member_role not null,
  hash text not null unique check (hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','accepted','revoked')),
  delivery text not null check (delivery in ('not_configured','pending','sent','failed')),
  token_enc bytea,
  attempts integer not null default 0,
  lease_until timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index organization_invitations_pending_email on public.organization_invitations(org_id,email) where status='pending';
alter table public.organization_invitations enable row level security;
revoke all on public.organization_invitations from anon, authenticated;
grant all on public.organization_invitations to service_role;
