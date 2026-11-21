alter table public.sandboxes
  add column native_preservation_generation bigint,
  add column native_preservation_stop_generation bigint;

comment on column public.sandboxes.native_preservation_generation is
  'Lifecycle generation of a successful, lease-fenced native work preservation receipt.';
comment on column public.sandboxes.native_preservation_stop_generation is
  'Stop epoch of that same receipt, independent of receipt updates by older writers.';
