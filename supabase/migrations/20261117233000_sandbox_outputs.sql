-- Bounded durable output snapshots, accessible only through authenticated server routes.
-- outputs_retained_at: last definitive retained-disk result after a stop (once per stop).
-- Rows that exist when this migration runs start as already read (a metadata-only default, no row
-- rewrite or triggers): stops before outputs existed are never backfilled; later stops are read.
alter table public.sandboxes add column outputs_checked_at timestamptz,
 add column outputs_retained_at timestamptz default now();
alter table public.sandboxes alter column outputs_retained_at drop default;
create table public.sandbox_outputs (
 sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
 name text not null check (length(name) between 1 and 255 and name !~ '[/\\]'),
 digest text not null,
 size integer not null check (size between 0 and 32768),
 content_enc bytea not null,
 updated_at timestamptz not null default now(),
 primary key(sandbox_id,name)
);
alter table public.sandbox_outputs enable row level security;
revoke all on public.sandbox_outputs from public,anon,authenticated;
grant all on public.sandbox_outputs to service_role;
create function public.enqueue_output_webhook() returns trigger
language plpgsql security definer set search_path='' as $$
declare s public.sandboxes; endpoint record; delivery_id uuid;
begin
 if tg_op='UPDATE' and new.digest=old.digest then return new; end if;
 select * into s from public.sandboxes where id=new.sandbox_id;
 for endpoint in select id from public.outbound_webhook_endpoints where org_id=s.org_id and enabled loop
  delivery_id := gen_random_uuid();
  insert into public.outbound_webhook_deliveries(id,endpoint_id,payload)
  values(delivery_id,endpoint.id,jsonb_build_object('id',delivery_id,'type','sandbox.output.available',
   'occurredAt',clock_timestamp(),'orgId',s.org_id,'sandboxId',s.id,'externalRef',s.external_ref,
   'state',s.status,'output',jsonb_build_object('name',new.name,'size',new.size,'sha256',new.digest)));
 end loop;
 return new;
end;
$$;
revoke all on function public.enqueue_output_webhook() from public,anon,authenticated;
create trigger output_webhook after insert or update on public.sandbox_outputs
 for each row execute function public.enqueue_output_webhook();

-- Application-secret taint forbids file egress: purge snapshots once tainted and
-- reject late writes from a collector that started before the taint committed.
create function public.purge_tainted_sandbox_outputs() returns trigger
language plpgsql set search_path='' as $$
begin
 delete from public.sandbox_outputs where sandbox_id=new.id;
 return new;
end;
$$;
revoke all on function public.purge_tainted_sandbox_outputs() from public,anon,authenticated;
create trigger purge_tainted_sandbox_outputs after update of application_secret_tainted on public.sandboxes
 for each row when (new.application_secret_tainted) execute function public.purge_tainted_sandbox_outputs();
create function public.reject_tainted_sandbox_outputs() returns trigger
language plpgsql set search_path='' as $$
begin
 perform 1 from public.sandboxes where id=new.sandbox_id and not application_secret_tainted for share;
 if not found then raise exception 'Sandbox outputs unavailable'; end if;
 return new;
end;
$$;
revoke all on function public.reject_tainted_sandbox_outputs() from public,anon,authenticated;
create trigger reject_tainted_sandbox_outputs before insert or update on public.sandbox_outputs
 for each row execute function public.reject_tainted_sandbox_outputs();

