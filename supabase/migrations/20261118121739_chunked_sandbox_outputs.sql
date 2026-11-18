-- Reserve the plaintext size once per file revision and persist bounded encrypted chunks.
create table public.sandbox_output_transfers (
 id uuid primary key default gen_random_uuid(),
 sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
 name text not null,
 revision text not null,
 size integer not null check (size between 0 and 33554432),
 received integer not null default 0 check (received between 0 and size),
 scan timestamptz not null,
 progress_at timestamptz not null default now(),
 digest text,
 unique (sandbox_id, name, revision, size),
 unique (sandbox_id, id)
);
create table public.sandbox_output_chunks (
 transfer_id uuid not null references public.sandbox_output_transfers(id) on delete cascade,
 byte_offset integer not null check (byte_offset >= 0 and byte_offset % 32768 = 0),
 content_enc bytea not null check (octet_length(content_enc) between 28 and 43720),
 primary key (transfer_id, byte_offset)
);
alter table public.sandbox_output_transfers enable row level security;
alter table public.sandbox_output_chunks enable row level security;
revoke all on public.sandbox_output_transfers, public.sandbox_output_chunks from public, anon, authenticated;
grant all on public.sandbox_output_transfers, public.sandbox_output_chunks to service_role;

alter table public.sandbox_outputs
 drop constraint sandbox_outputs_size_check,
 alter column size type bigint,
 alter column content_enc drop not null,
 alter column digest drop not null,
 add column skipped text check (skipped in ('too_large','sandbox_limit','org_limit')),
 add column transfer_id uuid,
 add foreign key (sandbox_id, transfer_id) references public.sandbox_output_transfers(sandbox_id, id),
 add check (size between 0 and 9007199254740991),
 add check (
   (skipped is not null and digest is null and content_enc is null and transfer_id is null)
   or (skipped is null and digest is not null and size <= 33554432
       and ((content_enc is null) <> (transfer_id is null)))
 );

create or replace function public.purge_tainted_sandbox_outputs() returns trigger
language plpgsql set search_path='' as $$
begin
 delete from public.sandbox_outputs where sandbox_id=new.id;
 delete from public.sandbox_output_transfers where sandbox_id=new.id;
 -- Retain command identities for ordered runtime acknowledgements, while stripping old reply bytes.
 update public.runtime_commands set result_enc=null
 where sandbox_id=new.id and starts_with(request_id,'outputs_') and result_enc is not null;
 return new;
end;
$$;

create trigger reject_tainted_sandbox_output_transfers before insert or update on public.sandbox_output_transfers
 for each row execute function public.reject_tainted_sandbox_outputs();

-- Runs as definer: members stop sandboxes through RLS but hold no grant on transfer storage.
create function public.discard_stopped_output_transfers() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 delete from public.sandbox_output_transfers t
 where t.sandbox_id=new.id and not exists(select 1 from public.sandbox_outputs o where o.sandbox_id=t.sandbox_id and o.transfer_id=t.id);
 update public.runtime_commands set result_enc=null
 where sandbox_id=new.id and starts_with(request_id,'outputs_') and result_enc is not null;
 return new;
end;
$$;
revoke all on function public.discard_stopped_output_transfers() from public,anon,authenticated;
create trigger discard_stopped_output_transfers after update of status, stopped_at on public.sandboxes
 for each row when ((new.status in ('stopped','deleted') and new.status is distinct from old.status)
   or (new.stopped_at is not null and new.stopped_at is distinct from old.stopped_at))
 execute function public.discard_stopped_output_transfers();

create or replace function public.enqueue_output_webhook() returns trigger
language plpgsql security definer set search_path='' as $$
declare s public.sandboxes; endpoint record; delivery_id uuid;
begin
 if new.skipped is not null then return new; end if;
 if tg_op='UPDATE' and new.digest is not distinct from old.digest then return new; end if;
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
