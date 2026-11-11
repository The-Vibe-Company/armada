-- Public, verified catalog receipts only; no Skillpack credentials.
alter table public.sandboxes add column skills jsonb not null default '[]'::jsonb
  check (jsonb_typeof(skills) = 'array');
grant select (skills) on public.sandboxes to authenticated;
