-- Owner-scoped model-account changes retain workspaces and their credential redaction material.
alter table public.sandboxes add column credential_note text,
  add column credential_delivery_pending boolean not null default false;
grant select(credential_note,credential_delivery_pending) on public.sandboxes to authenticated;

create table public.sandbox_model_credentials (
  sandbox_id uuid primary key references public.sandboxes(id) on delete cascade,
  operation_id uuid not null,
  credential_id uuid not null,
  credential_version integer not null check(credential_version>0),
  configuration_enc bytea not null,
  quota_history_mixed boolean not null default false,
  redaction_enc bytea not null
);
alter table public.sandbox_model_credentials enable row level security;
revoke all on public.sandbox_model_credentials from public,anon,authenticated;
grant all on public.sandbox_model_credentials to service_role;
