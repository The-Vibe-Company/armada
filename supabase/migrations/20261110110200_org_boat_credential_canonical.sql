-- An organization's Boat key has one home: orgs.boat_api_key_enc. Launches, golden builds, provider
-- status and the CLI already read and write only that column, but the dashboard's Credentials page
-- used to store an org-scoped 'boat' row in credentials, which nothing resolved (#586).
--
-- Reconcile those rows without decrypting anything. Both slots hold the same AES-256-GCM sealing
-- (iv || ciphertext || tag) under ARMADA_ENCRYPTION_KEY with no associated data, so the ciphertext
-- moves as is:
--   * the column already holds a key: it is the active one and stays; the row is dropped;
--   * the column is empty: the row's ciphertext becomes the column's value.
-- Then no org-scoped 'boat' row may exist again, whatever the role writing it.

update public.orgs as o
set boat_api_key_enc = c.value_enc
from public.credentials as c
where c.scope = 'org'
  and c.kind = 'boat'
  and c.owner_id = o.id
  and o.boat_api_key_enc is null;

delete from public.credentials where scope = 'org' and kind = 'boat';

alter table public.credentials
  add constraint credentials_org_boat_chk check (not (scope = 'org' and kind = 'boat'));

comment on constraint credentials_org_boat_chk on public.credentials is
  'The org boat.dev key is orgs.boat_api_key_enc, never a credentials row.';
