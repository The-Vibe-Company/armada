-- Typed blockers are private to the owner of the objective. Choices never accept free-text answers.
create table public.otto_waits (
 id uuid primary key default gen_random_uuid(),
 objective_id uuid not null,
 org_id uuid not null,
 owner_id uuid not null,
 dedupe_key text not null check(length(dedupe_key) between 1 and 200),
 kind text not null check(kind in ('ci','verification','slot','human','access')),
 reason text not null check(reason in ('approval','irreversible','access','two_failed_attempts','budget','reversible','observation')),
 phase text not null check(phase in ('interview','work')),
 question text not null check(length(btrim(question)) between 1 and 2000),
 choices jsonb not null default '[]' check(jsonb_typeof(choices)='array' and jsonb_array_length(choices)<=10),
 default_choice text,
 connection_url text check(connection_url = '/settings'),
 status text not null default 'open' check(status in ('open','answered','defaulted','parked')),
 resolution text,
 created_at timestamptz not null default now(),
 deadline_at timestamptz not null default (now()+interval '24 hours'),
 reminded_at timestamptz,
 foreign key(objective_id,org_id,owner_id) references public.otto_objectives(id,org_id,owner_id) on delete cascade,
 unique(objective_id,dedupe_key),
 check(kind<>'access' or (connection_url is not null and connection_url='/settings')),
 check(kind<>'human' or jsonb_array_length(choices)>0),
 check(default_choice is null or (reason='reversible' and kind='human')),
 check(status<>'defaulted' or (reason='reversible' and default_choice is not null and resolution=default_choice))
);
create index on public.otto_waits(org_id,owner_id,created_at,id);
-- Serialize admission on the objective, not on a process-local count.
create function public.otto_wait_question_cap() returns trigger language plpgsql set search_path=public as $$
begin
 perform 1 from public.otto_objectives where id=new.objective_id for update;
 if new.phase='work' and new.kind in ('human','access') and new.status in ('open','parked') and
  not exists(select 1 from public.otto_waits where objective_id=new.objective_id and dedupe_key=new.dedupe_key) and
  (select count(*) from public.otto_waits where objective_id=new.objective_id and phase='work' and kind in ('human','access') and status in ('open','parked') and id<>new.id)>=3 then
  raise exception 'objective_question_limit';
 end if;
 return new;
end $$;
revoke all on function public.otto_wait_question_cap() from public,anon,authenticated;
create trigger otto_wait_cap before insert or update on public.otto_waits for each row execute function public.otto_wait_question_cap();
alter table public.otto_waits enable row level security;
revoke all on public.otto_waits from public,anon,authenticated;
grant select(id,objective_id,org_id,owner_id,dedupe_key,kind,reason,phase,question,choices,default_choice,connection_url,status,resolution,created_at,deadline_at,reminded_at) on public.otto_waits to authenticated;
grant all on public.otto_waits to service_role;
create policy owner_read on public.otto_waits for select to authenticated using (
 owner_id=auth.uid() and exists(select 1 from public.members m where m.org_id=otto_waits.org_id and m.user_id=auth.uid())
);
