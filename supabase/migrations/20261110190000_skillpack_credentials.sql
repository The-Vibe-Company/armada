-- Registry tokens share the encrypted vault, but never model defaults or named accounts.
alter type public.credential_kind add value if not exists 'skillpack';
-- Use the existing model-kind allowlist so this migration need not use the new enum literal
-- before its transaction commits. All non-model credentials are singletons.
drop index public.credentials_provider_singleton;
create unique index credentials_provider_singleton on public.credentials(scope,owner_id,kind)
where kind not in ('claude_oauth','anthropic','openai','codex_auth');
alter table public.credentials add constraint credentials_nonmodel_default_chk
check (not is_default or kind in ('claude_oauth','anthropic','openai','codex_auth'));
-- Keep existing ownership/admin RLS, and extend the non-model write fences to registry tokens.
alter policy credentials_model_delete_fence on public.credentials
using (kind not in ('claude_oauth','anthropic','openai','codex_auth'));
alter policy credentials_model_insert_fence on public.credentials
with check (kind not in ('claude_oauth','anthropic','openai','codex_auth'));
alter policy credentials_model_update_fence on public.credentials
using (kind not in ('claude_oauth','anthropic','openai','codex_auth'))
with check (kind not in ('claude_oauth','anthropic','openai','codex_auth'));
