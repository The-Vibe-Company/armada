-- #2568: an opaque caller reference (for example one business object of an
-- embedding product) recorded at launch, returned by status/list and used as a
-- list filter. Not unique: exactly-once launch is the idempotency key's job.
alter table public.sandboxes add column external_ref text;
alter table public.sandboxes add constraint sandboxes_external_ref_chk
  check (external_ref is null or (char_length(external_ref) between 1 and 200 and external_ref !~ '[[:cntrl:]]'));
create index sandboxes_org_external_ref_idx on public.sandboxes (org_id, external_ref)
  where external_ref is not null;
