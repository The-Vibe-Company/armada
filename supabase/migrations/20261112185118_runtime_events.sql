-- One persistent producer journal per logical sandbox, including stop/resume epochs.
-- Raw events may contain private account data: never give user JWTs the archive.
create table public.runtime_events (
 sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
 sequence bigint not null check(sequence between 1 and 9007199254740991),
 epoch bigint not null check(epoch > 0),
 -- Sparse non-secret marker: first reference to each logical turn, including usage-only reports.
 counted_prompt_id text check(counted_prompt_id is null or char_length(counted_prompt_id) between 1 and 256),
 event_enc bytea not null,
 primary key(sandbox_id,sequence)
);
create unique index runtime_events_prompts on public.runtime_events(sandbox_id,counted_prompt_id) where counted_prompt_id is not null;
alter table public.runtime_events enable row level security;
revoke all on public.runtime_events from public,anon,authenticated;
grant all on public.runtime_events to service_role;
