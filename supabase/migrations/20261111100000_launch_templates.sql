-- Immutable preset revisions and durable actor/org-scoped launch request tombstones.
create table public.launch_templates (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.orgs(id) on delete cascade,
 owner_id uuid not null references auth.users(id),
 scope text not null check(scope in ('personal','org')),
 name text not null check(length(name) between 1 and 200),
 current_revision integer not null default 1 check(current_revision>0),
 status text not null default 'active' check(status in ('active','deleted')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index launch_templates_name on public.launch_templates(org_id,scope,(case when scope='personal' then owner_id end),name) nulls not distinct where status='active';
create table public.launch_template_revisions (
 id uuid primary key default gen_random_uuid(),
 template_id uuid not null references public.launch_templates(id),
 revision integer not null check(revision>0),
 definition jsonb not null check(jsonb_typeof(definition)='object'),
 digest text not null check(digest ~ '^[a-f0-9]{64}$'),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 unique(template_id,revision)
);
create table public.template_launch_requests (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.orgs(id) on delete cascade,
 actor_id uuid not null references auth.users(id),
 client_key text not null check(length(client_key) between 1 and 128),
 digest text not null check(digest ~ '^[a-f0-9]{64}$'),
 template_id uuid not null references public.launch_templates(id),
 revision_id uuid not null references public.launch_template_revisions(id),
 manifest jsonb not null check(jsonb_typeof(manifest)='object'),
 -- Historical fence identity: no FK, because confirmed launches release the live fence.
 golden_operation_fence_id uuid not null,
 sandbox_id uuid not null,
 state text not null default 'claimed' check(state in ('claimed','allocating','succeeded','failed','reconciling')),
 result jsonb, reason text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(org_id,actor_id,client_key)
);
-- Prompt admission resolves a template hint within its existing authorized sandbox read.
create unique index template_launch_requests_sandbox on public.template_launch_requests(sandbox_id);
create function public.immutable_template_revision() returns trigger language plpgsql set search_path=public as $$
begin raise exception 'Template revisions are immutable'; end $$;
create trigger immutable_template_revision before update or delete on public.launch_template_revisions for each row execute function public.immutable_template_revision();
create function public.freeze_template_launch_manifest() returns trigger language plpgsql set search_path=public as $$
begin
 if (new.org_id,new.actor_id,new.client_key,new.digest,new.template_id,new.revision_id,new.manifest,new.sandbox_id,new.golden_operation_fence_id) is distinct from
 (old.org_id,old.actor_id,old.client_key,old.digest,old.template_id,old.revision_id,old.manifest,old.sandbox_id,old.golden_operation_fence_id) then raise exception 'Launch manifest is immutable'; end if;
 return new;
end $$;
create trigger freeze_template_launch_manifest before update on public.template_launch_requests for each row execute function public.freeze_template_launch_manifest();
alter table public.launch_templates enable row level security;
alter table public.launch_template_revisions enable row level security;
alter table public.template_launch_requests enable row level security;
create policy launch_templates_read on public.launch_templates for select to authenticated using (
 exists(select 1 from public.members m where m.org_id=launch_templates.org_id and m.user_id=auth.uid()) and (scope='org' or owner_id=auth.uid())
);
create policy launch_template_revisions_read on public.launch_template_revisions for select to authenticated using (
 exists(select 1 from public.launch_templates t where t.id=template_id)
);
-- Manifests/results include readable values and launch details; never expose another actor's interiors.
create policy template_launch_requests_read on public.template_launch_requests for select to authenticated using (
 actor_id=auth.uid() and exists(select 1 from public.members m where m.org_id=template_launch_requests.org_id and m.user_id=auth.uid())
);
revoke all on public.launch_templates,public.launch_template_revisions,public.template_launch_requests from public,anon,authenticated;
grant select on public.launch_templates,public.launch_template_revisions,public.template_launch_requests to authenticated;
grant all on public.launch_templates,public.launch_template_revisions,public.template_launch_requests to service_role;
revoke all on function public.immutable_template_revision(),public.freeze_template_launch_manifest() from public,anon,authenticated;
