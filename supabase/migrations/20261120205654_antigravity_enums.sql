begin;

-- Direct JWT writes are reserved for existing provider and registry singletons.
-- Listing model-account exclusions would grant write access to each new kind
-- until a later migration updated the fences.
alter policy credentials_model_delete_fence on public.credentials
using (kind in ('boat', 'modal', 'skillpack'));
alter policy credentials_model_insert_fence on public.credentials
with check (kind in ('boat', 'modal', 'skillpack'));
alter policy credentials_model_update_fence on public.credentials
using (kind in ('boat', 'modal', 'skillpack'))
with check (kind in ('boat', 'modal', 'skillpack'));

-- Commit the enum labels before a later migration uses them in constraints.
alter type public.harness add value 'antigravity';
alter type public.credential_kind add value 'antigravity';

commit;
