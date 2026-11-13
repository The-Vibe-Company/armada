-- Names are org-scoped display metadata, never machine authority.
alter table public.docker_hosts add column name text
  check (name is null or (length(name) between 1 and 64 and name = btrim(name)));
