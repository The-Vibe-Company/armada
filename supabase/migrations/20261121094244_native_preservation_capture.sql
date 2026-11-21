begin;

alter table public.sandbox_native_preservation_receipts
  add column capture_generation bigint,
  add column capture_stop_generation bigint,
  add column archive_id uuid,
  add constraint native_preservation_capture_provenance check (
    (capture_generation is null and capture_stop_generation is null and archive_id is null)
    or (capture_generation is not null and capture_stop_generation is not null)
  );

-- Existing receipts have no explicit outcome. Old writers can still update
-- generation and stop_generation without attesting to the new outcome fields.
-- Keep the archive reference after purges so a missing archive never implies clean.

commit;
