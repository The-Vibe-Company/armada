const SANDBOX_ORG_MEMBER = `s.org_id=any($1::uuid[]) and exists(select 1 from public.members m
  where m.org_id=s.org_id and m.user_id=$2::uuid)`;
const OWNER_OR_ADMIN = `exists(select 1 from public.members m
  where m.org_id=s.org_id and m.user_id=$2::uuid and (s.owner_id=$2::uuid or m.role='admin'))`;
const LEGACY_PARENT = `exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)`;
export const SANDBOX_MEMBER = `not ${LEGACY_PARENT} and ${SANDBOX_ORG_MEMBER}`;
export const SANDBOX_VISIBLE = `${SANDBOX_MEMBER} and ${OWNER_OR_ADMIN}`;

export const SANDBOX_DELETION_MANAGED = `(exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)
  or exists(select 1 from public.orchestrator_children c where c.sandbox_id=s.id
    and not exists(select 1 from public.armada_access_parents p
      join public.sandboxes parent on parent.id=p.sandbox_id
      where p.id=c.orchestrator_id and p.org_id=c.org_id and p.owner_id=c.owner_id
        and p.kind='sandbox' and parent.status='deleted')))`;
