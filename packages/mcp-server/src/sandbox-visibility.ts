export const SANDBOX_MEMBER = `not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)
  and s.org_id=any($1::uuid[]) and exists(select 1 from public.members m
  where m.org_id=s.org_id and m.user_id=$2::uuid)`;
export const SANDBOX_VISIBLE = `${SANDBOX_MEMBER} and exists(select 1 from public.members m
  where m.org_id=s.org_id and m.user_id=$2::uuid and (s.owner_id=$2::uuid or m.role='admin'))`;
