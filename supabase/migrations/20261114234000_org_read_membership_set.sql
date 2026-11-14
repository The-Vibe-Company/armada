-- Organization navigation must scale with the caller's memberships, not the
-- total tenant count. Evaluate the indexed caller membership set once instead
-- of invoking is_org_member for every organization's candidate row.
-- members_select still enforces current membership; no grants or helper change.
alter policy orgs_select on public.orgs using (
  id in (
    select m.org_id from public.members m where m.user_id = (select auth.uid())
  )
);

-- The credential picker also lists all readable org credentials. Reuse the
-- same current membership set; user-scoped rows remain visible only to their
-- owner, and column grants continue to forbid reading ciphertext.
alter policy credentials_select on public.credentials using (
  (scope = 'user' and owner_id = (select auth.uid()))
  or (
    scope = 'org' and owner_id in (
      select m.org_id from public.members m where m.user_id = (select auth.uid())
    )
  )
);
