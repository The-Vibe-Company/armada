-- Successful prompt replies can be joined to visible text without decrypting either payload.
-- Completed rows from older writers retain null metadata.
alter table public.runtime_commands add column accepted_prompt_id uuid;
