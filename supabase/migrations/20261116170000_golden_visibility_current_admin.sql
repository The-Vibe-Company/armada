-- Ownership survives demotion: changing an existing org golden requires current admin authority.
create or replace function public.set_golden_visibility(target_golden uuid, new_visibility public.visibility)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  golden public.goldens;
begin
  select * into golden from public.goldens where id = target_golden;
  if not found or golden.owner_id is distinct from auth.uid() or not public.is_org_member(golden.org_id) then
    raise exception 'golden not found' using errcode = 'P0002';
  end if;
  if golden.visibility = new_visibility then
    return;
  end if;
  if (golden.visibility = 'org' or new_visibility = 'org') and not public.is_org_admin(golden.org_id) then
    raise exception 'only an org admin shares a golden with the org or withdraws it' using errcode = '42501';
  end if;
  if new_visibility = 'private' and exists (
    select 1 from public.sandboxes where golden_id = golden.id and owner_id is distinct from golden.owner_id
  ) then
    raise exception 'other members still have sandboxes of this golden' using errcode = '23514';
  end if;
  perform set_config('armada.golden_visibility_change', golden.id::text, true);
  update public.goldens set visibility = new_visibility where id = golden.id;
  perform set_config('armada.golden_visibility_change', '', true);
end;
$$;

