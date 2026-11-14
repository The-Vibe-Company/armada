-- Planned conversation metadata is not a native admission receipt. Retain unknown legacy values as null.
alter table public.docker_queued_prompts add column conversation_id uuid;
update public.docker_queued_prompts q set conversation_id=coalesce(q.native_conversation_id,case when s.conversation_ids[1] ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then s.conversation_ids[1]::uuid else null end)
from public.sandboxes s where s.id=q.sandbox_id;
revoke all(conversation_id) on public.docker_queued_prompts from public,anon,authenticated;
