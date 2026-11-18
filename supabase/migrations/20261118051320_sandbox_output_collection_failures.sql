-- Server-only diagnostic claims. Unsupported collectors are excluded from future reads.
alter table public.sandboxes
  add column outputs_failure_reasons text[] not null default '{}',
  add column outputs_probe_at timestamptz,
  add column outputs_collector_supported boolean not null default false;
