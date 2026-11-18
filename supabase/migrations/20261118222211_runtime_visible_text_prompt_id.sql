-- New archive writes can identify visible text without exposing the encrypted payload.
-- Existing rows and writers during the rollout leave this metadata null.
alter table public.runtime_events add column visible_text_prompt_id uuid;
