const SANDBOX_ORG_MEMBER = `s.org_id=any($1::uuid[]) and exists(select 1 from public.members m
  where m.org_id=s.org_id and m.user_id=$2::uuid)`;
const OWNER_OR_ADMIN = `exists(select 1 from public.members m
  where m.org_id=s.org_id and m.user_id=$2::uuid and (s.owner_id=$2::uuid or m.role='admin'))`;
const LEGACY_PARENT = `exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)`;
export const SANDBOX_MEMBER = `not ${LEGACY_PARENT} and ${SANDBOX_ORG_MEMBER}`;
export const SANDBOX_VISIBLE = `${SANDBOX_MEMBER} and ${OWNER_OR_ADMIN}`;
