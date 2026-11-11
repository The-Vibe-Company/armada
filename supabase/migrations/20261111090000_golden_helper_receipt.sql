-- Snapshot-bound inert tool metadata. Only the privileged build publisher writes it.
-- Above main and all open PR migration filenames checked for issue #926.
alter table public.goldens add column helper_receipt jsonb
  check (helper_receipt is null or (
    jsonb_typeof(helper_receipt) = 'object' and
    helper_receipt ?& array['version','digest','protocol','platform','capabilities','snapshotId']
  ));
grant select (helper_receipt) on public.goldens to authenticated;
-- Existing INSERT grants are column-scoped; do not grant user writes to this receipt.
