-- Server-only incremental prompt projection; ciphertext inherits the evidence table's
-- service-role-only grants and RLS. Existing archives catch up once at next ingest.
alter table public.runtime_idle_evidence
  add column prompt_projection_sequence bigint not null default 0,
  add column latest_prompt_enc bytea;
