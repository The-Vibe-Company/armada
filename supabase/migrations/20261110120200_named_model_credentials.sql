-- Model accounts share the canonical encrypted credential store. Provider identity is unchanged.
alter table public.credentials
  add column name text not null default 'Default' check (length(btrim(name)) between 1 and 120),
  add column is_default boolean not null default false,
  add column status text not null default 'active' check (status in ('active','revoked','deleted')),
  add column expires_at timestamptz,
  add column updated_at timestamptz not null default now(),
  add column version integer not null default 1 check (version > 0);
-- Preserve the historical per-harness kind preference, not insertion order.
update public.credentials c set is_default = true
where kind in ('claude_oauth','anthropic','openai','codex_auth') and not exists (
  select 1 from public.credentials preferred where preferred.scope=c.scope and preferred.owner_id=c.owner_id
  and ((c.kind='anthropic' and preferred.kind='claude_oauth') or (c.kind='codex_auth' and preferred.kind='openai'))
);
alter table public.credentials drop constraint credentials_owner_kind_key;
create unique index credentials_provider_singleton on public.credentials(scope,owner_id,kind) where kind in ('boat','modal');
create unique index credentials_harness_default on public.credentials(scope,owner_id,
  (case when kind in ('claude_oauth','anthropic') then 'claude' else 'codex' end))
where is_default and kind in ('claude_oauth','anthropic','openai','codex_auth');
create function public.credential_revision() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.version := old.version + case when new.value_enc is distinct from old.value_enc then 1 else 0 end;
  return new;
end $$;
revoke all on function public.credential_revision() from public, anon, authenticated;
create trigger credential_revision before update on public.credentials for each row execute function public.credential_revision();
grant select(name,is_default,status,expires_at,updated_at,version) on public.credentials to authenticated;
-- Historical binding deliberately has no FK: removal must never erase billing identity.
alter table public.sandboxes add column credential_id uuid, add column credential_version integer;
grant select(credential_id,credential_version) on public.sandboxes to authenticated;
-- Direct user-JWT deletion must not remove the tombstone and silently change billing.
-- Model removal is the authenticated ID control route. Provider singleton deletion is unchanged.
create policy credentials_model_delete_fence on public.credentials as restrictive
for delete to authenticated using (kind in ('boat','modal'));
-- Modal bootstraps before the Armada sandbox row exists. Keep the same immutable
-- binding in its private harness policy for subsequent physical generations.
alter table public.modal_server_harnesses add column credential_id uuid, add column credential_version integer;
alter table public.modal_server_harnesses add constraint modal_harness_credential_binding_chk
  check ((credential_id is null and credential_version is null) or (credential_id is not null and credential_version is not null and credential_version > 0));
-- Model writes are exclusively the authorized service-role account API. Existing
-- authenticated grants remain necessary for canonical Boat/Modal singleton writes.
create policy credentials_model_insert_fence on public.credentials as restrictive
for insert to authenticated with check (kind in ('boat','modal'));
create policy credentials_model_update_fence on public.credentials as restrictive
for update to authenticated using (kind in ('boat','modal')) with check (kind in ('boat','modal'));
