-- Server-only diagnostic claims. Unsupported collectors are excluded from future reads.
alter table public.sandboxes
  add column outputs_failure_reasons text[] not null default '{}';
