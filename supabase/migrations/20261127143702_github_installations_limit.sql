-- Raise the stored GitHub App installations JSONB size limit from 8,000 bytes (~50 orgs)
-- to 65,536 bytes so multi-org accounts with many GitHub App installations persist cleanly.
-- Additive relaxation: every row valid under 8,000 bytes remains valid under 65,536 bytes.

alter table public.github_connections
  drop constraint github_connections_installations_chk,
  add constraint github_connections_installations_chk check (
    installations is null
    or (jsonb_typeof(installations) = 'array' and octet_length(installations::text) <= 65536)
  );
