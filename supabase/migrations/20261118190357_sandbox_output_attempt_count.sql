alter table public.sandboxes
  add column outputs_attempt_count integer not null default 0;
