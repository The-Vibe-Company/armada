begin;

create or replace function public.discard_stopped_output_transfers() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 delete from public.sandbox_output_transfers t
 where t.sandbox_id=new.id
   and not exists(select 1 from public.sandbox_outputs o where o.sandbox_id=t.sandbox_id and o.transfer_id=t.id)
   and (new.status='deleted' or not exists(
     select 1 from public.jobs j where j.sandbox_id=t.sandbox_id
       and j.kind='outputs_publish' and j.state in ('queued','leased')
       and j.deadline_at>clock_timestamp() and j.outcome->'transferIds' ? t.id::text
   ));
 update public.runtime_commands set result_enc=null
 where sandbox_id=new.id and starts_with(request_id,'outputs_') and result_enc is not null;
 return new;
end;
$$;

commit;
