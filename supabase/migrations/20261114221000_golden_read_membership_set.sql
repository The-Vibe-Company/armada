-- Build the caller's membership set once, rather than invoke the definer
-- can_read_golden/is_org_member chain for every candidate golden. The members
-- SELECT policy still protects the subquery; no extra privileges are needed.
-- Private goldens remain owner-only, including for admins, and all reads still
-- require current membership. Keep tombstones readable for sandbox history.
alter policy goldens_select on public.goldens using (
  org_id in (
    select m.org_id from public.members m where m.user_id = (select auth.uid())
  )
  and (
    visibility = 'org'
    or (visibility = 'private' and owner_id = (select auth.uid()))
  )
);
