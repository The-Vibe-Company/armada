-- Morph uses named-account authorization, never singleton JWT writes.
-- OpenCode is a named model account, not a directly writable provider singleton.
drop index public.credentials_provider_singleton;
create unique index credentials_provider_singleton on public.credentials(scope,owner_id,kind)
where kind not in ('claude_oauth','anthropic','openai','codex_auth','opencode','morph');
alter table public.credentials drop constraint credentials_nonmodel_default_chk;
alter table public.credentials add constraint credentials_nonmodel_default_chk
check (not is_default or kind in ('claude_oauth','anthropic','openai','codex_auth','opencode','morph'));
drop index public.credentials_harness_default;
create unique index credentials_harness_default on public.credentials(scope,owner_id,
  (case when kind in ('claude_oauth','anthropic') then 'claude' when kind='opencode' then 'opencode' when kind='morph' then 'morph' else 'codex' end))
where is_default and kind in ('claude_oauth','anthropic','openai','codex_auth','opencode','morph');
alter policy credentials_model_delete_fence on public.credentials
using (kind not in ('claude_oauth','anthropic','openai','codex_auth','opencode','morph'));
alter policy credentials_model_insert_fence on public.credentials
with check (kind not in ('claude_oauth','anthropic','openai','codex_auth','opencode','morph'));
alter policy credentials_model_update_fence on public.credentials
using (kind not in ('claude_oauth','anthropic','openai','codex_auth','opencode','morph'))
with check (kind not in ('claude_oauth','anthropic','openai','codex_auth','opencode','morph'));
